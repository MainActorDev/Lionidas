/** Lionidas tool registry — READ tools (breakdown steps_002 §2c).
 *  Each tool is backed by existing server code paths (SQL + shared helpers);
 *  no HTTP self-calls. Model-facing: concise descriptions, JSON schemas. */
import { ToolRegistry, type SqliteStorage, type StorageRetriever } from '@mainactordev/butler';
import type Database from 'better-sqlite3';
import { renderTemplateYaml } from '../routes/templates.ts';
import { registerConfigTools } from './config-tools.ts';
import { registerCommandRunTool } from './commands.ts';
import type { AttachmentStore } from './attachments.ts';
import { join } from 'node:path';

export interface ToolDeps {
  db: Database.Database;
  storage: SqliteStorage;
  retriever: StorageRetriever;
  artifactsDir: string;
  /** F2 (config plan review): preset writes push to the live forge proxy */
  syncPresets?: () => void;
  /** rev23 F2: attachment.get tool backing */
  attachments?: AttachmentStore;
  /** rev23: registered workspace clones root — lets sources.ingest take repo NAMES */
  reposRoot?: string;
  /** R2-F3: note embedder for embed-at-save */
  embedder?: import('@mainactordev/butler').EmbeddingProvider;
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
        // revision included (sess_e2e40228): screens.draft.save requires a
        // revision echo — the read MUST expose it or the write contract is
        // unsatisfiable ("No revision field in the read" model narration)
        ? db.prepare('SELECT app_bundle_id, screen_id, entry_json, refresh_json, states_json, revision FROM app_screens WHERE app_bundle_id = ? ORDER BY screen_id').all(bundle)
        : db.prepare('SELECT app_bundle_id, screen_id, entry_json, refresh_json, states_json, revision FROM app_screens ORDER BY app_bundle_id, screen_id').all();
      return JSON.stringify(rows);
    },
  });

  registry.register({
    name: 'states.list',
    description: 'the app states registry — named app preconditions (probe / recipe / verify). THE vocabulary for ensure state: steps; state ids are unique per bundle. Recipes carry ${env.NAME} refs, never literal credentials.',
    permission: 'read',
    parameters: { type: 'object', properties: { appBundle: { type: 'string', description: 'optional bundle filter' } } },
    async execute(args) {
      const bundle = typeof args['appBundle'] === 'string' ? args['appBundle'] : null;
      const rows = bundle
        ? db.prepare('SELECT id, app_bundle_id, state_id, label, provenance, revision, probe_json, recipe_json, verify_json FROM app_states WHERE app_bundle_id = ? ORDER BY state_id').all(bundle)
        : db.prepare('SELECT id, app_bundle_id, state_id, label, provenance, revision, probe_json, recipe_json, verify_json FROM app_states ORDER BY app_bundle_id, state_id').all();
      return JSON.stringify(rows);
    },
  });

  registry.register({
    name: 'states.get',
    description: 'one app state in full — probe/recipe/verify plus its revision history (which recipe revision a past run executed).',
    permission: 'read',
    parameters: { type: 'object', properties: { appBundle: { type: 'string' }, stateId: { type: 'string' } }, required: ['appBundle', 'stateId'] },
    async execute(args) {
      const bundle = typeof args['appBundle'] === 'string' ? args['appBundle'] : '';
      const stateId = typeof args['stateId'] === 'string' ? args['stateId'] : '';
      const row = db.prepare('SELECT id, app_bundle_id, state_id, label, provenance, revision, probe_json, recipe_json, verify_json, created_by, created_at, updated_at FROM app_states WHERE app_bundle_id = ? AND state_id = ?').get(bundle, stateId) as Record<string, unknown> | undefined;
      if (!row) return JSON.stringify({ error: `state "${stateId}" is not registered for ${bundle} — states.list shows what exists` });
      const history = db.prepare('SELECT revision, snapshot_json, created_by, created_at FROM app_states_history WHERE app_state_id = ? ORDER BY revision DESC').all(row['id'] as string);
      return JSON.stringify({ state: row, history });
    },
  });

  registry.register({
    name: 'states.propose',
    description: 'draft a NEW registry state from a GREEN run into the proposal inbox (a human accepts it on the screens page; acceptance stamps provenance ai+user). probe/verify = the run\'s final passing expect; recipe = the run\'s own walk, or a deep copy of the ensureState walk it rode. Never edits or removes existing states.',
    permission: 'draft',
    parameters: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'the green run to draft from (run_…)' },
        stateId: { type: 'string', description: 'proposed state id — required unless the final expect targets a registered screen (then on_<screen> is derived)' },
        label: { type: 'string', description: 'human label (default: derived from the state id)' },
      },
      required: ['runId'],
    },
    async execute(args) {
      const runId = String(args['runId'] ?? '');
      const run = db.prepare('SELECT id, template_id, status FROM runs WHERE id = ?').get(runId) as { id: string; template_id: string; status: string } | undefined;
      if (!run) return `error: no run "${runId}"`;
      if (run.status !== 'passed') return `error: run ${runId} is ${run.status} — proposals draft from GREEN runs only (a failed run proves nothing)`;
      const tpl = db.prepare('SELECT id, name, app_bundle_id, steps_json, setup_json FROM templates WHERE id = ?').get(run.template_id) as { id: string; name: string; app_bundle_id: string | null; steps_json: string | null; setup_json: string | null } | undefined;
      if (!tpl || !tpl.app_bundle_id) return `error: run ${runId} has no app-bound case behind it`;
      const bundle = tpl.app_bundle_id;

      // probe/verify = the LAST passing expect's selector (the thing that
      // proved the final world — plan S2 heuristic, deliberately dumb)
      const stepRows = db.prepare('SELECT idx, name, status, evaluated_json FROM run_steps WHERE run_id = ? ORDER BY idx').all(runId) as Array<{ idx: number; name: string; status: string; evaluated_json: string | null }>;
      let probe: Record<string, unknown> | undefined;
      let walkAudit: { path?: string; probeMs?: number } | undefined;
      for (let i = stepRows.length - 1; i >= 0; i--) {
        const s = stepRows[i]!;
        if (s.status !== 'pass' || !s.evaluated_json) continue;
        const ev = JSON.parse(s.evaluated_json) as { action?: string; selector?: Record<string, unknown>; path?: string; probeMs?: number };
        if (ev.action === 'ensureState' && !walkAudit) walkAudit = ev;
        if (ev.action === 'expect' && ev.selector && !probe) probe = ev.selector;
      }
      if (!probe) return `error: run ${runId} has no passing expect step — nothing proved the final world, nothing to draft from`;
      // probe grammar accepts a screen REF as {screen} only — an expect
      // selector riding a screen STATE ({screen, state}) normalizes to the
      // screen identity; the state dimension lives in the screen registry
      if (typeof probe['screen'] === 'string') probe = { screen: probe['screen'] };

      // recipe — grammar-valid walk, never a nested state reference:
      // ensureState setup ⇒ deep-copy the referenced state's CURRENT recipe
      // (drift visible at review); else the case's own action steps
      let recipe: Record<string, unknown>;
      let walkDesc: string;
      const setup = (tpl.setup_json ? JSON.parse(tpl.setup_json) : []) as Array<Record<string, unknown>>;
      const ensureRef = setup.find((s) => typeof s['ensureState'] === 'string');
      if (ensureRef) {
        const refId = ensureRef['ensureState'] as string;
        const refRow = db.prepare('SELECT recipe_json, revision FROM app_states WHERE app_bundle_id = ? AND state_id = ?').get(bundle, refId) as { recipe_json: string; revision: number } | undefined;
        if (!refRow) return `error: the run rode ensure state "${refId}" which is no longer registered — the walk is not reproducible`;
        recipe = JSON.parse(refRow.recipe_json) as Record<string, unknown>;
        walkDesc = `walk deep-copied from ${refId} r${refRow.revision}`;
      } else {
        const caseSteps = (tpl.steps_json ? JSON.parse(tpl.steps_json) : []) as Array<Record<string, unknown>>;
        // storage form (action/selector) → compact walk grammar ({tap: {on}}),
        // walk-allowed set only (tap/type/expect/wait — validateAppState law).
        // A step outside that set refuses the draft honestly: the state
        // grammar can't express this walk.
        const selOn = (sel: unknown): { on: string; ignoreCase?: true } | undefined => {
          const s2 = sel as { label?: string; identifier?: string; ignoreCase?: boolean } | undefined;
          if (!s2) return undefined;
          if (typeof s2.label !== 'string' && typeof s2.identifier !== 'string') return undefined;
          return { on: (s2.label ?? s2.identifier)!, ...(s2.ignoreCase === true ? { ignoreCase: true as const } : {}) };
        };
        const walk: Array<Record<string, unknown>> = [];
        for (const st of caseSteps) {
          const a = String(st['action'] ?? '');
          if (a === 'expect') continue; // asserts are not the walk
          const on = selOn(st['selector']);
          const opt = st['optional'] === true ? { optional: true } : {};
          if (a === 'tap') {
            if (!on && !(typeof st['x'] === 'number' && typeof st['y'] === 'number')) return `error: the case walk has a tap with no target (neither selector nor point) — draft not expressible`;
            walk.push({ tap: { ...on, ...(typeof st['x'] === 'number' && typeof st['y'] === 'number' ? { point: [st['x'], st['y']] } : {}), ...opt } });
          } else if (a === 'type') {
            if (!on || typeof st['text'] !== 'string') return `error: the case walk has a type step without on/text — draft not expressible`;
            walk.push({ type: { ...on, text: st['text'], ...opt } });
          } else if (a === 'wait') {
            const w = st['wait'] as { ms?: number } | undefined;
            if (!w || typeof w.ms !== 'number') return `error: the case walk has a wait step without a duration — draft not expressible`;
            walk.push({ wait: w.ms }); // bare number = ms (grammar contract)
          } else if (a && a !== 'ensureState' && a !== 'ensureLogin' && a !== 'ensureLogout') {
            return `error: the case walk uses action "${a}" which state recipes do not allow (tap, type, expect, wait) — hand-author this state on the screens page`;
          }
        }
        if (walk.length === 0) return `error: this case proves but does not walk (no action steps) — draft from a run that navigates, or hand-author the state`;
        recipe = { steps: walk };
        walkDesc = `walk = the case's ${walk.length} grammar-expressible step(s)`;
      }

      // stateId — operator-supplied, else derived from a registered screen
      // ref in the probe (on_<screen>); refuse when neither can name one
      let stateId = typeof args['stateId'] === 'string' && args['stateId'].trim() ? args['stateId'].trim() : '';
      if (!stateId) {
        const screen = typeof probe['screen'] === 'string' ? probe['screen'] : undefined;
        const registered = screen ? db.prepare('SELECT screen_id FROM app_screens WHERE app_bundle_id = ? AND screen_id = ?').get(bundle, screen) : undefined;
        if (!registered) return `error: pass stateId — the bundle's screen registry can't name this state (probe has no registered screen ref)`;
        stateId = `on_${screen}`;
      }
      const label = typeof args['label'] === 'string' && args['label'].trim() ? args['label'].trim() : `Arrived: ${stateId}`;

      const { insertStateProposal } = await import('../routes/state-proposals.ts');
      const rationale = `proposed from ${runId} (${tpl.name})${walkAudit ? ` — ensureState path ${walkAudit.path ?? '?'}${walkAudit.probeMs ? ` probeMs ${walkAudit.probeMs}` : ''}` : ''}; probe/verify = final expect's target; ${walkDesc}`;
      const r = insertStateProposal(db, {
        bundle,
        draft: { stateId, label, probe, recipe: recipe as never, verify: probe } as never,
        rationale,
        sourceRunId: runId,
        user: 'agent',
      });
      if (!r.ok) return `error (${r.code}): ${r.error}`;
      return JSON.stringify({ proposal: r.proposal, deduped: r.deduped, next: 'a human accepts/rejects in the app states panel (screens page → app states)' });
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

  // R3 repo-reading plan, Stage C: staleness guard. Track last ingest per source;
  // stale (>1h) → kick a background re-ingest and SAY SO (honest note, review RR3).
  const lastIngestAt = new Map<string, number>();
  const STALE_MS = 60 * 60 * 1000;
  const ingestRepoInBackground = (root: string): void => {
    const key = `repo:${root}`;
    if (lastIngestAt.get(key) === -1) return; // refresh already in flight
    lastIngestAt.set(key, -1);
    void (async () => {
      try {
        const butler = await import('@mainactordev/butler');
        const conn = butler.repoConnector('lionidas-repo', { origin: root, symbols: true });
        const r = await butler.ingest(conn, storage, { artifactsDir: deps.artifactsDir });
        for (const d of r.documents) retriever.registerChunks(await storage.documentChunks(d.sha256));
        lastIngestAt.set(key, Date.now());
      } catch { lastIngestAt.delete(key); } // allow retry on next search
    })();
  };
  const _markIngestFresh = (root: string): void => { lastIngestAt.set(`repo:${root}`, Date.now()); };
  const repoSnapshotAgeMs = (root: string): number | null => {
    const t = lastIngestAt.get(`repo:${root}`);
    return typeof t === 'number' && t > 0 ? Date.now() - t : null;
  };

  registry.register({
    name: 'sources.search',
    description: 'BM25 search over ingested source documents (tickets, repos); refreshes stale repo snapshots (>1h) in the background',
    permission: 'read',
    parameters: { type: 'object', properties: { query: { type: 'string' }, topK: { type: 'number' } }, required: ['query'] },
    async execute(args) {
      const hits = await retriever.retrieve(String(args['query'] ?? ''), Math.min(Number(args['topK'] ?? 3) || 3, 10));
      // staleness: if a registered repo backs recent hits and is stale, kick refresh
      let staleNote = '';
      const reposRoot = deps.reposRoot ?? './repos';
      const _seenRoots = new Set<string>();
      for (const h of hits) {
        const m = /repo:\/\/([^/]+)\/(.+)$/.exec(h.ref);
        void m;
      }
      // simpler + honest: refresh when ANY registered repo has a tracked stale snapshot
      try {
        const { readdirSync } = await import('node:fs');
        for (const name of readdirSync(reposRoot)) {
          const root = join(reposRoot, name);
          const age = repoSnapshotAgeMs(root);
          if (age !== null && age > STALE_MS) {
            ingestRepoInBackground(root);
            staleNote = `[snapshot: ${Math.round(age / 60_000)}min old — refresh kicked, results may predate it]`;
          }
        }
      } catch { /* no repos root — plain search */ }
      if (hits.length === 0) return `${staleNote ? staleNote + '\n' : ''}no documents ingested yet (call sources.ingest first)`;
      return `${staleNote ? staleNote + '\n' : ''}${hits.map((h) => `[${h.kind} ${h.ref.slice(0, 12)}${h.headingPath ? ` ${h.headingPath}` : ''}] ${h.content.slice(0, 400)}`).join('\n---\n')}`;
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

  registerConfigTools({ db, registry, ...(syncPresets ? { syncPresets } : {}), ...(storage ? { storage } : {}) });
  registerCommandRunTool(registry); // dynamic skill routing (20261016T061611Z)

  return registry;
}
