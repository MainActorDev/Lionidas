/** Lionidas tool registry — READ tools (breakdown steps_002 §2c).
 *  Each tool is backed by existing server code paths (SQL + shared helpers);
 *  no HTTP self-calls. Model-facing: concise descriptions, JSON schemas. */
import { ToolRegistry, type SqliteStorage, type StorageRetriever } from '@mainactordev/butler';
import type Database from 'better-sqlite3';
import { renderTemplateYaml } from '../routes/templates.ts';
import { registerConfigTools } from './config-tools.ts';
import type { AttachmentStore } from './attachments.ts';

export interface ToolDeps {
  db: Database.Database;
  storage: SqliteStorage;
  retriever: StorageRetriever;
  artifactsDir: string;
  /** F2 (config plan review): preset writes push to the live forge proxy */
  syncPresets?: () => void;
  /** rev23 F2: attachment.get tool backing */
  attachments?: AttachmentStore;
}

interface TemplateLite { id: string; name: string; status: string | null; folder_id: string | null; app_bundle_id: string | null }

export function buildToolRegistry(deps: ToolDeps): ToolRegistry {
  const { db, storage, retriever, syncPresets, attachments } = deps;
  const registry = new ToolRegistry();

  registry.register({
    name: 'attachment.get',
    description: 'read an attachment by id — text files return their content; binaries return an honest manifest line (name, size, sha)',
    permission: 'read',
    parameters: { type: 'object', properties: { id: { type: 'string', description: 'attachment id (att_…)' } }, required: ['id'] },
    async execute(args) {
      if (!attachments) return 'error: attachment store not configured on this server';
      const id = String(args['id'] ?? '');
      const row = attachments.get(id);
      if (!row) return `error: no attachment "${id}"`;
      const text = await attachments.readText(id);
      if (text === null) return `error: attachment "${id}" file missing from store`;
      return text;
    },
  });

  registry.register({
    name: 'cases.list',
    description: 'list test cases (templates) with status — drafts included',
    permission: 'read',
    parameters: { type: 'object', properties: { limit: { type: 'number', description: 'max rows (default 50)' } } },
    async execute(args) {
      const limit = Math.min(Number(args['limit'] ?? 50) || 50, 200);
      const rows = db.prepare('SELECT id, name, status, folder_id, app_bundle_id FROM templates ORDER BY updated_at DESC LIMIT ?').all(limit) as TemplateLite[];
      return JSON.stringify(rows);
    },
  });

  registry.register({
    name: 'case.yaml.get',
    description: 'read one case rendered as yaml (id or unique name)',
    permission: 'read',
    parameters: { type: 'object', properties: { idOrName: { type: 'string' } }, required: ['idOrName'] },
    async execute(args) {
      const key = String(args['idOrName'] ?? '');
      const hit = db.prepare('SELECT * FROM templates WHERE id = ?').get(key) ?? db.prepare('SELECT * FROM templates WHERE name = ?').get(key);
      if (!hit) return `error: no case "${key}"`;
      return renderTemplateYaml(db, hit as never);
    },
  });

  registry.register({
    name: 'runs.history',
    description: 'recent runs with status filter — failures carry the triage knowledge',
    permission: 'read',
    parameters: { type: 'object', properties: { status: { type: 'string', enum: ['failed', 'passed', 'aborted'] }, limit: { type: 'number' } } },
    async execute(args) {
      const limit = Math.min(Number(args['limit'] ?? 25) || 25, 100);
      const status = typeof args['status'] === 'string' ? args['status'] : null;
      const rows = status
        ? db.prepare('SELECT id, template_id, status, started_at, finished_at FROM runs WHERE status = ? ORDER BY started_at DESC LIMIT ?').all(status, limit)
        : db.prepare('SELECT id, template_id, status, started_at, finished_at FROM runs ORDER BY started_at DESC LIMIT ?').all(limit);
      return JSON.stringify(rows);
    },
  });

  registry.register({
    name: 'run.steps',
    description: 'steps of one run with statuses, reasons, and narrate lines',
    permission: 'read',
    parameters: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'] },
    async execute(args) {
      const runId = String(args['runId'] ?? '');
      const rows = db.prepare('SELECT idx, name, status, reason, narrate FROM run_steps WHERE run_id = ? ORDER BY idx').all(runId) as Array<{ idx: number; name: string; status: string; reason: string | null; narrate: string | null }>;
      if (rows.length === 0) return `error: no steps for run "${runId}"`;
      return JSON.stringify(rows);
    },
  });

  registry.register({
    name: 'screens.registry',
    description: 'the app screen registry — screens, entries, named states. THE rulebook for valid screen references.',
    permission: 'read',
    parameters: { type: 'object', properties: { appBundle: { type: 'string', description: 'optional bundle filter' } } },
    async execute(args) {
      const bundle = typeof args['appBundle'] === 'string' ? args['appBundle'] : null;
      const rows = bundle
        ? db.prepare('SELECT app_bundle_id, screen_id, entry_json, refresh_json, states_json FROM app_screens WHERE app_bundle_id = ? ORDER BY screen_id').all(bundle)
        : db.prepare('SELECT app_bundle_id, screen_id, entry_json, refresh_json, states_json FROM app_screens ORDER BY app_bundle_id, screen_id').all();
      return JSON.stringify(rows);
    },
  });

  registry.register({
    name: 'folders.tree',
    description: 'folder tree with per-folder counts. kind=cases (default): app-scoped testcase folders. kind=scenarios | presets: GLOBAL single-root trees (no app scoping).',
    permission: 'read',
    parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['cases', 'scenarios', 'presets'] } } },
    async execute(args) {
      const kind = (typeof args['kind'] === 'string' ? args['kind'] : 'cases') as 'cases' | 'scenarios' | 'presets';
      interface Row { id: string; name: string; parent_id: string | null; n: number }
      let rows: Row[];
      if (kind === 'cases') {
        rows = db.prepare('SELECT f.id, f.name, f.parent_id, (SELECT COUNT(*) FROM templates t WHERE t.folder_id = f.id) AS n FROM folders f').all() as Row[];
      } else if (kind === 'scenarios') {
        rows = db.prepare('SELECT f.id, f.name, f.parent_id, (SELECT COUNT(*) FROM scenarios s WHERE s.folder_id = f.id) AS n FROM scenario_folders f').all() as Row[];
      } else if (kind === 'presets') {
        rows = db.prepare('SELECT f.id, f.name, f.parent_id, (SELECT COUNT(*) FROM presets p WHERE p.folder_id = f.id) AS n FROM preset_folders f').all() as Row[];
      } else {
        return `error: unknown kind "${String(args['kind'])}" — cases | scenarios | presets`;
      }
      interface Node { id: string; name: string; kind: 'cases' | 'scenarios' | 'presets'; count: number; children: Node[] }
      const byParent = new Map<string | null, Node[]>();
      for (const r of rows) {
        const node: Node = { id: r.id, name: r.name, kind, count: r.n, children: [] };
        const list = byParent.get(r.parent_id) ?? [];
        list.push(node);
        byParent.set(r.parent_id, list);
      }
      const attach = (parent: string | null): Node[] => {
        const kids = byParent.get(parent) ?? [];
        for (const k of kids) k.children = attach(k.id);
        return kids;
      };
      return JSON.stringify(attach(null));
    },
  });

  registry.register({
    name: 'envs.list',
    description: 'managed env vars (scoped global/app/plan): key, scope, masked value, secret flag. Use THIS for env questions — never query the database directly.',
    permission: 'read',
    parameters: { type: 'object', properties: { appBundle: { type: 'string' } } },
    async execute(args) {
      const app = typeof args['appBundle'] === 'string' ? args['appBundle'] : null;
      const rows = db.prepare(
        `SELECT v.id, v.scope, v.app_bundle_id, v.key, v.secret, v.value, v.note FROM env_vars v
         WHERE v.scope = 'global' OR (v.scope = 'app' AND (? IS NULL OR v.app_bundle_id = ?)) ORDER BY v.scope, v.key`,
      ).all(app, app) as Array<{ id: string; scope: string; app_bundle_id: string | null; key: string; secret: number; value: string; note: string | null }>;
      return JSON.stringify(rows.map((r) => ({
        id: r.id, scope: r.scope, app: r.app_bundle_id, key: r.key,
        value: r.secret ? '██████ (secret — masked)' : r.value,
        secret: Boolean(r.secret), note: r.note,
      })));
    },
  });

  registry.register({
    name: 'sources.search',
    description: 'BM25 search over ingested source documents (tickets, repos)',
    permission: 'read',
    parameters: { type: 'object', properties: { query: { type: 'string' }, topK: { type: 'number' } }, required: ['query'] },
    async execute(args) {
      const hits = await retriever.retrieve(String(args['query'] ?? ''), Math.min(Number(args['topK'] ?? 3) || 3, 10));
      if (hits.length === 0) return 'no documents ingested yet (call sources.ingest first)';
      return hits.map((h) => `[${h.kind} ${h.ref.slice(0, 12)}${h.headingPath ? ` ${h.headingPath}` : ''}] ${h.content.slice(0, 400)}`).join('\n---\n');
    },
  });

  registry.register({
    name: 'notes.read',
    description: 'active learned notes (pitfalls, conventions) with provenance',
    permission: 'read',
    parameters: { type: 'object', properties: { prefix: { type: 'string', description: 'scope prefix, e.g. app:<bundle>' } } },
    async execute(args) {
      const prefix = typeof args['prefix'] === 'string' ? args['prefix'] : undefined;
      const notes = await storage.activeNotes(prefix);
      if (notes.length === 0) return 'no active notes';
      return JSON.stringify(notes.map((n) => ({ scope: n.scope_key, kind: n.kind, content: n.content, source: n.source_ref })));
    },
  });

  registerConfigTools({ db, registry, ...(syncPresets ? { syncPresets } : {}) });

  return registry;
}
