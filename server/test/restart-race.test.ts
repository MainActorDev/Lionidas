import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { registerDeviceRoutes } from '../src/routes/devices.ts';

/** restart = shutdown + WAIT for the mirror to leave Booted + boot. The old
 *  code fired boot immediately after the shutdown ack — engine-A's ensure-boot
 *  read the still-Booted mirror state and no-opped, leaving the device dead
 *  after "ok:true" (found live 2026-10-03). */

function makeDb(withDevice = true): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE devices (udid TEXT PRIMARY KEY, name TEXT, kind TEXT, state TEXT, platform TEXT, os_version TEXT, resolution TEXT, lease_holder TEXT, lease_engine TEXT, last_seen INTEGER);
           CREATE TABLE device_pins (user_id TEXT, udid TEXT, pinned_at INTEGER);
           CREATE TABLE runs (id TEXT PRIMARY KEY, ticket_key TEXT, kind TEXT, status TEXT, triggered_by TEXT, device_udid TEXT, started_at INTEGER, finished_at INTEGER, note TEXT);
           CREATE TABLE manual_sessions (id TEXT PRIMARY KEY, run_id TEXT, udid TEXT, operator TEXT, logical_w INTEGER, logical_h INTEGER, started_at INTEGER, last_activity INTEGER, finished_at INTEGER, app_bundle_id TEXT, recording_json TEXT);`);
  if (withDevice) db.prepare(`INSERT INTO devices (udid, name, kind, state, platform, os_version, last_seen) VALUES ('SIM-R', 'iPhone R', 'simulator', 'Booted', 'ios', '26.4', ?)`).run(Date.now());
  return db;
}

const calls: Array<{ action: string }> = [];

async function build(opts?: { failBoot?: boolean; neverFlip?: boolean }) {
  const { __setAlloyForTest } = await import('../src/alloy/client.ts');
  const db = makeDb();
  const app = Fastify();
  app.addHook('onRequest', async (req: import('fastify').FastifyRequest) => { (req as unknown as { user: unknown }).user = { name: 't', role: 'operator' }; });
  const routesMod = await import('../src/routes/devices.ts');
  // fake state source: SIM-R reports the DB mirror's state (the stub flips it on shutdown);
  // after a successful boot dispatch, report Booted (engine said booted:true)
  routesMod.__setDeviceStateSourceForTest((u, cb) => {
    const row = db.prepare('SELECT state FROM devices WHERE udid = ?').get(u) as { state: string | null } | undefined;
    cb(row?.state ?? null);
  });
  // boot success in the stub → mark the mirror Booted (engine's ensure-boot really boots)
  __setAlloyForTest({
    createRuntime: async () => ({ state: { resolved: {}, configError: null, health: {}, leases: {} }, deps: {} }),
    dispatch: async (_tool: string, input: { action: string }) => {
      if (input.action === 'shutdown') {
        calls.push({ action: 'shutdown' });
        if (!opts?.neverFlip) setTimeout(() => db.prepare(`UPDATE devices SET state = 'Shutdown' WHERE udid = 'SIM-R'`).run(), 1500);
        return { ok: true };
      }
      if (input.action === 'boot') {
        calls.push({ action: 'boot' });
        if (opts?.failBoot) return { ok: false, error: { message: 'boom' } };
        db.prepare(`UPDATE devices SET state = 'Booted' WHERE udid = 'SIM-R'`).run();
        return { ok: true };
      }
      return { ok: true, result: { devices: [] } };
    },
  } as never);
  const { initAlloyRuntime } = await import('../src/alloy/runtime.ts');
  await initAlloyRuntime();
  routesMod.registerDeviceRoutes(app, db);
  await app.ready();
  return { app, db, __setAlloyForTest };
}

describe('POST /api/devices/:udid/power restart', () => {
  it('waits for the mirror to leave Booted before booting', async () => {
    calls.length = 0;
    const { app, db, __setAlloyForTest } = await build();
    const r = await app.inject({ method: 'POST', url: '/api/devices/SIM-R/power', payload: { action: 'restart' } });
    expect(r.statusCode).toBe(200);
    expect(calls.map((c) => c.action)).toEqual(['shutdown', 'boot']);
    // restart completed: shutdown landed (mirror flipped at ~1.5s, boot came AFTER —
    // asserted by call order) and the boot brought the device back to Booted
    const state = db.prepare('SELECT state FROM devices WHERE udid = ?').get('SIM-R') as { state: string };
    expect(state.state).toBe('Booted');
    await app.close(); db.close(); __setAlloyForTest(null);
  }, 30_000);

  it('GET /api/devices flags restarting:true while the cycle runs', async () => {
    calls.length = 0;
    const { app, db, __setAlloyForTest } = await build({ neverFlip: true });
    // fire the restart but don't await — the cycle is held open (neverFlip)
    const inflight = app.inject({ method: 'POST', url: '/api/devices/SIM-R/power', payload: { action: 'restart' } });
    await new Promise((r) => setTimeout(r, 300));
    const list = await app.inject({ method: 'GET', url: '/api/devices' });
    const row = ((list.json() as { devices: Array<{ udid: string; restarting: boolean }> }).devices ?? []).find((x) => x.udid === 'SIM-R');
    expect(row?.restarting).toBe(true);
    await inflight; // completes with 502 (never reached Shutdown)
    const list2 = await app.inject({ method: 'GET', url: '/api/devices' });
    const row2 = ((list2.json() as { devices: Array<{ udid: string; restarting: boolean }> }).devices ?? []).find((x) => x.udid === 'SIM-R');
    expect(row2?.restarting).toBe(false);
    await app.close(); db.close(); __setAlloyForTest(null);
  }, 60_000);

  it('502 when the device never reaches Shutdown (no silent dead device)', async () => {
    calls.length = 0;
    const { app, db, __setAlloyForTest } = await build({ neverFlip: true });
    const r = await app.inject({ method: 'POST', url: '/api/devices/SIM-R/power', payload: { action: 'restart' } });
    expect(r.statusCode).toBe(502);
    expect((r.json() as { error: string }).error).toMatch(/never reached Shutdown/);
    expect(calls.map((c) => c.action)).toEqual(['shutdown']);
    await app.close(); db.close(); __setAlloyForTest(null);
  }, 60_000);
});
