/** QA test templates: recorded manual flows stored as replayable configs.
 *  CRUD + save-from-session (copies recording steps out of a manual session).
 *  Templates are plain data — playback (2d) interprets steps_json against a device. */
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { randomUUID, createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { crucibleAlloy } from '../alloy/client.ts';
import { initAlloyRuntime } from '../alloy/runtime.ts';
import { parseCaseYaml, caseToYaml } from '@crucible/shared/case-yaml';
import { VARIANT_ID_RE as VARIANT_ID_RE_LOCAL, variantScenarioNames } from '@crucible/shared/yaml-variants';
import { zipSync, unzipSync } from 'fflate';
import { requireRole, requireRoleAtLeast } from '../auth/roles.ts';
import { capabilitiesFor } from '../auth/capabilities.ts';
import type { Role } from '../auth/users.ts';
import { tapsForRun } from '../evidence/taps-store.ts';

interface TemplateRow {
  id: string;
  name: string;
  description: string | null;
  variants_json: string | null;
  entry_json: string | null;
  ticket_key: string | null;
  udid: string;
  logical_w: number | null;
  logical_h: number | null;
  steps_json: string;
  setup_json: string | null;
  alerts_policy: string | null;
  default_preset_id: string | null;
  app_bundle_id: string | null;
  app_name: string | null;
  app_version: string | null;
  tags_json: string | null;
  status: string | null;
  folder_id: string | null;
  created_by: string;
  updated_by?: string | null;
  created_at: number;
  updated_at: number;
}

function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try { const v = JSON.parse(raw) as unknown; return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []; } catch { return []; }
}

/** Shared template selection (A2): comma-list tags with AND semantics +
 *  optional app bundle filter. Used by the list route and play-all — one
 *  definition of "which templates match a regression selection".
 *  Phase E: TWO orthogonal status knobs — `status` is an exact match (chips),
 *  `excludeDeprecated` is the batch-safety flag (play-all/plans pass true;
 *  the list route never does — chips' "all" must show deprecated rows). */
