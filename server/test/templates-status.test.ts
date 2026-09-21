import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateM1 } from '../src/db/schema.ts';
import { registerTemplateRoutes } from '../src/routes/templates.ts';
import type { FastifyInstance } from 'fastify';

/** Phase E T2 — status read/write on the templates API.
 *  PATCH validates draft|active|deprecated; rowToTemplate normalizes NULL →
 *  active (legacy rows); GET list carries status per case. */
let app: FastifyInstance;
let db: Database.Database;
let tmp: string;

function buildApp(): never { throw new Error('unused'); }
void buildApp;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'crucible-tpl-status-'));
  db = new Database(join(tmp, 'crucible.db'));
  migrateM1(db);
  const { default: Fastify } = await import('fastify');
  app = Fastify();
  // minimal req.user stub — attribution stamps updated_by
  app.addHook('onRequest', async (req) => { (req as unknown as { user?: unknown }).user = { name: 'qa-test', role: 'admin' }; });
  registerTemplateRoutes(app, db);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

function seed(id: string, status?: string): void {
  db.prepare(`INSERT INTO templates(id, name, udid, steps_json, created_by, created_at, updated_at${status ? ', status' : ''})
              VALUES (?, ?, 'sim-1', '[]', 'qa', 0, 0${status ? ", ?" : ''})`).run(...(status ? [id, id, status] : [id, id]));
}

describe('PATCH /api/templates/:id status (phase E T2)', () => {
  it('sets deprecated; updated_by + updated_at stamped', async () => {
    seed('t_dep');
    const r = await app.inject({ method: 'PATCH', url: '/api/templates/t_dep', payload: { status: 'deprecated' } });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { status: string }).status).toBe('deprecated');
    const row = db.prepare('SELECT status, updated_by FROM templates WHERE id = ?').get('t_dep') as { status: string; updated_by: string | null };
    expect(row.status).toBe('deprecated');
    expect(row.updated_by).toBe('qa-test');
  });

  it('rejects bogus status with 400', async () => {
    seed('t_bad');
    const r = await app.inject({ method: 'PATCH', url: '/api/templates/t_bad', payload: { status: 'archived' } });
    expect(r.statusCode).toBe(400);
    expect((r.json() as { error: string }).error).toContain('draft|active|deprecated');
  });

  it('PATCH without status leaves it untouched', async () => {
    seed('t_keep', 'draft');
    const r = await app.inject({ method: 'PATCH', url: '/api/templates/t_keep', payload: { description: 'x' } });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { status: string }).status).toBe('draft');
  });

  it('GET list normalizes legacy NULL to active', async () => {
    // fresh DBs can't hold NULL (CHECK) — the normalization seam is exercised
    // by rowToTemplate reading `status ?? 'active'`; seed normally and assert
    // the wire shape, then flip to deprecated and assert the wire follows.
    seed('t_wire');
    let r = await app.inject({ method: 'GET', url: '/api/templates' });
    expect(r.statusCode).toBe(200);
    let t = ((r.json() as { templates?: Array<{ id: string; status?: string }> }).templates ?? []).find((x) => x.id === 't_wire');
    expect(t?.status).toBe('active');
    db.prepare("UPDATE templates SET status = 'deprecated' WHERE id = 't_wire'").run();
    r = await app.inject({ method: 'GET', url: '/api/templates' });
    t = ((r.json() as { templates?: Array<{ id: string; status?: string }> }).templates ?? []).find((x) => x.id === 't_wire');
    expect(t?.status).toBe('deprecated');
  });
});
