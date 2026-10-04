import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Suite play must resolve at QUEUE time (awaitSettle:false): the HTTP
 *  response carries batchId + count while runs are still executing — the
 *  cockpit modal must not hang for the whole suite (operator 2026-10-04).
 *  The pool is stubbed at runOne: each "run" resolves done after 30s, so a
 *  settle-time response would time out the request. */

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE templates (id TEXT PRIMARY KEY, name TEXT, status TEXT, app_bundle_id TEXT, updated_at INTEGER, updated_by TEXT, created_by TEXT, created_at INTEGER, description TEXT, ticket_key TEXT, steps_json TEXT, setup_json TEXT, alerts_policy TEXT, tags_json TEXT, default_preset_id TEXT, udid TEXT, logical_w INTEGER, logical_h INTEGER, variants_json TEXT, folder_id TEXT);
           CREATE TABLE suites (id TEXT PRIMARY KEY, name TEXT, description TEXT, app_bundle_id TEXT, created_by TEXT, created_at INTEGER, updated_at INTEGER);
           CREATE TABLE suite_members (suite_id TEXT, template_id TEXT, variant_ids_json TEXT, position INTEGER);
           CREATE TABLE runs (id TEXT PRIMARY KEY, ticket_key TEXT, kind TEXT, status TEXT, triggered_by TEXT, device_udid TEXT, started_at INTEGER, finished_at INTEGER, note TEXT, template_id TEXT);
           CREATE TABLE devices (udid TEXT PRIMARY KEY, name TEXT, state TEXT, platform TEXT, kind TEXT, os_version TEXT, resolution TEXT, lease_holder TEXT, lease_engine TEXT, last_seen INTEGER);
           INSERT INTO devices (udid, name, state, platform, kind, last_seen) VALUES ('SIM-Q', 'iPhone Q', 'Booted', 'ios', 'simulator', 0);`);
  db.prepare(`INSERT INTO templates (id, name, status, steps_json, updated_at, created_at) VALUES ('tpl_a', 'case a', 'active', '[]', 0, 0)`).run();
  db.prepare(`INSERT INTO suites (id, name, created_at, updated_at) VALUES ('suite_q', 'queue suite', 0, 0)`).run();
  db.prepare(`INSERT INTO suite_members (suite_id, template_id, position) VALUES ('suite_q', 'tpl_a', 0)`).run();
  return db;
}

describe('POST /api/suites/:id/play — queue-time response', () => {
  it('resolves immediately with batchId while the batch still executes', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'suiteq-'));
    const db = makeDb();
    const app = Fastify();
    app.addHook('onRequest', async (req: import('fastify').FastifyRequest) => { (req as unknown as { user: unknown }).user = { name: 't', role: 'operator' }; });
    const { registerManualRoutes } = await import('../src/routes/manual.ts');
    registerManualRoutes(app, db, {
      bus: { emit: () => undefined, on: () => () => undefined } as never,
      dispatchDeps: {},
      artifactsDir: tmp,
    } as never);
    // stub the alloy seam: template playback never starts (runs stall) — a
    // settle-time response would never arrive
    const { __setAlloyForTest } = await import('../src/alloy/client.ts');
    __setAlloyForTest({
      createRuntime: async () => ({ state: { resolved: {}, configError: null, health: {}, leases: {} }, deps: {} }),
      dispatch: async () => new Promise(() => undefined), // never resolves
    } as never);
    const { initAlloyRuntime } = await import('../src/alloy/runtime.ts');
    await initAlloyRuntime();

    const t0 = Date.now();
    const r = await app.inject({ method: 'POST', url: '/api/suites/suite_q/play', payload: { udid: 'SIM-Q' } });
    const ms = Date.now() - t0;
    expect(r.statusCode).toBe(200);
    const body = r.json() as { batchId?: string; count?: number; runIds?: string[] };
    expect(body.batchId).toMatch(/^batch_/);
    expect(body.count).toBe(1);
    expect(ms).toBeLessThan(5000); // queue-time, not settle-time

    await app.close(); db.close(); rmSync(tmp, { recursive: true, force: true }); __setAlloyForTest(null);
  }, 20_000);
});
