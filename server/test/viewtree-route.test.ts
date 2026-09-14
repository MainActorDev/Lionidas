/** Viewtree route tests — guards + happy path, all through the injected
 *  seams (no device, no real lldb). */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/index.ts';
import { __setViewtreeForTest } from '../src/manual/viewtree.ts';
import { migrateM1 } from '../src/db/schema.ts';

let db: Database.Database;
let tmp: string;
let app: Awaited<ReturnType<typeof buildApp>>;

const fixture = readFileSync(new URL('./fixtures/viewtree/lp-home/recdesc.txt', import.meta.url), 'utf8');

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'crucible-vt-'));
  const dbPath = join(tmp, 't.db');
  db = new Database(dbPath); // same file the app opens — migrate BEFORE buildApp so route guards find tables
  db.pragma('journal_mode = WAL');
  migrateM1(db);
  app = await buildApp({ CRUCIBLE_REQUIRE_AUTH: '0', CRUCIBLE_DB_PATH: dbPath, CRUCIBLE_ARTIFACTS_DIR: tmp, VITEST: 'true' });
  await app.app.ready();
});
afterEach(async () => {
  __setViewtreeForTest(null);
  await app.close();
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const mkSession = (udid: string, bundle: string | null = 'com.x.app'): string => {
  // mirror startManualSession: a manual session carries a parent runs row
  // (kind='manual', status='running') — the guard must NOT count it as busy
  const runId = `run_m${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at) VALUES (?, 'MANUAL', 'manual', 'running', 'qa', ?, ?)`).run(runId, udid, Date.now());
  const id = `ms_${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(`INSERT INTO manual_sessions(id, run_id, udid, operator, started_at, last_activity, app_bundle_id) VALUES (?, ?, ?, 'qa', ?, ?, ?)`).run(id, runId, udid, Date.now(), Date.now(), bundle);
  return id;
};
const mkDevice = (udid: string, platform = 'ios', kind = 'simulator'): void => {
  db.prepare(`INSERT INTO devices(udid, name, state, platform, kind, last_seen) VALUES (?, 'Dev', 'Booted', ?, ?, ?)`).run(udid, platform, kind, Date.now());
};

describe('POST /api/manual/:id/viewtree', () => {
  it('happy path: parses the fixture, returns nodes + pausedMs + pid', async () => {
    mkDevice('sim-vt1');
    const sid = mkSession('sim-vt1');
    __setViewtreeForTest({ resolvePid: async () => ({ pid: 4242, label: 'UIKitApplication:com.x.app[4242]' }), lldb: async () => fixture });
    const r = await app.app.inject({ method: 'POST', url: `/api/manual/${sid}/viewtree` });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { nodes: Array<{ viewClass: string }>; pausedMs: number; pid: number };
    expect(body.pid).toBe(4242);
    expect(body.nodes.length).toBeGreaterThan(300);
    expect(body.nodes.some((n) => n.viewClass === 'UITabBar')).toBe(true);
    expect(body.pausedMs).toBeGreaterThanOrEqual(0);
  });

  it('409 when a queued/running AUTOMATED run holds the device', async () => {
    mkDevice('sim-vt2');
    const sid = mkSession('sim-vt2');
    db.prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at) VALUES ('run_vt1', 'T-1', 'automated', 'running', 'ci', 'sim-vt2', ?)`).run(Date.now());
    const r = await app.app.inject({ method: 'POST', url: `/api/manual/${sid}/viewtree` });
    expect(r.statusCode).toBe(409);
    expect((r.json() as { code: string }).code).toBe('DEVICE_BUSY');
  });

  it('422 for non-simulator devices', async () => {
    mkDevice('phys-1', 'ios', 'physical');
    const sid = mkSession('phys-1');
    const r = await app.app.inject({ method: 'POST', url: `/api/manual/${sid}/viewtree` });
    expect(r.statusCode).toBe(422);
    expect((r.json() as { code: string }).code).toBe('NOT_SIM');
  });

  it('410 for dead session', async () => {
    const r = await app.app.inject({ method: 'POST', url: '/api/manual/ms_nope/viewtree' });
    expect(r.statusCode).toBe(410);
  });

  it('502 PARSE when lldb returns garbage (honest error, no partial tree)', async () => {
    mkDevice('sim-vt3');
    const sid = mkSession('sim-vt3');
    __setViewtreeForTest({ resolvePid: async () => ({ pid: 1, label: 'x' }), lldb: async () => 'garbage output no tree' });
    const r = await app.app.inject({ method: 'POST', url: `/api/manual/${sid}/viewtree` });
    expect(r.statusCode).toBe(502);
    expect((r.json() as { code: string }).code).toBe('LLDB_FAILED');
  });

  it('serializes concurrent dumps per device (second gets DEVICE_BUSY 409)', async () => {
    mkDevice('sim-vt4');
    const sid = mkSession('sim-vt4');
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    __setViewtreeForTest({
      resolvePid: async () => ({ pid: 9, label: 'x' }),
      lldb: async () => { await gate; return fixture; },
    });
    const first = app.app.inject({ method: 'POST', url: `/api/manual/${sid}/viewtree` });
    await new Promise((r) => setTimeout(r, 30));
    const second = await app.app.inject({ method: 'POST', url: `/api/manual/${sid}/viewtree` });
    expect(second.statusCode).toBe(409);
    release();
    expect((await first).statusCode).toBe(200);
  });
});
