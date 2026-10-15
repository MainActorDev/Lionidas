/** Draft + act-registered tools (breakdown steps_003).
 *  case.draft.save mirrors the import path IN-PROCESS: parseCaseYaml with the
 *  app's recipe hooks → resolveCaseRefs → collision check → INSERT
 *  status='draft' with folder resolve-or-create. Validator/409 errors surface
 *  VERBATIM as tool results (the loop does one repair round). No shadow store. */
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { parseCaseYaml } from '@crucible/shared/case-yaml';
import { resolveCaseRefs } from '../routes/templates.ts';
import type { ToolDeps } from './tools.ts';

function tagsToJson(input: unknown): string | null {
  if (Array.isArray(input) && input.every((t) => typeof t === 'string') && input.length > 0) return JSON.stringify(input);
  return null;
}

/** resolve-or-create the folder chain under an app (import-route semantics) */
function makeFolderResolver(db: Database.Database, by: string): (appBundle: string | null, path: string) => string | null {
  return (appBundle, path) => {
    if (!appBundle || !path.trim()) return null;
    let parent: string | null = null;
    const now = Date.now();
    for (const seg of path.split('/').map((s) => s.trim()).filter(Boolean)) {
      const existing = db.prepare('SELECT id FROM folders WHERE app_bundle_id = ? AND parent_id IS ? AND name = ?').get(appBundle, parent, seg) as { id: string } | undefined;
      if (existing) { parent = existing.id; continue; }
      const fid = `fld_${randomUUID().slice(0, 8)}`;
      db.prepare('INSERT INTO folders(id, app_bundle_id, parent_id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(fid, appBundle, parent, seg, by, now, now);
      parent = fid;
    }
    return parent;
  };
}

export function registerDraftTools(deps: ToolDeps & { registry: import('@mainactordev/butler').ToolRegistry }, opts?: { createdBy?: string }): void {
  const { db, registry, storage } = deps;
  const by = opts?.createdBy ?? 'agent';

  const hasLoginRecipe = (bundle: string | null | undefined): boolean =>
    !bundle ? false : !!db.prepare('SELECT 1 FROM app_login WHERE bundle_id = ?').get(bundle);
  const hasLogoutRecipe = (bundle: string | null | undefined): boolean =>
    !bundle ? false : !!db.prepare('SELECT 1 FROM app_logout WHERE bundle_id = ?').get(bundle);

  registry.register({
    name: 'case.draft.save',
    description: 'draft a test case from yaml: validated by the REAL case validator, then saved as a real template with status=draft. Validator/ref/collision errors return VERBATIM — fix the yaml and retry.',
    permission: 'draft',
    parameters: { type: 'object', properties: { yaml: { type: 'string', description: 'full case yaml (name, app, folder?, steps[, narrate, entry…])' } }, required: ['yaml'] },
    async execute(args) {
      const yaml = String(args['yaml'] ?? '');
      const r = parseCaseYaml(yaml, {
        hasLogoutRecipe: (bundle) => (bundle === null || bundle === undefined ? true : hasLogoutRecipe(bundle)),
        hasLoginRecipe: (bundle) => (bundle === null || bundle === undefined ? true : hasLoginRecipe(bundle)),
      });
      if (!r.ok || !r.case) {
        const errs = (r.errors ?? []).map((e) => (typeof e === 'string' ? e : `line ${e.line}: ${e.message}`)).join('; ');
        return `INVALID: ${errs}`;
      }
      const c = r.case as { name: string; app?: string | null; folder?: string; steps: unknown[]; setup?: unknown[]; alerts?: unknown; variants?: unknown[]; tags?: string[]; entry?: unknown };
      const refErr = resolveCaseRefs(db, c as never, c.app ?? null);
      if (refErr) return `INVALID: ${refErr}`;
      if ((c.folder ?? '').trim() && !c.app) return 'INVALID: folder requires an app (app: <bundle>) to resolve its tree';

      const name = c.name;
      if (db.prepare('SELECT id FROM templates WHERE name = ?').get(name)) {
        return `INVALID: a case named "${name}" already exists (409) — pick another name`;
      }

      const now = Date.now();
      const id = `tpl_${randomUUID().slice(0, 8)}`;
      db.prepare(
        `INSERT INTO templates(id, name, steps_json, setup_json, alerts_policy, variants_json, tags_json, app_bundle_id, entry_json, udid, status, folder_id, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', 'draft', ?, ?, ?, ?)`,
      ).run(
        id, name, JSON.stringify(c.steps),
        c.setup ? JSON.stringify(c.setup) : null,
        c.alerts ? JSON.stringify(c.alerts) : null,
        c.variants ? JSON.stringify(c.variants) : null,
        tagsToJson(c.tags ?? []), c.app ?? null,
        c.entry ? JSON.stringify(c.entry) : null,
        makeFolderResolver(db, by)(c.app ?? null, c.folder ?? ''),
        by, now, now,
      );
      return JSON.stringify({ templateId: id, status: 'draft', name });
    },
  });

  registry.register({
    name: 'case.draft.edit',
    description: 'edit an EXISTING case from full yaml (validated; folder/app-scope and name collisions surface verbatim)',
    permission: 'draft',
    parameters: { type: 'object', properties: { idOrName: { type: 'string' }, yaml: { type: 'string' } }, required: ['idOrName', 'yaml'] },
    async execute(args) {
      const key = String(args['idOrName'] ?? '');
      const yaml = String(args['yaml'] ?? '');
      const row = (db.prepare('SELECT * FROM templates WHERE id = ?').get(key) ?? db.prepare('SELECT * FROM templates WHERE name = ?').get(key)) as { id: string; name: string; status: string; app_bundle_id: string | null; folder_id: string | null } | undefined;
      if (!row) return `error: no case "${key}"`;
      // steps_004: active/deprecated cases are immutable to the agent — revise instead
      if (row.status !== 'draft') {
        return `INVALID: case "${key}" is ${row.status} — use case.draft.revise to edit it as a new draft (activation stays human)`;
      }

      const r = parseCaseYaml(yaml, {
        hasLogoutRecipe: (bundle) => (bundle === null || bundle === undefined ? hasLogoutRecipe(row.app_bundle_id) : hasLogoutRecipe(bundle)),
        hasLoginRecipe: (bundle) => (bundle === null || bundle === undefined ? hasLoginRecipe(row.app_bundle_id) : hasLoginRecipe(bundle)),
      });
      if (!r.ok || !r.case) {
        const errs = (r.errors ?? []).map((e) => (typeof e === 'string' ? e : `line ${e.line}: ${e.message}`)).join('; ');
        return `INVALID: ${errs}`;
      }
      const c = r.case as { name: string; app?: string | null; folder?: string; steps: unknown[]; setup?: unknown[]; alerts?: unknown; variants?: unknown[]; tags?: string[]; entry?: unknown };
      const refErr = resolveCaseRefs(db, c as never, c.app ?? null);
      if (refErr) return `INVALID: ${refErr}`;

      if (c.name !== row.name && db.prepare('SELECT id FROM templates WHERE name = ? AND id != ?').get(c.name, row.id)) {
        return `INVALID: a case named "${c.name}" already exists (409)`;
      }
      // app-change guard (PATCH-route semantics, verbatim)
      if ((c.app ?? null) !== row.app_bundle_id && row.folder_id) {
        const curFolder = db.prepare('SELECT app_bundle_id FROM folders WHERE id = ?').get(row.folder_id) as { app_bundle_id: string } | undefined;
        if (curFolder && curFolder.app_bundle_id !== (c.app ?? null)) {
          return `INVALID: case sits in a folder of ${curFolder.app_bundle_id} — move it out before changing its app (409)`;
        }
      }

      const folderId = (c.folder ?? '').trim()
        ? makeFolderResolver(db, by)(c.app ?? row.app_bundle_id, c.folder ?? '')
        : row.folder_id;

      db.prepare(
        `UPDATE templates SET name = ?, steps_json = ?, setup_json = ?, alerts_policy = ?, variants_json = ?, tags_json = ?, app_bundle_id = COALESCE(?, app_bundle_id), entry_json = ?, folder_id = ?, updated_at = ?, updated_by = ? WHERE id = ?`,
      ).run(
        c.name, JSON.stringify(c.steps),
        c.setup ? JSON.stringify(c.setup) : null,
        c.alerts ? JSON.stringify(c.alerts) : null,
        c.variants ? JSON.stringify(c.variants) : null,
        tagsToJson(c.tags ?? []), c.app ?? null,
        c.entry ? JSON.stringify(c.entry) : null,
        folderId, Date.now(), by, row.id,
      );
      return JSON.stringify({ templateId: row.id, status: 'updated', name: c.name });
    },
  });

  registry.register({
    name: 'note.save',
    description: 'save a learned note (pitfall/convention) — sourceRef (run id / session / doc sha) is MANDATORY provenance',
    permission: 'draft',
    parameters: { type: 'object', properties: { scopeKey: { type: 'string', description: 'e.g. app:<bundle>/screen:<id>' }, kind: { type: 'string', enum: ['pitfall', 'convention', 'env-gate', 'selector-trust', 'app-behavior'] }, content: { type: 'string' }, sourceRef: { type: 'string' } }, required: ['scopeKey', 'kind', 'content', 'sourceRef'] },
    async execute(args, ctx) {
      const n = await storage.insertNote({
        scope_key: String(args['scopeKey'] ?? ''), kind: (args['kind'] as never) ?? 'convention',
        content: String(args['content'] ?? ''), source_type: 'session', source_ref: String(args['sourceRef'] ?? ''), created_by: ctx.sessionId,
      });
      // R2-F3: embed-at-save (best-effort — a failed embed never blocks the write)
      try {
        if (deps.embedder) {
          const v = (await deps.embedder.embed([n.content]))[0]!;
          await storage.saveNoteEmbedding(n.id, deps.embedder.model, v.length, new Float32Array(v));
        }
      } catch { /* retrieval falls back to recency */ }
      return `note ${n.id} saved`;
    },
  });

  registry.register({
    name: 'sources.ingest',
    description: 'ingest source documents (kind=file: a directory of tickets/docs; kind=repo: a code repo with symbol chunks). Registered repos accept their NAME (e.g. "ios-consumer-intl") or an absolute path.',
    permission: 'draft',
    parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['file', 'repo'] }, root: { type: 'string', description: 'registered repo name (ios-consumer) or absolute path' } }, required: ['kind', 'root'] },
    async execute(args) {
      const butler = await import('@mainactordev/butler');
      const kind = String(args['kind'] ?? 'file');
      const rootArg = String(args['root'] ?? '');
      // rev23: repo NAME → the registered workspace clone (the agent has no way
      // to learn absolute paths; names are what repo.list returns)
      const root = /^[A-Za-z0-9._-]+$/.test(rootArg) && kind === 'repo'
        ? join(deps.reposRoot ?? '.', rootArg)
        : rootArg;
      if (!root) return JSON.stringify({ error: 'root required' });
      const conn = kind === 'repo'
        ? butler.repoConnector('lionidas-repo', { origin: root, symbols: true })
        : butler.fileConnector('lionidas-files', { root });
      const r = await butler.ingest(conn, storage, { artifactsDir: deps.artifactsDir });
      for (const d of r.documents) deps.retriever.registerChunks(await storage.documentChunks(d.sha256));
      return JSON.stringify({ documents: r.documents, skipped: r.skipped });
    },
  });

  // ── act-class: registered, REFUSED under V1 (unreachable bodies) ──
  registry.register({
    name: 'case.play', description: 'play a case on a device — ACT class, refused under the v1 policy (a human plays cases)',
    permission: 'act',
    parameters: { type: 'object', properties: { idOrName: { type: 'string' }, udid: { type: 'string' } }, required: ['idOrName'] },
    execute: async () => { throw new Error('unreachable under v1 policy'); },
  });
  registry.register({
    name: 'run.abort', description: 'abort a run — ACT class, refused under v1',
    permission: 'act',
    parameters: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'] },
    execute: async () => { throw new Error('unreachable under v1 policy'); },
  });
  registry.register({
    name: 'device.power', description: 'boot/shutdown/restart a simulator — ACT class, refused under v1',
    permission: 'act',
    parameters: { type: 'object', properties: { udid: { type: 'string' }, action: { type: 'string', enum: ['boot', 'shutdown', 'restart'] } }, required: ['udid', 'action'] },
    execute: async () => { throw new Error('unreachable under v1 policy'); },
  });
}
