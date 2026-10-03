/** GET /api/manual/sessions — open manual sessions per device; the cockpit's
 *  per-device control map hydrates from this (plan R1/F4). */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// the route registers via registerManualRoutes — find its actual export name
import { registerManualRoutes } from '../src/routes/manual.ts';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE manual_sessions (id TEXT PRIMARY KEY, run_id TEXT, udid TEXT, operator TEXT, logical_w INTEGER, logical_h INTEGER, started_at INTEGER, last_activity INTEGER, finished_at INTEGER, app_bundle_id TEXT, recording_json TEXT);
    CREATE TABLE runs (id TEXT PRIMARY KEY, ticket_key TEXT, kind TEXT, status TEXT, triggered_by TEXT, device_udid TEXT, started_at INTEGER, finished_at INTEGER, note TEXT);
  `);
  return db;
}

describe('GET /api/manual/sessions', () => {
  let app: ReturnType<typeof Fastify>;
  let db: Database.Database;

  beforeEach(async () => {
    db = freshDb();
    app = Fastify();
    // satisfy requireRole: an operator identity on every request (unit scope —
    // auth itself is covered by the auth suites)
    app.addHook('onRequest', async (req: import('fastify').FastifyRequest) => { (req as unknown as { user: unknown }).user = { name: 'test-op', role: 'operator' }; });
    registerManualRoutes(app, db, {
      bus: { emit: () => undefined, on: () => () => undefined } as never,
      dispatchDeps: {},
      artifactsDir: join(tmpdir(), `t-${Date.now()}`),
    } as never);
    await app.ready();
  });
  afterEach(async () => { await app.close(); db.close(); });

  it('lists open sessions with fields, excludes finished', async () => {
    const now = Date.now();
    db.prepare(`INSERT INTO manual_sessions (id, run_id, udid, operator, logical_w, logical_h, started_at, last_activity, finished_at, app_bundle_id) VALUES ('ms_a', 'r1', 'udidA', 'op', 100, 200, ?, ?, NULL, 'app')`).run(now - 5000, now);
    db.prepare(`INSERT INTO manual_sessions (id, run_id, udid, operator, logical_w, logical_h, started_at, last_activity, finished_at, app_bundle_id) VALUES ('ms_done', 'r2', 'udidB', 'op', 100, 200, ?, ?, ?, 'app')`).run(now - 9000, now - 8000, now - 8000);
    const r = await app.inject({ method: 'GET', url: '/api/manual/sessions' });
    expect(r.statusCode).toBe(200);
    const b = r.json() as { sessions: Array<{ id: string; udid: string; operator: string; startedAt: number; lastActivity: number }> };
    expect(b.sessions).toHaveLength(1);
    expect(b.sessions[0]).toMatchObject({ id: 'ms_a', udid: 'udidA', operator: 'op' });
    expect(b.sessions[0]!.startedAt).toBe(now - 5000);
  });

  it('empty list when none open', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/manual/sessions' });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { sessions: unknown[] }).sessions).toHaveLength(0);
  });
});
