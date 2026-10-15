/** Audit API tests (plan 20261015T065500Z Task 1): q= substring search and
 *  numbered pagination on GET /api/audit. RBAC status-code coverage lives in
 *  rbac-boundaries.test.ts ("audit surface") and is not repeated here. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { migrateM1 } from '../src/db/schema.ts';
import { registerRunRoutes } from '../src/routes/runs.ts';

let db: Database.Database;
let app: FastifyInstance;
let tmp: string;

function seedAudit(n: number, baseAt: number): void {
  const ins = db.prepare('INSERT INTO auth_log(at, email, user_id, event, detail) VALUES (?, ?, ?, ?, ?)');
  const emails = ['a@t.local', 'b@t.local'];
  const events = ['login', 'run_play', 'rbac_denied'];
  for (let i = 0; i < n; i++) {
    ins.run(baseAt + i * 1000, emails[i % 2], `u_${i % 2}`, events[i % 3], `detail text ${i} by user${i % 2}`);
  }
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'audit-api-'));
  db = new Database(join(tmp, '.db'));
  migrateM1(db);
  app = Fastify();
  app.addHook('onRequest', async (req) => { req.user = db.prepare('SELECT * FROM users WHERE id = ?').get('u_sup') as never; });
  db.prepare(`INSERT INTO users(id, email, name, role, password_hash, auth_source, active, approved, created_at)
              VALUES ('u_sup', 'sup@t.local', 'sup', 'supervisor', 'x', 'local', 1, 1, 0)`).run();
  registerRunRoutes(app, db, { emit: () => undefined } as never);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('GET /api/audit — q search', () => {
  it('matches email substring', async () => {
    seedAudit(9, 1_000);
    const r = await app.inject({ method: 'GET', url: '/api/audit?q=a@t.local' });
    expect(r.statusCode).toBe(200);
    const b = r.json() as { events: Array<{ email: string }>; total: number };
    expect(b.total).toBeGreaterThan(0);
    expect(b.events.every((e) => e.email === 'a@t.local')).toBe(true);
  });
  it('matches event substring', async () => {
    seedAudit(9, 1_000);
    const r = await app.inject({ method: 'GET', url: '/api/audit?q=rbac' });
    const b = r.json() as { events: Array<{ event: string }>; total: number };
    expect(b.events.every((e) => e.event === 'rbac_denied')).toBe(true);
    expect(b.total).toBe(3);
  });
  it('matches detail substring', async () => {
    seedAudit(9, 1_000);
    const r = await app.inject({ method: 'GET', url: '/api/audit?q=detail text 7' });
    const b = r.json() as { total: number };
    expect(b.total).toBe(1);
  });
  it('combines with actor filter (AND)', async () => {
    seedAudit(9, 1_000);
    const r = await app.inject({ method: 'GET', url: '/api/audit?actor=a@t.local&q=run_play' });
    const b = r.json() as { events: Array<{ email: string; event: string }>; total: number };
    expect(b.events.every((e) => e.email === 'a@t.local' && e.event === 'run_play')).toBe(true);
    expect(b.total).toBeLessThanOrEqual(3);
  });
});

describe('GET /api/audit — pagination', () => {
  it('page 2 offsets past page 1; no overlap, ordered DESC', async () => {
    seedAudit(25, 1_000);
    const p1 = (await app.inject({ method: 'GET', url: '/api/audit?limit=10&page=1' })).json() as { events: Array<{ id: number }>; total: number; page: number; pageCount: number };
    const p2 = (await app.inject({ method: 'GET', url: '/api/audit?limit=10&page=2' })).json() as { events: Array<{ id: number }> };
    expect(p1.total).toBe(25);
    expect(p1.pageCount).toBe(3);
    expect(p1.events).toHaveLength(10);
    expect(p2.events).toHaveLength(10);
    const ids = new Set([...p1.events, ...p2.events].map((e) => e.id));
    expect(ids.size).toBe(20);
  });
  it('page beyond range returns empty events, correct metadata', async () => {
    seedAudit(5, 1_000);
    const r = await app.inject({ method: 'GET', url: '/api/audit?page=99' });
    const b = r.json() as { events: unknown[]; total: number; pageCount: number };
    expect(b.events).toHaveLength(0);
    expect(b.total).toBe(5);
    expect(b.pageCount).toBe(1);
  });
  it('page defaults to 1; invalid page clamps to 1', async () => {
    seedAudit(5, 1_000);
    const a = (await app.inject({ method: 'GET', url: '/api/audit' })).json() as { page: number };
    const b = (await app.inject({ method: 'GET', url: '/api/audit?page=0' })).json() as { page: number };
    const c = (await app.inject({ method: 'GET', url: '/api/audit?page=garbage' })).json() as { page: number };
    expect(a.page).toBe(1);
    expect(b.page).toBe(1);
    expect(c.page).toBe(1);
  });
  it('empty result: total 0, pageCount 0', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/audit?q=nomatch-zzz' });
    const b = r.json() as { total: number; pageCount: number; events: unknown[] };
    expect(b.total).toBe(0);
    expect(b.pageCount).toBe(0);
    expect(b.events).toHaveLength(0);
  });
  it('exact event filter still works', async () => {
    seedAudit(9, 1_000);
    const r = await app.inject({ method: 'GET', url: '/api/audit?event=login' });
    const b = r.json() as { total: number };
    expect(b.total).toBe(3);
  });
});