export function selectTemplates(rows: TemplateRow[], filter: { tags?: string | undefined; app?: string | undefined; status?: 'draft' | 'active' | 'deprecated'; excludeDeprecated?: boolean }): TemplateRow[] {
  const wantTags = (filter.tags ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  return rows.filter((r) => {
    if (filter.app && r.app_bundle_id !== filter.app) return false;
    const st = r.status ?? 'active'; // legacy NULL reads active
    if (filter.status !== undefined && st !== filter.status) return false;
    if (filter.excludeDeprecated === true && st === 'deprecated') return false;
    if (wantTags.length === 0) return true;
    const have = parseTags(r.tags_json);
    return wantTags.every((t) => have.includes(t));
  });
}

function rowToTemplate(db: Database.Database, r: TemplateRow): Record<string, unknown> {
  return {
    id: r.id,
    name: r.name,
    status: r.status ?? 'active', // legacy NULL rows read active (phase E)
    description: r.description,
    ticketKey: r.ticket_key,
    udid: r.udid,
    logicalW: r.logical_w,
    logicalH: r.logical_h,
    steps: JSON.parse(r.steps_json) as unknown[],
    ...(r.variants_json ? { variants: (JSON.parse(r.variants_json) as Array<{ id: string }>).map((v) => v.id) } : {}),
    ...(r.setup_json ? { setup: JSON.parse(r.setup_json) as unknown[] } : {}),
    ...(r.alerts_policy ? { alerts: JSON.parse(r.alerts_policy) as unknown } : {}),
    defaultPresetId: r.default_preset_id,
    appBundleId: r.app_bundle_id,
    appName: r.app_name,
    appVersion: (db.prepare(
      // ALWAYS the last runner context: the newest run of this template
      // observed the INSTALLED app version — fresher than any value frozen
      // at record/create time. Falls back to the recorded value when the
      // case has never been played.
      'SELECT app_version FROM runs WHERE template_id = ? AND app_version IS NOT NULL ORDER BY started_at DESC LIMIT 1',
    ).get(r.id) as { app_version: string } | undefined)?.app_version ?? r.app_version,
    tags: parseTags(r.tags_json),
    createdBy: r.created_by,
    updatedBy: r.updated_by ?? null,
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

/** Tier 2.2 — ONE selector for "which run's evidence are we serving":
 *  the newest FINISHED run of the template. Video route, taps route, and
 *  gallery all call this — they can never disagree.
 *  Variants: `variant` scopes the pick to ONE lane — a real variant id
 *  selects that lane's newest finished run; '' (empty query value) selects
 *  the VARIANTLESS lane; undefined leaves it unscoped (legacy
 *  latest-overall default, unchanged behavior). */
function latestFinishedRun(db: Database.Database, templateId: string, variant?: string): { id: string } | undefined {
  if (variant === undefined) {
    return db.prepare(
      `SELECT id FROM runs WHERE template_id = ? AND finished_at IS NOT NULL ORDER BY started_at DESC LIMIT 1`,
    ).get(templateId) as { id: string } | undefined;
  }
  return db.prepare(
    `SELECT id FROM runs WHERE template_id = ? AND finished_at IS NOT NULL AND variant_id IS ? ORDER BY started_at DESC LIMIT 1`,
  ).get(templateId, variant === '' ? null : variant) as { id: string } | undefined;
}


/** Split a multi-document case yaml into individual documents (plan 20260927T164000Z).
 *  `---` at column 0 starts a new document; a leading document before any
 *  marker is the first case. Blank/whitespace-only documents are dropped. */
function splitCaseDocuments(text: string): string[] {
  return text.split(/^---\s*$/m).map((d) => d.trim()).filter((d) => d.length > 0);
}

/** slug for export filenames: lowercase, [a-z0-9-], runs → '-' (plan 20260927T164000Z). */
function caseSlug(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s.length > 0 ? s : 'case';
}

/** Render a template row to its canonical case yaml (shared by GET /:id/yaml
 *  and the batch export — one emitter, no drift; plan 20260927T164000Z). */
function folderPathStr(db: Database.Database, folderId: string | null): string | null {
  if (!folderId) return null;
  const parts: string[] = [];
  let cur = db.prepare('SELECT id, name, parent_id FROM folders WHERE id = ?').get(folderId) as { id: string; name: string; parent_id: string | null } | undefined;
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) { seen.add(cur.id); parts.unshift(cur.name); cur = cur.parent_id ? db.prepare('SELECT id, name, parent_id FROM folders WHERE id = ?').get(cur.parent_id) as typeof cur | undefined : undefined; }
  return parts.length > 0 ? parts.join('/') : null;
}

export function renderTemplateYaml(db: Database.Database, row: TemplateRow): string {
    const steps = JSON.parse(row.steps_json) as Array<Record<string, unknown>>;
    // resolve templateId → name for runFlow display
    const id2name = new Map<string, string>();
    for (const s of steps) {
      if (s['action'] === 'runFlow' && typeof s['templateId'] === 'string') {
        const child = db.prepare('SELECT name FROM templates WHERE id = ?').get(s['templateId'] as string) as { name: string } | undefined;
        if (child) id2name.set(s['templateId'] as string, child.name);
      }
    }
    const setup = row.setup_json ? JSON.parse(row.setup_json) as Array<Record<string, unknown>> : undefined;
    const withNames = (arr: Array<Record<string, unknown>>) => arr.map((s) => (s['action'] === 'runFlow' && id2name.has(s['templateId'] as string)
      ? { ...s, templateId: id2name.get(s['templateId'] as string) }
      : s));
    const alerts = row.alerts_policy ? JSON.parse(row.alerts_policy) as unknown : undefined;
    const variants = row.variants_json ? JSON.parse(row.variants_json) as unknown[] : undefined;
    // R2: entry facet round-trips from entry_json (guarded column)
    const entryFacet = (() => {
      try {
        const e = (db.prepare('SELECT entry_json FROM templates WHERE id = ?').get(row.id) as { entry_json: string | null } | undefined)?.entry_json;
        return e ? JSON.parse(e) as { screen: string; mode?: 'tab' | 'deepLink' | 'navigate' } : null;
      } catch { return null; }
    })();
    // vocabulary: a case whose steps use swap: verbs is authored in the
    // swaps: dialect — emit it back that way (storage is one array; the
    // exporter keys off which property it receives)
    const asSwaps = steps.some((s) => s['action'] === 'swap');
  return caseToYaml({
    name: row.name,
    folder: folderPathStr(db, row.folder_id),
    tags: (JSON.parse(row.tags_json ?? '[]') as string[]),
    steps: withNames(steps),
    ...(alerts ? { alerts } : {}),
    ...(variants && variants.length > 0 ? (asSwaps ? { swaps: variants } : { variants }) : {}),
    ...(setup && setup.length > 0 ? { setup: withNames(setup) } : {}),
    ...(row.app_bundle_id ? { app: row.app_bundle_id } : {}),
    ...(entryFacet ? { entry: entryFacet } : {}),
  });
}

/** Resolve a parsed case's DB references at the full SAVE bar (review F1):
 *  runFlow names → ids; variant scenario names must exist and a variant's
 *  scenario set must not fake the same endpoint twice; swap steps must
 *  reference declared swaps/variants; screen refs (arrive/refresh/
 *  expectScreen/entry) must exist in the app's registry and expectScreen
 *  states must be declared. Shared by PUT /:id/yaml and the import route —
 *  one bar, no drift. Returns an error message naming the problem, or null
 *  when clean. MUTATES steps in place (runFlow name → id). */
export function resolveCaseRefs(db: Database.Database, c: { name: string; app?: string | null; setup?: unknown[]; steps: unknown[]; variants?: unknown[]; swaps?: unknown[]; worlds?: unknown[]; entry?: { screen: string } | null }, fallbackApp: string | null): string | null {
  const allSteps = [...(c.setup ?? []), ...c.steps] as Array<Record<string, unknown>>;
  for (const s of allSteps) {
    if (s['action'] !== 'runFlow') continue;
    const ref = s['templateId'] ?? '';
    if (typeof ref === 'string' && /^tpl_[0-9a-f]+$/.test(ref)) continue;
    const child = db.prepare('SELECT id FROM templates WHERE name = ?').get(ref) as { id: string } | undefined;
    if (!child) return `runFlow: no case named "${ref}"`;
    s['templateId'] = child.id;
  }
  if (c.variants) {
    for (const v of c.variants as Array<Record<string, unknown>>) {
      const names = variantScenarioNames(v as never);
      if (names.length === 0) continue;
      for (const n of names) {
        const known = db.prepare('SELECT 1 FROM scenarios WHERE name = ? OR id = ?').get(n, n);
        if (!known) return `variant "${v['id']}": unknown scenario "${n}"`;
      }
      const ph = names.map(() => '?').join(',');
      const rows = db.prepare(
        `SELECT p.method, p.path_pattern, so.scenario_id FROM presets p
         JOIN scenario_overrides so ON so.preset_id = p.id
         JOIN scenarios s ON s.id = so.scenario_id
         WHERE (s.name IN (${ph}) OR s.id IN (${ph})) AND so.enabled = 1`,
      ).all(...names, ...names) as Array<{ method: string; path_pattern: string; scenario_id: string }>;
      const byEndpoint = new Map<string, string[]>();
      for (const row of rows) {
        const key = `${row.method} ${row.path_pattern}`;
        byEndpoint.set(key, [...(byEndpoint.get(key) ?? []), row.scenario_id]);
      }
      for (const [key, ids] of byEndpoint) {
        const distinct = [...new Set(ids)];
        if (distinct.length > 1) {
          const namesBoth = distinct.map((sid) => (db.prepare('SELECT name FROM scenarios WHERE id = ?').get(sid) as { name: string }).name);
          return `variant "${v['id']}": scenarios ${namesBoth.map((x) => `"${x}"`).join(' + ')} both fake \`${key}\` — a set may fake an endpoint once`;
        }
      }
    }
  }
  const declaredSwaps = new Set([...(c.swaps ?? c.worlds ?? []).map((w) => (w as Record<string, unknown>)['id']), ...(c.variants ?? []).map((v) => (v as Record<string, unknown>)['id'])]);
  for (const s of allSteps) {
    if (s['action'] === 'swap' && !declaredSwaps.has(s['swap'])) {
      return `swap step references "${s['swap']}" — not declared in this case's swaps/variants`;
    }
  }
  const screenRefs = new Set<string>();
  for (const s of allSteps) {
    if (s['action'] === 'arrive' || s['action'] === 'refresh') screenRefs.add(s['screen'] as string);
    if (s['action'] === 'expectScreen') screenRefs.add((s['expectScreen'] as Record<string, unknown>)['screen'] as string);
  }
  if (c.entry) screenRefs.add(c.entry.screen);
  const appBundleForScreens = c.app ?? fallbackApp ?? null;
  if (screenRefs.size > 0) {
    if (!appBundleForScreens) return 'screen steps need an app (app: <bundle>) to resolve the registry';
    const known = new Set((db.prepare('SELECT screen_id FROM app_screens WHERE app_bundle_id = ?').all(appBundleForScreens) as Array<{ screen_id: string }>).map((x) => x.screen_id));
    for (const ref of screenRefs) {
      if (!known.has(ref)) return `unknown screen "${ref}" — declare it in the app registry (/api/apps/${appBundleForScreens}/screens)`;
    }
    for (const s of allSteps) {
      if (s['action'] !== 'expectScreen') continue;
      const rowScr = db.prepare('SELECT states_json FROM app_screens WHERE app_bundle_id = ? AND screen_id = ?').get(appBundleForScreens, (s['expectScreen'] as Record<string, unknown>)['screen']) as { states_json: string } | undefined;
      const states = rowScr ? (JSON.parse(rowScr.states_json) as Record<string, unknown>) : {};
      const st = (s['expectScreen'] as Record<string, unknown>)['state'] as string;
      if (!(st in states)) return `screen "${(s['expectScreen'] as Record<string, unknown>)['screen']}" has no state "${st}" — declared: ${Object.keys(states).join(', ') || 'none'}`;
    }
  }
  return null;
}

export function registerTemplateRoutes(app: FastifyInstance, db: Database.Database, dispatchDeps?: unknown): void {
  // RBAC T4 (plan 20261009T102032Z): case assignment — supervisor assigns
  // anyone; operator self-assigns; viewer cannot (gated). Nullable user FK.
  app.patch('/api/templates/:id/assign', { preHandler: requireRoleAtLeast('operator') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as { userId: string | null } | null;
    const caps = capabilitiesFor((req.user?.role ?? 'viewer') as Role);
    if (!caps.authorCases) return reply.code(403).send({ error: 'viewers cannot assign cases' });
    if (b?.userId !== null && b?.userId !== undefined) {
      const u = db.prepare('SELECT id, role FROM users WHERE id = ? AND active = 1').get(b.userId) as { id: string; role: string } | undefined;
      if (!u) return reply.code(404).send({ error: 'user not found' });
      // operator self-assign only (matrix: assignment of OTHERS is supervisor+)
      if (b.userId !== req.user?.id && !caps.manageAccounts) return reply.code(403).send({ error: 'assigning others requires supervisor' });
    }
    db.prepare('UPDATE templates SET assigned_to = ? WHERE id = ?').run(b?.userId ?? null, id);
    return { ok: true, assignedTo: b?.userId ?? null };
  });

  app.get('/api/templates', async (req) => {
    const q = req.query as { ticket?: string; tags?: string; app?: string; status?: string };
    let rows: TemplateRow[];
    if (q.ticket) rows = db.prepare('SELECT * FROM templates WHERE ticket_key = ? ORDER BY updated_at DESC').all(q.ticket) as TemplateRow[];
    else rows = db.prepare('SELECT * FROM templates ORDER BY updated_at DESC').all() as TemplateRow[];
    // Phase E: chips are exact-match; the LIST never excludes deprecated
    // ("all" shows everything) — batch exclusion is play-all's own knob.
    const sel = selectTemplates(rows, { tags: q.tags, app: q.app, ...(q.status === 'draft' || q.status === 'active' || q.status === 'deprecated' ? { status: q.status } : {}) }).map((r) => rowToTemplate(db, r)) as Array<Record<string, unknown> & { id: string }>;
    // B4: attach last-verdict + trend per case (absent = never run)
    const { suiteVerdicts } = await import('../db/suite.ts');
    const verdicts = suiteVerdicts(db);
    // evidence flags per case: does the newest finished run carry screenshot/video
    const evFlags = new Map<string, { screenshot: boolean; video: boolean }>();
    for (const r of db.prepare(
      `SELECT r.template_id AS tid, r.id AS rid FROM runs r
       JOIN (SELECT template_id, MAX(started_at) AS ms FROM runs WHERE template_id IS NOT NULL AND finished_at IS NOT NULL GROUP BY template_id) m
         ON m.template_id = r.template_id AND m.ms = r.started_at`,
    ).all() as Array<{ tid: string; rid: string }>) {
      const types = new Set((db.prepare('SELECT type FROM evidence WHERE bundle_id = ?').all(r.rid) as Array<{ type: string }>).map((x) => x.type));
      evFlags.set(r.tid, { screenshot: types.has('screenshot'), video: types.has('video') });
    }
    for (const t of sel) {
      const v = verdicts.get(t.id);
      t.verdict = v ? {
        lastRunId: v.lastRunId, lastStatus: v.lastStatus, lastBlocked: v.lastBlocked,
        lastFinishedAt: v.lastFinishedAt, lastAppVersion: v.lastAppVersion,
        trend: v.trend, totalRuns: v.totalRuns,
      } : null;
      t.evidence = evFlags.get(t.id) ?? { screenshot: false, video: false };
      // selector coverage: interactive steps that carry a selector survive
      // layout changes (live AX confirmation); bare coordinates are the
      // fragile tail. Expects are selector-only by construction — count as
      // locked. Scroll/type/tap are interactive; location is host-level.
      const steps = (t['steps'] as Array<Record<string, unknown>>) ?? [];
      const interactive = steps.filter((s) => ['tap', 'type'].includes(String(s['action'])));
      const locked = interactive.filter((s) => {
        const sel2 = s['selector'] as { identifier?: unknown; label?: unknown } | undefined;
        return !!sel2 && (sel2.identifier !== undefined || sel2.label !== undefined);
      });
      const expects = steps.filter((s) => s['action'] === 'expect');
      t.selectorCoverage = {
        locked: locked.length + expects.length,
        total: interactive.length + expects.length,
      };
    }
    return { templates: sel };
  });

  app.get('/api/templates/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as TemplateRow | undefined;
    if (!row) return reply.code(404).send({ error: 'not found' });
    return rowToTemplate(db, row);
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
    return rowToTemplate(db, row);
  });

  app.post('/api/templates', async (req, reply) => {
    const b = req.body as Partial<TemplateRow> & { steps?: unknown[]; tags?: string[]; appBundleId?: string; ticketKey?: string | null };
    if (!b.name || !b.name.trim()) return reply.code(400).send({ error: 'name required' });
    const id = `tpl_${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    db.prepare(
      `INSERT INTO templates(id, name, description, ticket_key, udid, logical_w, logical_h, steps_json, app_bundle_id, app_name, app_version, tags_json, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, b.name.trim(), b.description ?? null, b.ticket_key ?? b.ticketKey ?? null, b.udid ?? '', b.logical_w ?? null, b.logical_h ?? null, JSON.stringify(b.steps ?? []), b.appBundleId ?? null, b.app_name ?? null, b.app_version ?? null, tagsToJson(b.tags), req.user?.name ?? b.created_by ?? 'unknown', now, now);
    return rowToTemplate(db, db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as TemplateRow);
  });


  // ── duplicate: full copy, fresh id, draft status, jump-ready (plan 20260927T164000Z) ──
  app.post('/api/templates/:id/duplicate', { preHandler: requireRole('operator') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as TemplateRow | undefined;
    if (!row) return reply.code(404).send({ error: 'not found' });
    const now = Date.now();
    // collision-free name inside ONE transaction: the UNIQUE constraint +
    // first-free suffix loop make the race unobservable (operator decision:
    // "no name collision" may ever surface)
    const newId = `tpl_${randomUUID().slice(0, 8)}`;
    const tx = db.transaction(() => {
      let name = `${row.name} (copy)`;
      let n = 2;
      while (db.prepare('SELECT 1 FROM templates WHERE name = ?').get(name)) {
        name = `${row.name} (copy ${n})`; n += 1;
      }
      db.prepare(
        `INSERT INTO templates(id, name, description, ticket_key, udid, logical_w, logical_h, steps_json, app_bundle_id, app_name, app_version, tags_json, setup_json, alerts_policy, variants_json, entry_json, default_preset_id, status, folder_id, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
      ).run(newId, name, row.description, row.ticket_key, row.udid, row.logical_w, row.logical_h, row.steps_json, row.app_bundle_id, row.app_name, row.app_version, row.tags_json, row.setup_json, row.alerts_policy, row.variants_json, row.entry_json, row.default_preset_id, row.folder_id, req.user?.name ?? 'unknown', now, now);
      return name;
    });
    const name = tx() as string;
    return reply.code(201).send({ ...rowToTemplate(db, db.prepare('SELECT * FROM templates WHERE id = ?').get(newId) as TemplateRow), name });
  });

  // ── import: .yaml (single/multi-doc) or export-zip (JSON base64 transport, review F2) ──
  app.post('/api/templates/import', { preHandler: requireRole('operator') }, async (req, reply) => {
    const b = req.body as { yaml?: string; filename?: string; zipBase64?: string };
    let docs: Array<{ label: string; text: string }> = [];
    if (typeof b.yaml === 'string' && b.yaml.trim()) {
      docs = splitCaseDocuments(b.yaml).map((t, i) => ({ label: `document ${i + 1}`, text: t }));
    } else if (typeof b.zipBase64 === 'string' && b.zipBase64) {
      try {
        const entries = unzipSync(Buffer.from(b.zipBase64, 'base64'));
        const yamlEntries = Object.keys(entries).filter((k) => k.endsWith('.yaml')).sort();
        if (yamlEntries.length === 0) return reply.code(422).send({ error: 'zip contains no .yaml case documents' });
        docs = yamlEntries.map((k) => ({ label: k, text: Buffer.from(entries[k]!).toString('utf8') }));
      } catch (e) {
        return reply.code(422).send({ error: `corrupt zip: ${e instanceof Error ? e.message : String(e)}` });
      }
    } else {
      return reply.code(400).send({ error: 'provide { yaml } or { filename, zipBase64 }' });
    }
    if (docs.length === 0) return reply.code(422).send({ error: 'no case documents found' });

    // validate ALL before inserting ANY (all-or-nothing)
    type Parsed = { label: string; case: ReturnType<typeof parseCaseYaml>['case'] };
    const parsed: Parsed[] = [];
    for (const d of docs) {
      const peekImp = parseCaseYaml(d.text);
      const docAppImp = (peekImp.case as { app?: string } | null)?.app ?? null;
      const r = parseCaseYaml(d.text, { hasLogoutRecipe: (bundle) => (bundle === null || bundle === undefined) ? (docAppImp !== null ? hasLogoutRecipe(docAppImp) : true) : hasLogoutRecipe(bundle), hasLoginRecipe: (bundle) => (bundle === null || bundle === undefined) ? (docAppImp !== null ? hasLoginRecipe(docAppImp) : true) : hasLoginRecipe(bundle) });
      if (!r.ok || !r.case) return reply.code(422).send({ error: `${d.label}: ${(r.errors[0]?.message) ?? 'unparsable'}`, allRejected: true });
      const refErr = resolveCaseRefs(db, r.case as never, r.case.app ?? null);
      if (refErr) return reply.code(422).send({ error: `${d.label}: ${refErr}`, allRejected: true });
      // sweep #5: a folder path with no app to hang it on would silently drop
      if ((r.case as { folder?: string }).folder && !(r.case as { app?: string }).app) {
        return reply.code(422).send({ error: `${d.label}: folder requires an app (app: <bundle>) to resolve its tree`, allRejected: true });
      }
      parsed.push({ label: d.label, case: r.case });
    }
    const now = Date.now();
    const imported: Array<{ id: string; name: string }> = [];
    const renamed: Array<{ from: string; to: string }> = [];
    // folder chain resolve-or-create (plan 20260928T023000Z): a/b/c under the
    // case's app; segments created inside the SAME transaction (all-or-nothing)
    const resolveFolder = (appBundle: string | null, path: string): string | null => {
      if (!appBundle || !path.trim()) return null;
      let parent: string | null = null;
      for (const seg of path.split('/').map((s) => s.trim()).filter(Boolean)) {
        const existing = db.prepare('SELECT id FROM folders WHERE app_bundle_id = ? AND parent_id IS ? AND name = ?').get(appBundle, parent, seg) as { id: string } | undefined;
        if (existing) { parent = existing.id; continue; }
        const fid = `fld_${randomUUID().slice(0, 8)}`;
        db.prepare('INSERT INTO folders(id, app_bundle_id, parent_id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(fid, appBundle, parent, seg, req.user?.name ?? 'unknown', now, now);
        parent = fid;
      }
      return parent;
    };
    const tx = db.transaction(() => {
      for (const { case: c } of parsed) {
        const orig = (c as { name: string }).name;
        let name = orig;
        if (db.prepare('SELECT 1 FROM templates WHERE name = ?').get(name)) {
          name = `${orig} (imported)`;
          let n = 2;
          while (db.prepare('SELECT 1 FROM templates WHERE name = ?').get(name)) { name = `${orig} (imported ${n})`; n += 1; }
          renamed.push({ from: orig, to: name });
        }
        const id = `tpl_${randomUUID().slice(0, 8)}`;
        db.prepare(
          `INSERT INTO templates(id, name, steps_json, setup_json, alerts_policy, variants_json, tags_json, app_bundle_id, entry_json, udid, status, folder_id, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', 'draft', ?, ?, ?, ?)`,
        ).run(id, name, JSON.stringify((c as { steps: unknown[] }).steps),
          (c as { setup?: unknown[] }).setup ? JSON.stringify((c as { setup?: unknown[] }).setup) : null,
          (c as { alerts?: unknown }).alerts ? JSON.stringify((c as { alerts?: unknown }).alerts) : null,
          (c as { variants?: unknown[] }).variants ? JSON.stringify((c as { variants?: unknown[] }).variants) : null,
          tagsToJson((c as { tags: string[] }).tags ?? []),
          (c as { app?: string | null }).app ?? null,
          (c as { entry?: unknown }).entry ? JSON.stringify((c as { entry?: unknown }).entry) : null,
          resolveFolder((c as { app?: string | null }).app ?? null, (c as { folder?: string }).folder ?? ''),
          req.user?.name ?? 'unknown', now, now);
        imported.push({ id, name });
      }
    });
    tx();
    return reply.code(201).send({ imported, renamed });
  });

  app.patch('/api/templates/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { name?: string; description?: string | null; ticketKey?: string | null; defaultPresetId?: string | null; steps?: unknown[]; setup?: unknown[] | null; alerts?: unknown | null; tags?: string[]; appBundleId?: string | null; status?: string; folderId?: string | null };
    const row = db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as TemplateRow | undefined;
    if (!row) return reply.code(404).send({ error: 'not found' });
    if (b.name !== undefined && !b.name.trim()) return reply.code(400).send({ error: 'name cannot be empty' });
    // Phase E: lifecycle validation at the API seam (ALTER'd legacy tables
    // carry no CHECK — this is the one write gate).
    if (b.status !== undefined && !['draft', 'active', 'deprecated'].includes(b.status)) {
      return reply.code(400).send({ error: 'status must be draft|active|deprecated' });
    }
    // folders (plan 20260928T023000Z): moves validated at the seam — target
    // folder must belong to the case's app (folders are app-scoped).
    // Sweep #4: changing a case's APP while it sits in a folder would orphan
    // it from both trees — refuse unless the folder belongs to the new app.
    if (b.appBundleId !== undefined && b.appBundleId !== row.app_bundle_id && row.folder_id) {
      const curFolder = db.prepare('SELECT app_bundle_id FROM folders WHERE id = ?').get(row.folder_id) as { app_bundle_id: string } | undefined;
      if (curFolder && curFolder.app_bundle_id !== b.appBundleId) {
        return reply.code(409).send({ error: `case sits in a folder of ${curFolder.app_bundle_id} — move it out before changing its app` });
      }
    }
    if (b.folderId !== undefined && b.folderId !== null) {
      const folder = db.prepare('SELECT app_bundle_id FROM folders WHERE id = ?').get(b.folderId) as { app_bundle_id: string } | undefined;
      if (!folder) return reply.code(409).send({ error: `folder "${b.folderId}" not found` });
      const caseApp = b.appBundleId !== undefined ? b.appBundleId : row.app_bundle_id;
      if (folder.app_bundle_id !== caseApp) return reply.code(409).send({ error: `folder belongs to ${folder.app_bundle_id} — folders are app-scoped` });
    }
    db.prepare(
      `UPDATE templates SET
         name = ?, description = ?, ticket_key = ?, default_preset_id = ?, steps_json = ?, setup_json = ?, alerts_policy = ?, tags_json = ?, app_bundle_id = ?, status = ?, folder_id = ?, updated_at = ?, updated_by = ?
       WHERE id = ?`,
    ).run(
      b.name !== undefined ? b.name.trim() : row.name,
      b.description !== undefined ? b.description : row.description,
      b.ticketKey !== undefined ? b.ticketKey : row.ticket_key,
      b.defaultPresetId !== undefined ? b.defaultPresetId : row.default_preset_id,
      b.steps !== undefined ? JSON.stringify(b.steps) : row.steps_json,
      b.setup !== undefined ? (b.setup === null ? null : JSON.stringify(b.setup)) : row.setup_json,
      b.alerts !== undefined ? (b.alerts === null ? null : JSON.stringify(b.alerts)) : row.alerts_policy,
      b.tags !== undefined ? tagsToJson(b.tags) : row.tags_json,
      b.appBundleId !== undefined ? b.appBundleId : row.app_bundle_id,
      b.status !== undefined ? b.status : (row.status ?? 'active'),
      b.folderId !== undefined ? b.folderId : row.folder_id,
      Date.now(),
      req.user?.name ?? null,
      id,
    );
    return rowToTemplate(db, db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as TemplateRow);
  });

  /** Tier 2.2 — tap overlay data for the evidence player: the SAME run the
   *  video route serves (latestFinishedRun), its taps, and the video
   *  alignment anchor. No anchor ⇒ no overlay is possible ⇒ 404 so the
   *  player falls back to plain video. */
  app.get('/api/templates/:id/run-taps', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { variant } = req.query as { variant?: string };
    const run = latestFinishedRun(db, id, variant);
    if (!run) return reply.code(404).send({ error: 'template has no finished run' });
    const row = db.prepare(`SELECT video_started_at AS v, video_anchor_ms AS va, overlay_offset_ms AS ro, device_udid AS udid FROM runs WHERE id = ?`).get(run.id) as
      { v: number | null; va: number | null; ro: number | null; udid: string | null };
    const anchor = row.va ?? row.v;
    if (anchor == null) return reply.code(404).send({ error: 'no video for latest run — overlay unavailable' });
    // effective offset: per-run wins; else the device-remembered default
    // (plan "both" persistence — the player shows which source applied)
    let offsetMs: number = row.ro ?? 0;
    let offsetSource: 'run' | 'device' = 'run';
    if ((row.ro ?? null) == null && row.udid) {
      const d = db.prepare('SELECT offset_ms FROM device_overlay_defaults WHERE udid = ?').get(row.udid) as { offset_ms: number } | undefined;
      if (d) { offsetMs = d.offset_ms; offsetSource = 'device'; }
    }
    const taps = tapsForRun(db, run.id);
    reply.header('cache-control', 'no-store');
    return { runId: run.id, videoStartedAt: anchor, anchor, offsetMs, offsetSource, taps };
  });

  /** Latest-evidence resolver: newest finished run of this template → its
   *  evidence row → redirect to the existing streaming route (Range etc. ride
   *  along). kind is an enum — the request never touches the filesystem. */
  app.get('/api/templates/:id/evidence/:kind', async (req, reply) => {
    const { id, kind } = req.params as { id: string; kind: string };
    const { variant } = req.query as { variant?: string };
    if (kind !== 'screenshot' && kind !== 'video') return reply.code(404).send({ error: 'kind must be screenshot or video' });
    const run = latestFinishedRun(db, id, variant);
    if (!run) return reply.code(404).send({ error: 'template has no finished run' });
    let evId: string | undefined;
    if (kind === 'screenshot') {
      // prefer the FIRST FAILED expect's shot (the break point), else the LAST
      // expect's, else any screenshot evidence (no-expect fallback shot)
      const steps = db.prepare(
        `SELECT idx, status, evidence_ids_json FROM run_steps WHERE run_id = ? AND evidence_ids_json != '[]' ORDER BY idx`,
      ).all(run.id) as Array<{ idx: number; status: string; evidence_ids_json: string }>;
      const withEv = steps
        .map((r) => ({ ...r, ids: JSON.parse(r.evidence_ids_json) as string[] }))
        .filter((r) => r.ids.length > 0);
      const failed = withEv.find((r) => r.status === 'fail');
      const chosen = failed ?? withEv[withEv.length - 1];
      evId = chosen?.ids[0];
      if (!evId) {
        const any = db.prepare(`SELECT id FROM evidence WHERE bundle_id = ? AND type = 'screenshot' LIMIT 1`).get(run.id) as { id: string } | undefined;
        evId = any?.id;
      }
    } else {
      const v = db.prepare(`SELECT id FROM evidence WHERE bundle_id = ? AND type = 'video' LIMIT 1`).get(run.id) as { id: string } | undefined;
      evId = v?.id;
    }
    if (!evId) return reply.code(404).send({ error: `no ${kind} evidence for latest run` });
    reply.header('cache-control', 'no-store');
    return reply.redirect(`/api/evidence/${evId}/file`);
  });

  /** Evidence gallery for the lightbox, as ONE LANE PER VARIANT (phase C):
 *  each lane = the newest FINISHED run in that (template, variant) lane —
 *  exactly what retention keeps (latest-only per lane), so a lane never
 *  needs more than one run. Lanes with no finished run are omitted;
 *  a never-run template 404s as before. `?variant=` scopes the response
 *  to a single lane (same id/'' semantics as the resolver). Legacy
 *  single-run shape ({runId, items}) is GONE — the lightbox is the only
 *  consumer and ships in the same change. */
  app.get('/api/templates/:id/evidence', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { variant } = req.query as { variant?: string };
    // scoped pick: variant given (id or ''=variantless lane) → that lane only;
    // absent → every lane. Built conditionally — a (? IS NULL OR …) shape
    // short-circuits TRUE for the '' case and leaks all lanes.
    const scoped = variant !== undefined;
    // lane headers need the run's own status + time; env deltas come from the
    // template's variant definitions (variants_json), not the run
    const laneRows = db.prepare(
      `SELECT variant_id AS v, id, status, started_at FROM runs WHERE template_id = ? AND finished_at IS NOT NULL
       ${scoped ? 'AND variant_id IS ?' : ''}
       AND id IN (SELECT id FROM runs r2 WHERE r2.template_id = runs.template_id AND r2.variant_id IS runs.variant_id
                  AND r2.finished_at IS NOT NULL ORDER BY r2.started_at DESC LIMIT 1)
       ORDER BY variant_id`,
    ).all(...(scoped ? [id, variant === '' ? null : variant] : [id])) as Array<{ v: string | null; id: string; status: string; started_at: number }>;
    if (laneRows.length === 0) return reply.code(404).send({ error: 'template has no finished run' });

    /** B1 lane axis (2026-09-24): a swap run is its OWN lane — labeled by its
     *  world sequence (sg → my → empty), not by its entry variant. Detected by
     *  swap steps in the run (evaluated swapTarget values, first-occurrence
     *  order = the sequence). Single-world runs keep variant_id as the lane. */
    const swapSequence = (runId: string): string[] => {
      const rows = db.prepare(
        `SELECT evaluated_json FROM run_steps WHERE run_id = ? AND status = 'pass' ORDER BY idx`,
      ).all(runId) as Array<{ evaluated_json: string | null }>;
      const seq: string[] = [];
      for (const r of rows) {
        try {
          const ev = JSON.parse(r.evaluated_json ?? '{}') as { action?: string; swapTarget?: string };
          if (ev.action === 'swap' && ev.swapTarget && !seq.includes(ev.swapTarget)) seq.push(ev.swapTarget);
        } catch { /* pre-R2 rows */ }
      }
      return seq;
    };

    /** env delta for a lane, from the template's variant definitions —
     *  variants_json holds [{id, networkScenario, env}]; the variantless
     *  lane and unknown ids get null (rendered as —) */
    const variantEnv = (tplId: string, vId: string | null): Record<string, string> | null => {
      if (vId === null) return null;
      const row = db.prepare('SELECT variants_json FROM templates WHERE id = ?').get(tplId) as { variants_json: string | null } | undefined;
      if (!row?.variants_json) return null;
      const def = (JSON.parse(row.variants_json) as Array<{ id: string; env?: Record<string, string> }>).find((x) => x.id === vId);
      return def?.env ?? null;
    };

    const itemsFor = (runId: string): Array<{ stepIdx: number; stepName: string; status: string; kind: string; evId: string }> => {
      const steps = db.prepare(
        `SELECT idx, name, status, evidence_ids_json, evaluated_json FROM run_steps WHERE run_id = ? AND evidence_ids_json != '[]' ORDER BY idx`,
      ).all(runId) as Array<{ idx: number; name: string; status: string; evidence_ids_json: string; evaluated_json: string | null }>;
      const items: Array<{ stepIdx: number; stepName: string; status: string; kind: string; evId: string; swapTarget?: string }> = [];
      for (const st of steps) {
        // R2: the step's evaluated payload names the swap target the run was
        // IN when this evidence was captured — world screenshots group by it
        let swapTarget: string | undefined;
        try { swapTarget = (JSON.parse(st.evaluated_json ?? '{}') as { swapTarget?: string }).swapTarget; } catch { /* absent pre-R2 */ }
        for (const evId of JSON.parse(st.evidence_ids_json) as string[]) {
          const ev = db.prepare('SELECT type FROM evidence WHERE id = ?').get(evId) as { type: string } | undefined;
          if (ev) items.push({ stepIdx: st.idx, stepName: st.name, status: st.status, kind: ev.type, evId, ...(swapTarget ? { swapTarget } : {}) });
        }
      }
      const vid = db.prepare(`SELECT id FROM evidence WHERE bundle_id = ? AND type = 'video' LIMIT 1`).get(runId) as { id: string } | undefined;
      // zero-expect fallback: a run that failed before any expect step (gate
      // abort, app-check fail, all steps skipped) still carries ONE final
      // screenshot — the SAME fallback the thumbnail route uses. Without this
      // the thumbnail shows evidence and the lightbox shows an empty gallery.
      if (!items.some((i) => i.kind === 'screenshot')) {
        const shot = db.prepare(`SELECT id FROM evidence WHERE bundle_id = ? AND type = 'screenshot' ORDER BY created_at DESC LIMIT 1`).get(runId) as { id: string } | undefined;
        if (shot) {
          const runRow = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string } | undefined;
          items.push({ stepIdx: -1, stepName: 'run end — no expect steps reached', status: runRow?.status === 'failed' ? 'fail' : 'info', kind: 'screenshot', evId: shot.id });
        }
      }
      if (vid) items.push({ stepIdx: -1, stepName: 'whole run', status: 'info', kind: 'video', evId: vid.id });
      return items;
    };

    const lanes = laneRows.map((l) => {
      const env = variantEnv(id, l.v);
      const seq = swapSequence(l.id);
      // entry world + swaps = the full sequence; >1 distinct target = swap run
      const worldSeq = [...(l.v ? [l.v] : []), ...seq].filter((w, i, a) => a.indexOf(w) === i);
      const isSwap = worldSeq.length > 1;
      return { variantId: l.v, runId: l.id, runStatus: l.status, startedAt: l.started_at, env, items: itemsFor(l.id), ...(isSwap ? { swapRun: true, worldSeq } : {}) };
    });
    return { templateId: id, lanes };
  });

  app.delete('/api/templates/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = db.prepare('DELETE FROM templates WHERE id = ?').run(id);
    if (r.changes === 0) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });

  /** Purge ONE variant lane's artifacts: files + evidence rows + step refs +
   *  run rows (all finished runs in the lane). Refuses with 409 while any run
   *  in the lane is live (unfinished) — its evidence is being written right
   *  now. Same cleanup recipe as retention's prunePreviousRunArtifacts. */
  app.delete('/api/templates/:id/runs', async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { variant?: string };
    if (q.variant === undefined) return reply.code(400).send({ error: 'variant query param required ("" for the variantless lane)' });
    const lane = q.variant === '' ? null : q.variant;

    const live = db.prepare('SELECT id FROM runs WHERE template_id = ? AND variant_id IS ? AND finished_at IS NULL').get(id, lane);
    if (live) return reply.code(409).send({ error: 'lane has a live run', runId: (live as { id: string }).id });

    const victims = db.prepare('SELECT id FROM runs WHERE template_id = ? AND variant_id IS ?').all(id, lane) as Array<{ id: string }>;
    if (victims.length === 0) return reply.code(404).send({ error: 'lane has no runs' });
    const artifactsDir = process.env['CRUCIBLE_ARTIFACTS_DIR'] ?? './artifacts';
    for (const v of victims) {
      try { rmSync(join(artifactsDir, v.id), { recursive: true, force: true }); } catch { /* best-effort */ }
      db.prepare('DELETE FROM evidence WHERE bundle_id = ?').run(v.id);
    }
    db.prepare('DELETE FROM run_steps WHERE run_id IN (SELECT id FROM runs WHERE template_id = ? AND variant_id IS ?)').run(id, lane);
    db.prepare('DELETE FROM runs WHERE template_id = ? AND variant_id IS ?').run(id, lane);
    return { deleted: victims.length };
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
    const rows = db.prepare('SELECT name, steps_json, app_bundle_id, tags_json, variants_json FROM templates').all() as
      Array<{ name: string; steps_json: string; app_bundle_id: string | null; tags_json: string | null; variants_json: string | null }>;
    const selMap = new Map<string, { value: string; kind: 'label' | 'identifier'; uses: number; cases: Set<string> }>();
    const caseNames: string[] = [];
    const apps = new Set<string>();
    const tags = new Set<string>();
    const variantIds = new Set<string>();
    for (const r of rows) {
      caseNames.push(r.name);
      if (r.app_bundle_id) apps.add(r.app_bundle_id);
      for (const t of JSON.parse(r.tags_json ?? '[]') as unknown[]) {
        if (typeof t === 'string' && t.trim()) tags.add(t.trim());
      }
      if (r.variants_json) {
        try {
          for (const v of JSON.parse(r.variants_json) as Array<{ id?: unknown }>) {
            if (typeof v['id'] === 'string' && VARIANT_ID_RE_LOCAL.test(v['id'])) variantIds.add(v['id']);
          }
        } catch { /* malformed variants_json — tolerated */ }
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
      // phase B — variant completions (malformed variants_json tolerated,
      // same rule as malformed steps: skip the row's variants, keep the rest)
      scenarios: (db.prepare('SELECT name FROM scenarios ORDER BY name').all() as Array<{ name: string }>).map((r) => r.name),
      variantIds: [...variantIds],
      // registry-UI stage 1: screen/state vocabulary for R2 verb completions.
      // Screen ids are unique per bundle ONLY — every entry carries its
      // bundle so the editor can scope to the case's own app (review F2).
      screens: (db.prepare('SELECT app_bundle_id, screen_id, states_json FROM app_screens ORDER BY app_bundle_id, screen_id').all() as Array<{ app_bundle_id: string; screen_id: string; states_json: string }>)
        .map((r) => {
          let states: string[] = [];
          try { states = Object.keys(JSON.parse(r.states_json) as Record<string, unknown>); } catch { /* malformed — empty */ }
          return { screen: r.screen_id, bundle: r.app_bundle_id, states };
        }),
    };
  });

  /** bare `ensure logout:` save-time guard (plan 20260929T080249Z F2):
   *  true when the app has a recipe in app_logout. Absent app → unchecked
   *  here; playback fails closed with the same message. */
  const hasLoginRecipe = (bundle: string | null | undefined): boolean => {
    if (!bundle) return false;
    return !!db.prepare('SELECT 1 FROM app_login WHERE bundle_id = ?').get(bundle);
  };
  const hasLogoutRecipe = (bundle: string | null | undefined): boolean => {
    if (!bundle) return false;
    return !!db.prepare('SELECT 1 FROM app_logout WHERE bundle_id = ?').get(bundle);
  };

  app.post('/api/templates/yaml/validate', async (req) => {
    const b = req.body as { yaml?: string };
    const r = parseCaseYaml(b.yaml ?? '');
    return { ok: r.ok, errors: r.errors, case: r.case, runFlowNames: r.runFlowNames };
  });

  /** GET the case as YAML (editor load) — name resolution for runFlow:
   *  template ids are tpl_8hex (human-hostile), so steps referencing other
   *  cases serialize with the referenced case's NAME; the id rides in a
   *  comment-free {name:} field and resolves on save. */
  // ── export: batch zip of case yamls + manifest (plan 20260927T164000Z; zipped per operator decision) ──
  app.get('/api/templates/export', { preHandler: requireRole('operator') }, async (req, reply) => {
    const q = req.query as { ids?: string };
    let rows: TemplateRow[];
    if (q.ids !== undefined && q.ids.trim() !== '') {
      const wanted = q.ids.split(',').map((s) => s.trim()).filter(Boolean);
      const found = wanted.map((id) => db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as TemplateRow | undefined)
        .filter((r): r is TemplateRow => Boolean(r)); // unknown ids skipped (review F5)
      rows = found;
    } else {
      rows = db.prepare('SELECT * FROM templates ORDER BY name').all() as TemplateRow[];
    }
    const files: Record<string, Uint8Array> = {};
    const manifestCases: Array<{ id: string; name: string; file: string; app: string | null }> = [];
    const used = new Map<string, number>();
    for (const row of rows) {
      const yaml = renderTemplateYaml(db, row);
      let slug = caseSlug(row.name);
      const n = (used.get(slug) ?? 0) + 1;
      used.set(slug, n);
      if (n > 1) slug = `${slug}-${n}`;
      const file = `${slug}.yaml`;
      files[file] = new TextEncoder().encode(yaml);
      manifestCases.push({ id: row.id, name: row.name, file, app: row.app_bundle_id ?? null });
    }
    const manifest = JSON.stringify({ exportedAt: new Date().toISOString(), cases: manifestCases }, null, 2);
    files['manifest.json'] = new TextEncoder().encode(manifest);
    const zip = zipSync(files);
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
    reply.header('content-type', 'application/zip');
    reply.header('content-disposition', `attachment; filename="lionidas-testcases-${stamp}.zip"`);
    return reply.send(Buffer.from(zip));
  });

  app.get('/api/templates/:id/yaml', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as TemplateRow | undefined;
    if (!row) return reply.code(404).send({ error: 'not found' });
    const yaml = renderTemplateYaml(db, row);
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
const peekPut = parseCaseYaml(b.yaml ?? '');
    const docAppPut = (peekPut.case as { app?: string } | null)?.app ?? null;
    const r = parseCaseYaml(b.yaml ?? '', { hasLogoutRecipe: (bundle) => (bundle === null || bundle === undefined) ? hasLogoutRecipe(row.app_bundle_id) : hasLogoutRecipe(bundle), hasLoginRecipe: (bundle) => (bundle === null || bundle === undefined) ? hasLoginRecipe(row.app_bundle_id) : hasLoginRecipe(bundle) });
    if (!r.ok || !r.case) return reply.code(422).send({ errors: r.errors });
    // one resolution bar, shared with import (review F1). Conflict-class
    // failures keep the historical 409 contract (runFlow name unresolved,
    // duplicate endpoint) — the shared helper reports strings; classify.
    const refErr = resolveCaseRefs(db, r.case as never, row.app_bundle_id);
    if (refErr) {
      const conflict = refErr.startsWith('runFlow:') || refErr.includes('both fake');
      return reply.code(conflict ? 409 : 422).send({ errors: [{ line: 1, message: refErr }] });
    }
    // the yaml may also RENAME this case — same UNIQUE constraint applies
    if (r.case.name !== row.name) {
      const clash = db.prepare('SELECT id FROM templates WHERE name = ? AND id != ?').get(r.case.name, id);
      if (clash) return reply.code(409).send({ errors: [{ line: 1, message: `a case named "${r.case.name}" already exists` }] });
    }
    db.prepare(
      `UPDATE templates SET name = ?, steps_json = ?, setup_json = ?, alerts_policy = ?, variants_json = ?, tags_json = ?, app_bundle_id = COALESCE(?, app_bundle_id), entry_json = ?, updated_at = ?, updated_by = ? WHERE id = ?`,
    ).run(r.case.name, JSON.stringify(r.case.steps), r.case.setup ? JSON.stringify(r.case.setup) : null, r.case.alerts ? JSON.stringify(r.case.alerts) : null, r.case.variants ? JSON.stringify(r.case.variants) : (r.case.swaps ? JSON.stringify(r.case.swaps) : (r.case.worlds ? JSON.stringify(r.case.worlds) : null)), tagsToJson(r.case.tags), r.case.app ?? null, r.case.entry ? JSON.stringify(r.case.entry) : null, Date.now(), req.user?.name ?? null, id);
    return rowToTemplate(db, db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as TemplateRow);
  });

  // ── Phase A: case versions (immutable run provenance) ──────────────────
  // List for one case, revision desc. The yaml IS the audit surface —
  // inline, not behind a second fetch. Scenario snapshot rides along as
  // parsed json (null when the version ran scenario-free).
  app.get('/api/templates/:id/versions', async (req, _reply) => {
    const { id } = req.params as { id: string };
    const rows = db.prepare(
      'SELECT id, revision, steps_sha256, yaml_canonical, scenario_id, scenario_snapshot_json, source, created_by, created_at FROM case_versions WHERE template_id = ? ORDER BY revision DESC',
    ).all(id) as Array<{ id: string; revision: number; steps_sha256: string; yaml_canonical: string; scenario_id: string | null; scenario_snapshot_json: string | null; source: string; created_by: string | null; created_at: number }>;
    // live content sha: the footer hides numbered chips whose snapshot
    // MATCHES the live case — "current" represents them instead (a state
    // is only named rN once superseded).
    const live = db.prepare('SELECT steps_json FROM templates WHERE id = ?').get(id) as { steps_json: string } | undefined;
    const liveSha = live ? createHash('sha256').update(live.steps_json).digest('hex') : null;
    const count = db.prepare('SELECT COUNT(*) n FROM runs WHERE case_version_id = ?');
    return {
      liveSha,
      versions: rows.map((v) => ({
        id: v.id, revision: v.revision, stepsSha: v.steps_sha256, yaml: v.yaml_canonical,
        scenarioId: v.scenario_id,
        scenarioSnapshot: v.scenario_snapshot_json ? JSON.parse(v.scenario_snapshot_json) as { presets: unknown[]; bodyManifest: Array<{ path: string; sha256: string }> } : null,
        source: v.source, createdBy: v.created_by, createdAt: v.created_at,
        runCount: (count.get(v.id) as { n: number }).n,
      })),
    };
  });

  // One version + its runs — survives template deletion (no FK), so an
  // audit link outlives the case itself.
  app.get('/api/versions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const v = db.prepare(
      'SELECT id, template_id, revision, steps_sha256, yaml_canonical, scenario_id, scenario_snapshot_json, source, created_by, created_at FROM case_versions WHERE id = ?',
    ).get(id) as { id: string; template_id: string; revision: number; steps_sha256: string; yaml_canonical: string; scenario_id: string | null; scenario_snapshot_json: string | null; source: string; created_by: string | null; created_at: number } | undefined;
    if (!v) return reply.code(404).send({ error: 'version not found' });
    const runs = db.prepare(
      'SELECT id, status, started_at, app_version, device_udid FROM runs WHERE case_version_id = ? ORDER BY started_at DESC LIMIT 50',
    ).all(id) as Array<{ id: string; status: string; started_at: number; app_version: string | null; device_udid: string }>;
    return {
      version: {
        id: v.id, templateId: v.template_id, revision: v.revision, stepsSha: v.steps_sha256,
        yaml: v.yaml_canonical, scenarioId: v.scenario_id,
        scenarioSnapshot: v.scenario_snapshot_json ? JSON.parse(v.scenario_snapshot_json) as { presets: unknown[]; bodyManifest: Array<{ path: string; sha256: string }> } : null,
        source: v.source, createdBy: v.created_by, createdAt: v.created_at,
      },
      runs,
    };
  });
}
