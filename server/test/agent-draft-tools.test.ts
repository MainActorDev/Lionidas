import { describe, expect, it, beforeAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/index.ts';

/** Breakdown steps_003: draft tools through the REAL validator → REAL draft
 *  templates; 409s verbatim (F4); act tools refused + provider-invisible. */

const hasButler = (() => { try { require.resolve('@mainactordev/butler'); return true; } catch { return false; } })();

const VALID_YAML = `name: Agent Draft Case
app: com.test.app
steps:
  - tap: { on: btn_submit }
    narrate: When I tap submit
  - expect screen: login-screen.default
    narrate: Then the login screen holds
`;

describe.skipIf(!hasButler)('draft tools (real validator, real templates)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let db: import('better-sqlite3').Database;
  let registry: import('@mainactordev/butler').ToolRegistry;
  let storage: import('@mainactordev/butler').SqliteStorage;
  const DRAFT = { name: 'draft', allows: 'draft' as const };
  const CTX = { signal: undefined, sessionId: 'test' };

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'butler-draft-'));
    process.env['CRUCIBLE_DB_PATH'] = join(dir, 't.db');
    process.env['CRUCIBLE_ARTIFACTS_DIR'] = join(dir, 'artifacts');
    process.env['CRUCIBLE_SILENT'] = '1';
    process.env['CRUCIBLE_WATCHDOG'] = '0';
    process.env['CRUCIBLE_PIN'] = 'cli-test-pin-1';
    app = await buildApp(process.env);
    db = (app as unknown as { db: { raw: import('better-sqlite3').Database } }).db.raw;
    const butler = await import('@mainactordev/butler');
    storage = new butler.SqliteStorage(join(dir, 'agent.db'));
    const retriever = new butler.StorageRetriever(storage);
    const { buildToolRegistry } = await import('../src/agent/tools.ts');
    const { registerDraftTools } = await import('../src/agent/draft-tools.ts');
    registry = buildToolRegistry({ db, storage, retriever, artifactsDir: process.env['CRUCIBLE_ARTIFACTS_DIR']! });
    registerDraftTools({ db, storage, retriever, registry, artifactsDir: process.env['CRUCIBLE_ARTIFACTS_DIR']! });
    // seed the screen the valid yaml references
    db.prepare(`INSERT INTO app_screens(app_bundle_id, screen_id, revision, entry_json, states_json, updated_at) VALUES ('com.test.app','login-screen',1,'{"navigate":[]}','{"default":{"all":[{"identifier":"login_screen"}]}}',?)`).run(Date.now());
  });

  it('case.draft.save: valid yaml → REAL draft template row', async () => {
    const out = await registry.execute('case.draft.save', { yaml: VALID_YAML }, CTX, DRAFT);
    const parsed = JSON.parse(out) as { templateId: string; status: string; name: string };
    expect(parsed.status).toBe('draft');
    const row = db.prepare('SELECT id, name, status, steps_json FROM templates WHERE id = ?').get(parsed.templateId) as { status: string; steps_json: string };
    expect(row.status).toBe('draft'); // the real lifecycle, no shadow store
    expect(row.steps_json).toContain('btn_submit');
  });

  it('invalid yaml → validator errors VERBATIM; NO template created', async () => {
    const before = (db.prepare('SELECT COUNT(*) n FROM templates').get() as { n: number }).n;
    const out = await registry.execute('case.draft.save', { yaml: 'name: Bad\nsteps:\n  - frobnicate: {}\n' }, CTX, DRAFT);
    expect(out).toMatch(/^INVALID:/);
    expect(out).toMatch(/frobnicate|unknown|step/i);
    const after = (db.prepare('SELECT COUNT(*) n FROM templates').get() as { n: number }).n;
    expect(after).toBe(before); // nothing half-written
  });

  it('expect of unknown screen → refs error verbatim (registry consulted)', async () => {
    const out = await registry.execute('case.draft.save', { yaml: 'name: Ref Miss\napp: com.test.app\nsteps:\n  - expect screen: no-such-screen.anything\n' }, CTX, DRAFT);
    expect(out).toMatch(/^INVALID:/);
    expect(out).toContain('no-such-screen');
  });

  it('name collision → 409 semantics verbatim; second save of the same yaml fails', async () => {
    await registry.execute('case.draft.save', { yaml: VALID_YAML }, CTX, DRAFT); // ensure exists (collides with test 1's name)
    const out = await registry.execute('case.draft.save', { yaml: VALID_YAML }, CTX, DRAFT);
    expect(out).toContain('already exists');
  });

  it('app-change while foldered → verbatim folder 409 (F4)', async () => {
    // seed a foldered case, then edit changing its app
    const fid = 'fld_t9';
    db.prepare(`INSERT INTO folders(id, app_bundle_id, parent_id, name, created_by, created_at, updated_at) VALUES (?, 'com.test.app', NULL, 't9', 't', ?, ?)`).run(fid, Date.now(), Date.now());
    db.prepare(`INSERT INTO templates(id, name, udid, steps_json, app_bundle_id, status, folder_id, created_by, created_at, updated_at) VALUES ('tpl_t9','Foldered Case','','[]','com.test.app','active',?,'t',?,?)`).run(fid, Date.now(), Date.now());
    const out = await registry.execute('case.draft.edit', { idOrName: 'Foldered Case', yaml: 'name: Foldered Case\napp: com.other.app\nsteps:\n  - tap: { on: x }\n' }, CTX, DRAFT);
    expect(out).toContain('move it out before changing its app');
  });

  it('case.draft.edit: valid edit updates the row', async () => {
    const out = await registry.execute('case.draft.edit', { idOrName: 'Agent Draft Case', yaml: VALID_YAML.replace('btn_submit', 'btn_v2') }, CTX, DRAFT);
    const parsed = JSON.parse(out) as { status: string };
    expect(parsed.status).toBe('updated');
    const row = db.prepare('SELECT steps_json FROM templates WHERE name = ?').get('Agent Draft Case') as { steps_json: string };
    expect(row.steps_json).toContain('btn_v2');
  });

  it('note.save: provenance mandatory; scope keys preserved', async () => {
    const ok = await registry.execute('note.save', { scopeKey: 'app:com.test.app/screen:login-screen', kind: 'pitfall', content: 'settle-wait before submit', sourceRef: 'run_1' }, CTX, DRAFT);
    expect(ok).toMatch(/^note /);
    const notes = await storage.activeNotes('app:com.test.app');
    expect(notes.some((n) => n.content.includes('settle-wait'))).toBe(true);
  });

  it('ACT tools refused + provider-invisible under V1 policy', async () => {
    const { V1_POLICY } = await import('../src/agent/policy.ts');
    for (const name of ['case.play', 'run.abort', 'device.power']) {
      const err = await registry.execute(name, { idOrName: 'x' }, CTX, V1_POLICY).catch((e: unknown) => e);
      expect(err).toMatchObject({ name: 'PolicyRefusal', permission: 'act' });
    }
    const visible = registry.providerTools(V1_POLICY).map((t) => t.function.name);
    expect(visible).toContain('case.draft.save');
    expect(visible).not.toContain('case.play');
    expect(visible).not.toContain('device.power');
  });

  it('sources.ingest (file) → documents + chunks registered; sources.search finds them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'butler-src-'));
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dir, 'QA-777.md'), '# QA-777 Checkout crash\n## Requirement\ntapping pay crashes on iPad\n## Acceptance\n- Given cart, when pay is tapped, then checkout screen shows\n');
    const out = await registry.execute('sources.ingest', { kind: 'file', root: dir }, CTX, DRAFT);
    const parsed = JSON.parse(out) as { documents: Array<{ uri: string; chunks: number }> };
    expect(parsed.documents.some((d) => d.uri.includes('QA-777') && d.chunks > 0)).toBe(true);
    const hit = await registry.execute('sources.search', { query: 'checkout crash pay iPad' }, CTX, DRAFT);
    expect(hit).toContain('QA-777');
    rmSync(dir, { recursive: true, force: true });
  });
});
