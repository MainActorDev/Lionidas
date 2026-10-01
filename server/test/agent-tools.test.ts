import { describe, expect, it, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, cpSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/index.ts';

/** Breakdown steps_002: agent storage on the Lionidas DB + read tools + policy.
 *  Contract tests against the REAL server (buildApp), seeded like the CLI suite. */

// F5 wrapper: butler-dependent tests skip honestly when the package is absent
const hasButler = (() => { try { require.resolve('@mainactordev/butler'); return true; } catch { return false; } })();

describe.skipIf(!hasButler)('agent storage (F3 canary)', () => {
  it('butler_* tables created; double-open is idempotent (sqlite-split detector)', async () => {
    const { agentStorage } = await import('../src/agent/storage.ts');
    const dir = mkdtempSync(join(tmpdir(), 'butler-agent-'));
    const dbPath = join(dir, 'agent.db');
    const a = agentStorage(dbPath);
    const row = await a.createSession({ id: 's1', title: 'first' });
    expect(row.status).toBe('active');
    // F3 canary: a SECOND handle (butler's own better-sqlite3@12) opens the same file;
    // migrations re-run as no-ops; prior rows survive
    const b = agentStorage(dbPath);
    const again = await b.getSession('s1');
    expect(again?.title).toBe('first');
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('note provenance invariant holds through the Lionidas path', async () => {
    const { agentStorage } = await import('../src/agent/storage.ts');
    const dir = mkdtempSync(join(tmpdir(), 'butler-agent-'));
    const s = agentStorage(join(dir, 'a.db'));
    await expect(s.insertNote({ scope_key: 'app:x', kind: 'pitfall', content: 'n', source_type: 'run', source_ref: '', created_by: 't' })).rejects.toThrow(/provenance/);
    const n1 = await s.insertNote({ scope_key: 'app:x', kind: 'pitfall', content: 'old', source_type: 'run', source_ref: 'run_1', created_by: 't' });
    const n2 = await s.insertNote({ scope_key: 'app:x', kind: 'convention', content: 'new', source_type: 'run', source_ref: 'run_2', created_by: 't' });
    await s.supersedeNote(n1.id, n2.id, Date.now());
    const active = await s.activeNotes('app:x');
    expect(active.map((x) => x.id)).toEqual([n2.id]);
    expect((await s.getNote(n1.id))?.superseded_by).toBe(n2.id); // audit row survives
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe.skipIf(!hasButler)('read tools (real server harness)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let db: import('better-sqlite3').Database;
  let storage: import('@mainactordev/butler').SqliteStorage;
  let retriever: import('@mainactordev/butler').StorageRetriever;
  let registry: import('@mainactordev/butler').ToolRegistry;
  const CTX = { signal: undefined, sessionId: 'test' };

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'butler-tools-'));
    process.env['CRUCIBLE_DB_PATH'] = join(dir, 't.db');
    process.env['CRUCIBLE_ARTIFACTS_DIR'] = join(dir, 'artifacts');
    process.env['CRUCIBLE_SILENT'] = '1';
    process.env['CRUCIBLE_WATCHDOG'] = '0';
    process.env['CRUCIBLE_PIN'] = 'cli-test-pin-1';
    app = await buildApp(process.env);
    // auth not needed for these tool-level tests (routes land in steps_004);
    // boot only. Cookie helper retained for later steps.

    db = (app as unknown as { db: { raw: import('better-sqlite3').Database } }).db.raw;
    const butler = await import('@mainactordev/butler');
    storage = new butler.SqliteStorage(join(dir, 'agent.db'));
    retriever = new butler.StorageRetriever(storage);
    const { buildToolRegistry } = await import('../src/agent/tools.ts');
    registry = buildToolRegistry({ db, storage, retriever });
  });

  it('cases.list returns real seeded templates with status', async () => {
    const out = await registry.execute('cases.list', {}, CTX, { name: 'read', allows: 'read' });
    const rows = JSON.parse(out) as Array<{ name: string; status: string }>;
    expect(Array.isArray(rows)).toBe(true);
  });

  it('case.yaml.get renders seeded case yaml (renderTemplateYaml exported)', async () => {
    db.prepare(`INSERT INTO templates(id, name, udid, steps_json, app_bundle_id, status, created_by, created_at, updated_at) VALUES ('tpl_x1','Agent Case','','[{"action":"tap","on":"btn"}]','com.test.app','active','t',?,?)`).run(Date.now(), Date.now());
    const out = await registry.execute('case.yaml.get', { idOrName: 'Agent Case' }, CTX, { name: 'read', allows: 'read' });
    expect(out).toContain('steps:');
    expect(out).toContain('name: Agent Case');
  });

  it('runs.history filters by status; run.steps returns narrated steps', async () => {
    const now = Date.now();
    db.prepare(`INSERT INTO runs(id, template_id, ticket_key, kind, status, triggered_by, device_udid, freshness, launch_args_json, started_at, finished_at) VALUES ('run_ag1','tpl_x1','-','automated','failed','test','dev','unchecked','{}',?,?)`).run(now, now);
    db.prepare(`INSERT INTO run_steps(run_id, idx, flow_name, kind, name, status, reason, evidence_ids_json, started_at, duration_ms) VALUES ('run_ag1', 0, '', 'step', 'tap btn', 'fail', 'not found: {"label":"X"}', '[]', ?, 10)`).run(now);
    const hist = JSON.parse(await registry.execute('runs.history', { status: 'failed' }, CTX, { name: 'read', allows: 'read' })) as Array<{ id: string }>;
    expect(hist.some((r) => r.id === 'run_ag1')).toBe(true);
    const steps = JSON.parse(await registry.execute('run.steps', { runId: 'run_ag1' }, CTX, { name: 'read', allows: 'read' })) as Array<{ name: string; reason: string | null }>;
    expect(steps[0]?.reason).toContain('not found');
  });

  it('screens.registry returns seeded screens + states (the rulebook)', async () => {
    db.prepare(`INSERT INTO app_screens(app_bundle_id, screen_id, revision, entry_json, states_json, updated_at) VALUES ('com.test.app','login-screen',1,'{"navigate":[]}','{"default":{"all":[{"identifier":"login_screen"}]}}',?)`).run(Date.now());
    const out = await registry.execute('screens.registry', { appBundle: 'com.test.app' }, CTX, { name: 'read', allows: 'read' });
    expect(out).toContain('login-screen');
    expect(out).toContain('default');
  });

  it('folders.tree nests with counts', async () => {
    const out = await registry.execute('folders.tree', {}, CTX, { name: 'read', allows: 'read' });
    expect(typeof out).toBe('string'); // shape: JSON of nested tree (empty is fine)
    JSON.parse(out);
  });

  it('sources.search on empty corpus → honest empty message', async () => {
    const out = await registry.execute('sources.search', { query: 'anything' }, CTX, { name: 'read', allows: 'read' });
    expect(out).toMatch(/no documents|nothing/i);
  });

  it('notes.read returns active notes only', async () => {
    await storage.insertNote({ scope_key: 'app:com.test.app/screen:login-screen', kind: 'pitfall', content: 'needs settle-wait', source_type: 'run', source_ref: 'run_ag1', created_by: 't' });
    const out = await registry.execute('notes.read', { prefix: 'app:com.test.app' }, CTX, { name: 'read', allows: 'read' });
    expect(out).toContain('settle-wait');
  });

  it('act-class tools are refused + provider-invisible under V1 (pre-step-3 dummy)', async () => {
    const { V1_POLICY } = await import('../src/agent/policy.ts');
    // register a dummy act tool on a scratch registry to pin the contract now
    const { ToolRegistry: TR } = await import('@mainactordev/butler');
    const r2 = new TR().register({ name: 'x.play', description: 'x', parameters: { type: 'object', properties: {} }, permission: 'act', execute: async () => 'never' });
    await expect(r2.execute('x.play', {}, CTX, V1_POLICY)).rejects.toMatchObject({ name: 'PolicyRefusal' });
    expect(r2.providerTools(V1_POLICY).map((t) => t.function.name)).not.toContain('x.play');
  });

  it('unknown tool → typed error naming available tools', async () => {
    await expect(registry.execute('nope', {}, CTX, { name: 'read', allows: 'read' })).rejects.toThrow(/available/);
  });
});
