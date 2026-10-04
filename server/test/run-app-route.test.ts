import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { registerManualRoutes } from '../src/routes/manual.ts';
import { __setAlloyForTest } from '../src/alloy/client.ts';

/** app → run app: POST /api/devices/:udid/apps/:bundleId/launch —
 *  terminate-first (best effort) then alloy_apps open, mirroring the
 *  playback readiness contract. The alloy seam is faked (no engine in unit
 *  scope); simctl terminate is best-effort so it isn't stubbed. */

const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE manual_sessions (id TEXT PRIMARY KEY, run_id TEXT, udid TEXT, operator TEXT, logical_w INTEGER, logical_h INTEGER, started_at INTEGER, last_activity INTEGER, finished_at INTEGER, app_bundle_id TEXT, recording_json TEXT);
    CREATE TABLE runs (id TEXT PRIMARY KEY, ticket_key TEXT, kind TEXT, status TEXT, triggered_by TEXT, device_udid TEXT, started_at INTEGER, finished_at INTEGER, note TEXT);
  `);
  return db;
}

describe('run app route', () => {
  let app: ReturnType<typeof Fastify>;
  let db: Database.Database;

  beforeEach(async () => {
    calls.length = 0;
    __setAlloyForTest({
      dispatch: async (tool: string, input: Record<string, unknown>) => {
        calls.push({ tool, input });
        if ((input as { __failOpen?: boolean }).__failOpen) return { ok: false, error: { code: 'BOOM', message: 'open failed (boom)' } };
        return { ok: true, result: {} };
      },
    } as never);
    db = freshDb();
    app = Fastify();
    app.addHook('onRequest', async (req: import('fastify').FastifyRequest) => { (req as unknown as { user: unknown }).user = { name: 'test-op', role: 'operator' }; });
    registerManualRoutes(app, db, {
      bus: { emit: () => undefined, on: () => () => undefined } as never,
      dispatchDeps: {},
      artifactsDir: join('/tmp', `t-${Date.now()}`),
    } as never);
    await app.ready();
  });
  afterEach(async () => { await app.close(); db.close(); __setAlloyForTest(null); });

  it('opens the app via alloy_apps with terminate-first semantics', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/devices/SIM-X/apps/com.lionparcel.apps/launch' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
    expect(calls).toContainEqual({ tool: 'alloy_apps', input: { action: 'open', app: 'com.lionparcel.apps', udid: 'SIM-X', hold: false } });
  });

  it('502 with the engine error when open fails', async () => {
    __setAlloyForTest({
      dispatch: async () => ({ ok: false, error: { code: 'BOOM', message: 'open failed (boom)' } }),
    } as never);
    const r = await app.inject({ method: 'POST', url: '/api/devices/SIM-X/apps/com.apple.Preferences/launch' });
    expect(r.statusCode).toBe(502);
    expect((r.json() as { error: string }).error).toMatch(/boom/i);
  });
});
