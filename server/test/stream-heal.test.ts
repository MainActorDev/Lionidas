import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { migrateM1 } from '../src/db/schema.ts';
import { registerDeviceRoutes } from '../src/routes/devices.ts';
import { __setAlloyForTest, type AlloyExports } from '../src/alloy/client.ts';
import { __setSimdeckEnsureForTest } from '../src/simdeck/supervisor.ts';

const U = 'SIM-HEAL-1';

let db: Database.Database;
let app: FastifyInstance;
let releaseCalls: number;
let streamCalls: number;
let shutdownCalls: number;

/** Alloy fake: stream fails claim-class until released; shutdown fails claim-class until released. */
function fakeAlloy(opts: { failStream?: boolean; failShutdown?: boolean }): AlloyExports {
  releaseCalls = 0; streamCalls = 0; shutdownCalls = 0;
  let released = false;
  return {
    createRuntime: async () => ({ state: {}, deps: null }),
    dispatch: async (tool: string, input: unknown) => {
      const i = input as { action?: string; udid?: string };
      if (tool === 'alloy_release') { releaseCalls += 1; released = true; return { ok: true, result: {} }; }
      if (tool === 'alloy_stream') {
        streamCalls += 1;
        if (opts.failStream && !released) return { ok: false, error: { message: 'ios device SIM-HEAL-1 is owned by session "alloy-simheal1" in workspace "…".', code: 'DEVICE_IN_USE' } };
        return { ok: true, result: { streamUrl: 'http://127.0.0.1:1/stream.mjpeg', platform: 'ios' } };
      }
      if (tool === 'alloy_devices' && i?.action === 'shutdown') {
        shutdownCalls += 1;
        if (opts.failShutdown && !released) return { ok: false, error: { message: 'Cannot shut down an active session device directly.' } };
        return { ok: true };
      }
      return { ok: true, result: {} };
    },
  } as unknown as AlloyExports;
}

import { initAlloyRuntime, resetAlloyRuntimeForTests } from '../src/alloy/runtime.ts';
import { hasAlloy } from './helpers/capabilities.ts';
const describeIfAlloy = describe.skipIf(!(hasAlloy()));  // heal paths init the alloy runtime

beforeEach(async () => {
  db = new Database(':memory:');
  migrateM1(db);
  db.prepare(`INSERT INTO devices(udid, name, state, platform, kind, last_seen) VALUES (?, 'Heal Sim', 'Booted', 'ios', 'simulator', 0)`).run(U);
  __setAlloyForTest(fakeAlloy({})); // placeholder so initAlloyRuntime can resolve createRuntime
  await initAlloyRuntime();         // alloyDispatchDepsSync() needs the singleton
  app = Fastify();
  registerDeviceRoutes(app, db);
  await app.ready();
});
afterEach(async () => {
  __setAlloyForTest(null);
  resetAlloyRuntimeForTests();
  await app.close();
  db.close();
});

describeIfAlloy('stream route (simdeck contract — no fallback)', () => {
  it('engine healthy → 200 + engine WS URL', async () => {
    __setSimdeckEnsureForTest(async () => 8422);
    try {
      const r = await app.inject({ method: 'POST', url: `/api/devices/${U}/stream` });
      expect(r.statusCode).toBe(200);
      expect((r.json() as { simdeckUrl: string }).simdeckUrl).toBe(`/simdeck/simulators/${U}`);
    } finally {
      __setSimdeckEnsureForTest(null);
    }
  });

  it('engine down → 503, NO alloy release attempted (engine owns streaming now)', async () => {
    let releaseAttempted = false;
    __setAlloyForTest({
      createRuntime: async () => ({ state: {}, deps: null }),
      dispatch: async (tool: string) => {
        if (tool === 'alloy_release') releaseAttempted = true;
        return { ok: true, result: {} };
      },
    } as unknown as AlloyExports);
    __setSimdeckEnsureForTest(() => Promise.reject(new Error('simdeck did not become healthy in 15s')));
    try {
      const r = await app.inject({ method: 'POST', url: `/api/devices/${U}/stream` });
      expect(r.statusCode).toBe(503);
      expect((r.json() as { retryable?: boolean }).retryable).toBe(true);
      expect(releaseAttempted).toBe(false);
    } finally {
      __setSimdeckEnsureForTest(null);
    }
  });

  it('binary missing → 503 permanent (retryable=false)', async () => {
    __setSimdeckEnsureForTest(() => Promise.reject(new Error('simdeck binary not found: /x (build the sibling project)')));
    try {
      const r = await app.inject({ method: 'POST', url: `/api/devices/${U}/stream` });
      expect(r.statusCode).toBe(503);
      expect((r.json() as { retryable?: boolean }).retryable).toBe(false);
    } finally {
      __setSimdeckEnsureForTest(null);
    }
  });
});

describeIfAlloy('power route boot is headless (ENGINE-A-CLI opt-in)', () => {
  it('boot dispatch carries headless:true; shutdown does not', async () => {
    const bootInputs: Array<Record<string, unknown>> = [];
    __setAlloyForTest({
      createRuntime: async () => ({ state: {}, deps: null }),
      dispatch: async (tool: string, input: unknown) => {
        if (tool === 'alloy_devices') {
          const i = input as { action?: string };
          if (i?.action === 'boot') bootInputs.push(input as Record<string, unknown>);
        }
        return { ok: true, result: {} };
      },
    } as unknown as AlloyExports);
    const boot = await app.inject({ method: 'POST', url: `/api/devices/${U}/power`, payload: { action: 'boot' } });
    expect(boot.statusCode).toBe(200);
    expect(bootInputs).toEqual([{ action: 'boot', udid: U, headless: true }]);
    const shutdown = await app.inject({ method: 'POST', url: `/api/devices/${U}/power`, payload: { action: 'shutdown' } });
    expect(shutdown.statusCode).toBe(200);
    // no NEW boot input recorded after the shutdown call
    expect(bootInputs).toHaveLength(1);
  });
});

describeIfAlloy('power route shutdown heal (74e0bf4 BACKFILL — shipped untested)', () => {
  it('DEVICE_IN_USE + no active run → release + retry → shutdown succeeds', async () => {
    __setAlloyForTest(fakeAlloy({ failShutdown: true }));
    const r = await app.inject({ method: 'POST', url: `/api/devices/${U}/power`, payload: { action: 'shutdown' } });
    expect(r.statusCode).toBe(200);
    expect(releaseCalls).toBe(1);
    expect(shutdownCalls).toBe(2);
  });

  it('DEVICE_IN_USE + active run → NO release, honest failure', async () => {
    __setAlloyForTest(fakeAlloy({ failShutdown: true }));
    db.prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at)
                VALUES ('run_h2', 'T', 'manual', 'running', 'qa', ?, 0)`).run(U);
    const r = await app.inject({ method: 'POST', url: `/api/devices/${U}/power`, payload: { action: 'shutdown' } });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(releaseCalls).toBe(0);
  });
});
