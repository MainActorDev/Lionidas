/** QA test templates: recorded manual flows stored as replayable configs.
 *  CRUD + save-from-session (copies recording steps out of a manual session).
 *  Templates are plain data — playback (2d) interprets steps_json against a device. */
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { crucibleAlloy } from '../alloy/client.ts';
import { initAlloyRuntime } from '../alloy/runtime.ts';
import { parseCaseYaml, caseToYaml } from '@crucible/shared/case-yaml';

interface TemplateRow {
  id: string;
  name: string;
  description: string | null;
  ticket_key: string | null;
  udid: string;
  logical_w: number | null;
  logical_h: number | null;
  steps_json: string;
  default_preset_id: string | null;
  app_bundle_id: string | null;
  app_name: string | null;
  app_version: string | null;
  tags_json: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}

function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try { const v = JSON.parse(raw) as unknown; return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []; } catch { return []; }
}

/** Shared template selection (A2): comma-list tags with AND semantics +
 *  optional app bundle filter. Used by the list route and play-all — one
 *  definition of "which templates match a regression selection". */
export function selectTemplates(rows: TemplateRow[], filter: { tags?: string | undefined; app?: string | undefined }): TemplateRow[] {
  const wantTags = (filter.tags ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  return rows.filter((r) => {
    if (filter.app && r.app_bundle_id !== filter.app) return false;
    if (wantTags.length === 0) return true;
    const have = parseTags(r.tags_json);
    return wantTags.every((t) => have.includes(t));
  });
}

function rowToTemplate(r: TemplateRow): Record<string, unknown> {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    ticketKey: r.ticket_key,
    udid: r.udid,
    logicalW: r.logical_w,
    logicalH: r.logical_h,
    steps: JSON.parse(r.steps_json) as unknown[],
    defaultPresetId: r.default_preset_id,
    appBundleId: r.app_bundle_id,
    appName: r.app_name,
    appVersion: r.app_version,
    tags: parseTags(r.tags_json),
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** validate + normalize incoming tags: strings, trimmed, non-empty, deduped,
 *  capped at 8 (chip soup guard). Returns null when the input is absent. */
function normalizeTags(input: unknown): string[] | null {
  if (input === undefined || input === null) return null;
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  for (const t of input) {
    if (typeof t !== 'string') continue;
    const v = t.trim();
    if (v) seen.add(v);
    if (seen.size >= 8) break;
  }
  return [...seen];
}

function tagsToJson(input: unknown): string | null {
  const tags = normalizeTags(input);
  return tags === null ? null : JSON.stringify(tags);
}

export function registerTemplateRoutes(app: FastifyInstance, db: Database.Database, dispatchDeps?: unknown): void {
  app.get('/api/templates', async (req) => {
    const q = req.query as { ticket?: string; tags?: string; app?: string };
    let rows: TemplateRow[];
    if (q.ticket) rows = db.prepare('SELECT * FROM templates WHERE ticket_key = ? ORDER BY updated_at DESC').all(q.ticket) as TemplateRow[];
    else rows = db.prepare('SELECT * FROM templates ORDER BY updated_at DESC').all() as TemplateRow[];
    const sel = selectTemplates(rows, { tags: q.tags, app: q.app }).map(rowToTemplate) as Array<Record<string, unknown> & { id: string }>;
    // B4: attach last-verdict + trend per case (absent = never run)
    const { suiteVerdicts } = await import('../db/suite.ts');
    const verdicts = suiteVerdicts(db);
    for (const t of sel) {
      const v = verdicts.get(t.id);
      t.verdict = v ? {
        lastRunId: v.lastRunId, lastStatus: v.lastStatus, lastBlocked: v.lastBlocked,
        lastFinishedAt: v.lastFinishedAt, lastAppVersion: v.lastAppVersion,
        trend: v.trend, totalRuns: v.totalRuns,
      } : null;
    }
    return { templates: sel };
  });

  app.get('/api/templates/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as TemplateRow | undefined;
    if (!row) return reply.code(404).send({ error: 'not found' });
    return rowToTemplate(row);
  });

  /** Save current recording as a template (sidebar "save as template"). */
  app.post('/api/templates/from-session/:sessionId', async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    const b = req.body as { name?: string; description?: string; ticketKey?: string; createdBy?: string; tags?: string[] };
    if (!b.name || !b.name.trim()) return reply.code(400).send({ error: 'name required' });
    const sess = db
      .prepare('SELECT s.recording_json, s.udid, s.logical_w, s.logical_h, s.operator FROM manual_sessions s WHERE s.id = ?')
      .get(sessionId) as { recording_json: string | null; udid: string; logical_w: number | null; logical_h: number | null; operator: string } | undefined;
    if (!sess) return reply.code(404).send({ error: 'session not found' });
    let steps: unknown[] = [];
    if (sess.recording_json) {
      try { steps = (JSON.parse(sess.recording_json) as { steps?: unknown[] }).steps ?? []; } catch { /* empty */ }
    }
    if (steps.length === 0) return reply.code(400).send({ error: 'no recorded steps in session' });
    // app binding: snapshot ground truth — the accessibility root names the
    // foreground app (works for Apple apps like Settings, which launchctl
    // guesses miss). Falls back to explicit body, then null.
    let appBundleId = (b as { appBundleId?: string }).appBundleId ?? null;
    let appName: string | null = null;
    let appVersion: string | null = null;
    if (!appBundleId) {
      try {
        const { foregroundAppFromSnapshot } = await import('../manual/apps.ts');
        const fg = await foregroundAppFromSnapshot(
          { dispatch: (tool, input, dd) => crucibleAlloy().dispatch(tool, input, dd) },
          dispatchDeps ?? (await initAlloyRuntime()).deps,
          sess.udid,
        );
        if (fg) { appBundleId = fg.bundleId; appName = fg.name; appVersion = fg.version; }
      } catch { /* app binding best-effort — template still saves */ }
    } else {
      try {
        const { listSimulatorApps } = await import('../manual/apps.ts');
        const found = (await listSimulatorApps(sess.udid)).find((a) => a.bundleId === appBundleId);
        if (found) { appName = found.name; appVersion = found.version; }
      } catch { /* enrich best-effort */ }
    }
    const id = `tpl_${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    db.prepare(
      `INSERT INTO templates(id, name, description, ticket_key, udid, logical_w, logical_h, steps_json, app_bundle_id, app_name, app_version, tags_json, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, b.name.trim(), b.description ?? null, b.ticketKey ?? null, sess.udid, sess.logical_w, sess.logical_h, JSON.stringify(steps), appBundleId, appName, appVersion, tagsToJson(b.tags), b.createdBy ?? sess.operator, now, now);
    const row = db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as TemplateRow;
    return rowToTemplate(row);
  });

  app.post('/api/templates', async (req, reply) => {
    const b = req.body as Partial<TemplateRow> & { steps?: unknown[]; tags?: string[]; appBundleId?: string; ticketKey?: string | null };
    if (!b.name || !b.name.trim()) return reply.code(400).send({ error: 'name required' });
    const id = `tpl_${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    db.prepare(
      `INSERT INTO templates(id, name, description, ticket_key, udid, logical_w, logical_h, steps_json, app_bundle_id, app_name, app_version, tags_json, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, b.name.trim(), b.description ?? null, b.ticket_key ?? b.ticketKey ?? null, b.udid ?? '', b.logical_w ?? null, b.logical_h ?? null, JSON.stringify(b.steps ?? []), b.appBundleId ?? null, b.app_name ?? null, b.app_version ?? null, tagsToJson(b.tags), b.created_by ?? 'qa', now, now);
    return rowToTemplate(db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as TemplateRow);
  });

  app.patch('/api/templates/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as { name?: string; description?: string | null; ticketKey?: string | null; defaultPresetId?: string | null; steps?: unknown[]; tags?: string[]; appBundleId?: string | null };
    const row = db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as TemplateRow | undefined;
    if (!row) return reply.code(404).send({ error: 'not found' });
    if (b.name !== undefined && !b.name.trim()) return reply.code(400).send({ error: 'name cannot be empty' });
    db.prepare(
      `UPDATE templates SET
         name = ?, description = ?, ticket_key = ?, default_preset_id = ?, steps_json = ?, tags_json = ?, app_bundle_id = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      b.name !== undefined ? b.name.trim() : row.name,
      b.description !== undefined ? b.description : row.description,
      b.ticketKey !== undefined ? b.ticketKey : row.ticket_key,
      b.defaultPresetId !== undefined ? b.defaultPresetId : row.default_preset_id,
      b.steps !== undefined ? JSON.stringify(b.steps) : row.steps_json,
      b.tags !== undefined ? tagsToJson(b.tags) : row.tags_json,
      b.appBundleId !== undefined ? b.appBundleId : row.app_bundle_id,
      Date.now(),
      id,
    );
    return rowToTemplate(db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as TemplateRow);
  });

  app.delete('/api/templates/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = db.prepare('DELETE FROM templates WHERE id = ?').run(id);
    if (r.changes === 0) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });

  // ── YAML authoring (the ONE format definition lives in web/src/shared/
  // case-yaml.ts — pure module, imported by both toolchains). ──

  /** validate: pure — parse + schema + env-shape checks. The SAME validator
   *  backs the split panel's live outline and PUT /yaml, so preview and save
   *  can never disagree. */
  /** Vocabulary for the YAML editor's autocomplete: every distinct selector
   *  (label + identifier) ever recorded with usage counts and source cases,
   *  plus case names (runFlow targets), bundle ids, tags. One fetch per
   *  editor open; pure aggregation, no device contact. */
  app.get('/api/templates/vocabulary', async () => {
    const rows = db.prepare('SELECT name, steps_json, app_bundle_id, tags_json FROM templates').all() as
      Array<{ name: string; steps_json: string; app_bundle_id: string | null; tags_json: string | null }>;
    const selMap = new Map<string, { value: string; kind: 'label' | 'identifier'; uses: number; cases: Set<string> }>();
    const caseNames: string[] = [];
    const apps = new Set<string>();
    const tags = new Set<string>();
    for (const r of rows) {
      caseNames.push(r.name);
      if (r.app_bundle_id) apps.add(r.app_bundle_id);
      for (const t of JSON.parse(r.tags_json ?? '[]') as unknown[]) {
        if (typeof t === 'string' && t.trim()) tags.add(t.trim());
      }
      try {
        for (const s of JSON.parse(r.steps_json) as Array<Record<string, unknown>>) {
          const sel = s['selector'] as { label?: unknown; identifier?: unknown } | undefined;
          for (const kind of ['label', 'identifier'] as const) {
            const v = sel?.[kind];
            if (typeof v === 'string' && v.trim()) {
              const key = `${kind}:${v}`;
              const e = selMap.get(key) ?? { value: v, kind, uses: 0, cases: new Set<string>() };
              e.uses += 1;
              e.cases.add(r.name);
              selMap.set(key, e);
            }
          }
        }
      } catch { /* malformed steps_json — skip the row's selectors, keep its name */ }
    }
    return {
      selectors: [...selMap.values()]
        .sort((a, b) => b.uses - a.uses || a.value.localeCompare(b.value))
        .map((e) => ({ value: e.value, kind: e.kind, uses: e.uses, cases: [...e.cases] })),
      caseNames,
      apps: [...apps],
      tags: [...tags],
    };
  });

  app.post('/api/templates/yaml/validate', async (req) => {
    const b = req.body as { yaml?: string };
    const r = parseCaseYaml(b.yaml ?? '');
    return { ok: r.ok, errors: r.errors, case: r.case, runFlowNames: r.runFlowNames };
  });

  /** GET the case as YAML (editor load) — name resolution for runFlow:
   *  template ids are tpl_8hex (human-hostile), so steps referencing other
   *  cases serialize with the referenced case's NAME; the id rides in a
   *  comment-free {name:} field and resolves on save. */
  app.get('/api/templates/:id/yaml', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as TemplateRow | undefined;
    if (!row) return reply.code(404).send({ error: 'not found' });
    const steps = JSON.parse(row.steps_json) as Array<Record<string, unknown>>;
    // resolve templateId → name for runFlow display
    const id2name = new Map<string, string>();
    for (const s of steps) {
      if (s['action'] === 'runFlow' && typeof s['templateId'] === 'string') {
        const child = db.prepare('SELECT name FROM templates WHERE id = ?').get(s['templateId'] as string) as { name: string } | undefined;
        if (child) id2name.set(s['templateId'] as string, child.name);
      }
    }
    const yaml = caseToYaml({
      name: row.name,
      tags: (JSON.parse(row.tags_json ?? '[]') as string[]),
      steps: steps.map((s) => (s['action'] === 'runFlow' && id2name.has(s['templateId'] as string)
        ? { ...s, templateId: id2name.get(s['templateId'] as string) }
        : s)),
      ...(row.app_bundle_id ? { app: row.app_bundle_id } : {}),
    });
    return { yaml, logicalW: row.logical_w, logicalH: row.logical_h };
  });

  /** PUT yaml: validate → resolve runFlow names → persist steps_json + name/
   *  tags/app. 422 carries line numbers; 409 names unresolved/colliding
   *  subflows. What the panel validated before saving is EXACTLY what this
   *  enforces — one validator, no drift. */
  app.put('/api/templates/:id/yaml', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as TemplateRow | undefined;
    if (!row) return reply.code(404).send({ error: 'not found' });
    const b = req.body as { yaml?: string };
    const r = parseCaseYaml(b.yaml ?? '');
    if (!r.ok || !r.case) return reply.code(422).send({ errors: r.errors });
    // resolve runFlow names → ids. templates.name is UNIQUE (schema), so a
    // name resolves to exactly one case or none — ambiguity is impossible.
    for (const s of r.case.steps) {
      if (s.action !== 'runFlow') continue;
      const ref = s.templateId ?? '';
      if (/^tpl_[0-9a-f]+$/.test(ref)) continue; // already an id
      const child = db.prepare('SELECT id FROM templates WHERE name = ?').get(ref) as { id: string } | undefined;
      if (!child) return reply.code(409).send({ errors: [{ line: 1, message: `runFlow: no case named "${ref}"` }] });
      s.templateId = child.id;
    }
    // the yaml may also RENAME this case — same UNIQUE constraint applies
    if (r.case.name !== row.name) {
      const clash = db.prepare('SELECT id FROM templates WHERE name = ? AND id != ?').get(r.case.name, id);
      if (clash) return reply.code(409).send({ errors: [{ line: 1, message: `a case named "${r.case.name}" already exists` }] });
    }
    db.prepare(
      `UPDATE templates SET name = ?, steps_json = ?, tags_json = ?, app_bundle_id = COALESCE(?, app_bundle_id), updated_at = ? WHERE id = ?`,
    ).run(r.case.name, JSON.stringify(r.case.steps), tagsToJson(r.case.tags), r.case.app ?? null, Date.now(), id);
    return rowToTemplate(db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as TemplateRow);
  });
}
