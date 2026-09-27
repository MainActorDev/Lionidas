import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { migrateM1 } from '../src/db/schema.ts';
import { registerEnvVarRoutes } from '../src/routes/env-vars.ts';

/** Env-vars CRUD (plan rev 2, Stage 3): secret masking (value never returns),
 *  scoped empty-secret sentinel (F2), role gating (F3), scope validation, and
 *  plan-delete cascade. Auth is simulated by injecting req.user directly. */

let tmp: string;
let db: Database.Database;
let app: FastifyInstance;
let operatorOn: boolean;

const inject = (user: { name: string; role: string } | null): void => {
  app.addHook('onRequest', async (req) => {
    (req as unknown as { user: unknown }).user = user;
  });
};

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'env-vars-'));
  db = new Database(join(tmp, 't.db'));
  migrateM1(db);
  db.prepare("INSERT INTO plans(id, name, tags_json, env_json, created_by, created_at, updated_at) VALUES ('pl_1', 'p1', '[]', '{}', 'qa', 0, 0)").run();
  app = Fastify();
  registerEnvVarRoutes(app, db);
  operatorOn = true;
  inject(operatorOn ? { name: 'qa', role: 'operator' } : null);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const put = (body: Record<string, unknown>): Promise<{ statusCode: number; body: unknown }> =>
  app.inject({ method: 'POST', url: '/api/env-vars', payload: body }) as unknown as Promise<{ statusCode: number; body: unknown }>;

describe('env-vars routes', () => {
  it('secret values never leave the server (masked to null + set badge)', async () => {
    const r = await put({ scope: 'app', appBundleId: 'com.x', key: 'DRILL_PASSWORD', value: 'quality123', secret: true });
    expect(r.statusCode).toBe(200);
    const list = await app.inject({ method: 'GET', url: '/api/env-vars' });
    const vars = (JSON.parse(list.body) as { vars: Array<{ key: string; value: string | null; secret: boolean; status: string }> }).vars;
    const pw = vars.find((v) => v.key === 'DRILL_PASSWORD')!;
    expect(pw.value).toBeNull();
    expect(pw.secret).toBe(true);
    expect(pw.status).toBe('set');
    expect(list.body).not.toContain('quality123');
  });

  it('empty value keeps an EXISTING secret (note edits); empty on create → 422 (F2)', async () => {
    const r = await put({ scope: 'app', appBundleId: 'com.x', key: 'DRILL_PASSWORD', value: 's3cret', secret: true });
    const id = (JSON.parse(r.body as string) as { id: string }).id;
    // note edit with empty value → keeps secret
    const keep = await app.inject({ method: 'PUT', url: `/api/env-vars/${id}`, payload: { value: '', note: 'drill creds' } });
    expect(keep.statusCode).toBe(200);
    const row = db.prepare('SELECT value, note FROM env_vars WHERE id = ?').get(id) as { value: string; note: string };
    expect(row.value).toBe('s3cret');
    expect(row.note).toBe('drill creds');
    // empty on create → 422
    const bad = await put({ scope: 'app', appBundleId: 'com.x', key: 'X2', value: '', secret: true });
    expect(bad.statusCode).toBe(422);
  });

  it('viewer role gets 403 on writes, 200 on GET (F3)', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/env-vars' });
    expect(list.statusCode).toBe(200);
    const viewer = Fastify();
    const db2 = db;
    registerEnvVarRoutes(viewer, db2);
    viewer.addHook('onRequest', async (req) => { (req as unknown as { user: unknown }).user = { name: 'v', role: 'viewer' }; });
    await viewer.ready();
    const denied = await viewer.inject({ method: 'POST', url: '/api/env-vars', payload: { scope: 'global', key: 'K', value: 'v' } });
    expect(denied.statusCode).toBe(403);
    await viewer.close();
  });

  it('scope-column consistency enforced (global takes no bundle; app requires one)', async () => {
    const g = await put({ scope: 'global', appBundleId: 'com.x', key: 'K', value: 'v' });
    expect(g.statusCode).toBe(422);
    const a = await put({ scope: 'app', key: 'K', value: 'v' });
    expect(a.statusCode).toBe(422);
    const p = await put({ scope: 'plan', key: 'K', value: 'v' });
    expect(p.statusCode).toBe(422);
  });

  it('duplicate key in same scope → 409; plan delete cascades its vars', async () => {
    await put({ scope: 'app', appBundleId: 'com.x', key: 'K', value: 'v1' });
    const dup = await put({ scope: 'app', appBundleId: 'com.x', key: 'K', value: 'v2' });
    expect(dup.statusCode).toBe(409);
    const p = await put({ scope: 'plan', planId: 'pl_1', key: 'PK', value: 'v' });
    expect(p.statusCode).toBe(200);
    db.prepare('DELETE FROM plans WHERE id = ?').run('pl_1');
    const left = db.prepare("SELECT COUNT(*) AS n FROM env_vars WHERE key = 'PK'").get() as { n: number };
    expect(left.n).toBe(0);
  });
});
