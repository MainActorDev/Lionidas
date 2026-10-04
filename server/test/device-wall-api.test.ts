import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { migrateM1 } from '../src/db/schema.ts';
import { registerDeviceRoutes, __psSweep } from '../src/routes/devices.ts';
import { registerUserResolution } from '../src/auth/roles.ts';
import { __setAlloyForTest } from '../src/alloy/client.ts';
import { initAlloyRuntime, resetAlloyRuntimeForTests } from '../src/alloy/runtime.ts';
import { hasAlloy } from './helpers/capabilities.ts';
const describeIfAlloy = describe.skipIf(!(hasAlloy()));  // wall routes touch the alloy runtime


/** Wall QoL T2 — pins, lastUsed, memoryRss, restart on the devices API. */

let tmp: string;
let db: Database.Database;
let app: FastifyInstance;
const calls: string[] = [];

/** fake alloy dispatch: logs actions, succeeds. A shutdown ack also flips
 *  the device mirror to Shutdown — mirrors async CoreSimulator state flips the
 *  restart route now WAITS for before booting (2026-10-03 race fix). */
const fakeDispatch = async (_tool: string, input: unknown): Promise<{ ok: true }> => {
  const action = String((input as { action: string }).action);
  calls.push(action);
  const udid = (input as { udid?: string }).udid;
  if (action === 'shutdown') {
    setTimeout(() => { try { db?.prepare(`UPDATE devices SET state = 'Shutdown' WHERE udid = ?`).run(udid); } catch { /* closed */ } }, 100);
  }
  if (action === 'boot') {
    try { db?.prepare(`UPDATE devices SET state = 'Booted' WHERE udid = ?`).run(udid); } catch { /* closed */ }
  }
  return { ok: true };
};

function seed(udid: string, state: string): void {
  db.prepare(`INSERT INTO devices(udid, name, state, platform, kind, last_seen) VALUES (?, 'Sim', ?, 'ios', 'simulator', 0)
              ON CONFLICT(udid) DO UPDATE SET state = excluded.state`).run(udid, state);
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'devwall-'));
  db = new Database(join(tmp, 't.db'));
  migrateM1(db);
  app = Fastify();
  registerUserResolution(app, db);
  registerDeviceRoutes(app, db);
  // fake power-state source: reads the devices table (the stub flips it on shutdown;
  // the 2026-10-03 restart fix waits on FRESH simctl state, which can't see fake udids)
  const devicesMod = await import('../src/routes/devices.ts');
  devicesMod.__setDeviceStateSourceForTest((u, cb) => {
    const row = db.prepare('SELECT state FROM devices WHERE udid = ?').get(u) as { state: string | null } | undefined;
    cb(row?.state ?? null);
  });
  calls.length = 0;
  __setAlloyForTest({
    dispatch: fakeDispatch,
    createRuntime: async () => ({ state: { resolved: true, configError: null }, deps: null }),
  } as never);
  await initAlloyRuntime(); // alloyDispatchDepsSync() needs the singleton
});

afterEach(async () => {
  const devicesMod = await import('../src/routes/devices.ts');
  devicesMod.__setDeviceStateSourceForTest(null);
  app.close();
  db.close();
  rmSync(tmp, { recursive: true, force: true });
  __setAlloyForTest(null);
  resetAlloyRuntimeForTests();
});

const UDID_A = '11111111-2222-3333-4444-555555555555';
const UDID_B = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describeIfAlloy('T2 — pins', () => {
  it('PUT/DELETE pin toggles per user; GET reflects only own pins', async () => {
    seed(UDID_A, 'Shutdown');
    db.prepare("INSERT INTO users(id, email, name, role, active, approved, created_at) VALUES ('usr_1','a@x','a','viewer',1,1,0)").run();
    db.prepare("INSERT INTO users(id, email, name, role, active, approved, created_at) VALUES ('usr_2','b@x','b','viewer',1,1,0)").run();
    const s1 = db.prepare('SELECT id FROM sessions LIMIT 1'); // unused; sessions created via helper below
    void s1;
    // fake sessions by direct row — id must match the 64-hex session cookie shape
    db.prepare('INSERT INTO sessions(id, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)').run('c1'.repeat(32), 'usr_1', Date.now(), Date.now() + 3_600_000, Date.now());
    db.prepare('INSERT INTO sessions(id, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)').run('c2'.repeat(32), 'usr_2', Date.now(), Date.now() + 3_600_000, Date.now());

    let r = await app.inject({ method: 'PUT', url: `/api/devices/${UDID_A}/pin`, headers: { cookie: `crucible_session=${'c1'.repeat(32)}` } });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { pinned: boolean }).pinned).toBe(true);

    r = await app.inject({ method: 'GET', url: '/api/devices', headers: { cookie: `crucible_session=${'c1'.repeat(32)}` } });
    const as1 = (r.json() as { devices: Array<{ udid: string; pinned: boolean }> }).devices.find((d) => d.udid === UDID_A);
    expect(as1?.pinned).toBe(true);

    r = await app.inject({ method: 'GET', url: '/api/devices', headers: { cookie: `crucible_session=${'c2'.repeat(32)}` } });
    const as2 = (r.json() as { devices: Array<{ udid: string; pinned: boolean }> }).devices.find((d) => d.udid === UDID_A);
    expect(as2?.pinned).toBe(false); // per-account isolation

    r = await app.inject({ method: 'DELETE', url: `/api/devices/${UDID_A}/pin`, headers: { cookie: `crucible_session=${'c1'.repeat(32)}` } });
    expect((r.json() as { pinned: boolean }).pinned).toBe(false);
    r = await app.inject({ method: 'GET', url: '/api/devices', headers: { cookie: `crucible_session=${'c1'.repeat(32)}` } });
    expect((r.json() as { devices: Array<{ pinned: boolean }> }).devices[0]!.pinned).toBe(false);
  });

  it('anonymous pin toggle is 401', async () => {
    seed(UDID_A, 'Shutdown');
    const r = await app.inject({ method: 'PUT', url: `/api/devices/${UDID_A}/pin` });
    expect(r.statusCode).toBe(401);
  });
});

describeIfAlloy('T2 — lastUsed (runs ∪ manual_sessions, null = never)', () => {
  it('unions both sources; never-used devices carry null', async () => {
    seed(UDID_A, 'Shutdown');
    seed(UDID_B, 'Shutdown');
    db.prepare("INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at, finished_at) VALUES ('r1','T','manual','passed','qa',?,1000,NULL)").run(UDID_A);
    db.prepare("INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at, finished_at) VALUES ('r0','T','manual','passed','qa',?,900,NULL)").run(UDID_B);
    db.prepare("INSERT INTO manual_sessions(id, run_id, udid, operator, started_at, last_activity) VALUES ('ms1','r0',?,'op',2000,2000)").run(UDID_B);
    const r = await app.inject({ method: 'GET', url: '/api/devices' });
    const ds = (r.json() as { devices: Array<{ udid: string; lastUsed: number | null }> }).devices;
    expect(ds.find((d) => d.udid === UDID_A)?.lastUsed).toBe(1000);
    expect(ds.find((d) => d.udid === UDID_B)?.lastUsed).toBe(2000);
    // fresh device, neither source → null
    seed('ffffffff-0000-0000-0000-000000000000', 'Shutdown');
    const r2 = await app.inject({ method: 'GET', url: '/api/devices' });
    expect((r2.json() as { devices: Array<{ udid: string; lastUsed: number | null }> }).devices.find((d) => d.udid === 'ffffffff-0000-0000-0000-000000000000')?.lastUsed).toBeNull();
  });
});

describeIfAlloy('T2 — memoryRss (booted only, one sweep)', () => {
  it('sums every process referencing the udid; non-booted rows null', async () => {
    seed(UDID_A, 'Booted');
    seed(UDID_B, 'Shutdown');
    __psSweep.fn = () => [
      { rss: 1024, command: `/sim/Devices/${UDID_A}/data` },
      { rss: 2048, command: `xcodebuild -id ${UDID_A} bridge` },
      { rss: 512, command: 'unrelated process' },
    ];
    const r = await app.inject({ method: 'GET', url: '/api/devices' });
    const ds = (r.json() as { devices: Array<{ udid: string; memoryRss: number | null }> }).devices;
    expect(ds.find((d) => d.udid === UDID_A)?.memoryRss).toBe(3 * 1024 * 1024); // (1024+2048) KiB → bytes
    expect(ds.find((d) => d.udid === UDID_B)?.memoryRss).toBeNull();
  });

  it('booted device with no matching process reports 0, not null', async () => {
    seed(UDID_A, 'Booted');
    __psSweep.fn = () => [];
    const r = await app.inject({ method: 'GET', url: '/api/devices' });
    expect((r.json() as { devices: Array<{ memoryRss: number | null }> }).devices[0]!.memoryRss).toBe(0);
  });
});

describeIfAlloy('T2 — restart action', () => {
  it('runs shutdown then boot as one request; guards apply once', async () => {
    seed(UDID_A, 'Booted');
    const r = await app.inject({ method: 'POST', url: `/api/devices/${UDID_A}/power`, payload: { action: 'restart' } });
    expect(r.statusCode).toBe(200);
    expect(calls).toEqual(['shutdown', 'boot']);
  });

  it('shutdown failure surfaces and boot never fires', async () => {
    seed(UDID_A, 'Booted');
    __setAlloyForTest({ dispatch: async (_t: string, input: unknown) =>
      String((input as { action: string }).action) === 'shutdown'
        ? { ok: false as const, error: { message: 'engine wedged' } }
        : { ok: true as const } } as never);
    const r = await app.inject({ method: 'POST', url: `/api/devices/${UDID_A}/power`, payload: { action: 'restart' } });
    expect(r.statusCode).toBe(502);
    expect((r.json() as { error: string }).error).toContain('engine wedged');
  });

  it('an active run blocks restart (guard)', async () => {
    seed(UDID_A, 'Booted');
    db.prepare("INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at, finished_at) VALUES ('r9','T','manual','running','qa',?,NULL,NULL)").run(UDID_A);
    const r = await app.inject({ method: 'POST', url: `/api/devices/${UDID_A}/power`, payload: { action: 'restart' } });
    expect(r.statusCode).toBe(409);
    expect(calls).toEqual([]);
  });
});
