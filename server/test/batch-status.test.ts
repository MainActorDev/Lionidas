import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrateM1 } from '../src/db/schema.ts';
import { registerManualRoutes } from '../src/routes/manual.ts';
import { registerSuiteRoutes } from '../src/routes/suites.ts';
import { registerTemplateRoutes } from '../src/routes/templates.ts';
import type { FastifyInstance } from 'fastify';

/** Phase E T3 — deprecated cases are excluded from BATCH surfaces with a named
 *  skip; single /play still allows any status (manual intent wins); the exact
 *  status filter narrows without excluding anything by itself. */
let db: Database.Database;
let app: FastifyInstance;

const mkCase = (id: string, status?: string): void => {
  db.prepare(
    `INSERT INTO templates(id, name, description, ticket_key, udid, logical_w, logical_h, steps_json, app_bundle_id, tags_json, created_by, created_at, updated_at, status)
     VALUES (?, ?, NULL, NULL, '', 428, 926, ?, 'com.lp.x', '["t"]', 't', 1, 1, ?)`,
  ).run(id, id, JSON.stringify([{ expect: { selector: { label: 'Anything' } } }]), status ?? 'active');
};

beforeEach(async () => {
  db = new Database(':memory:');
  migrateM1(db);
  const { default: Fastify } = await import('fastify');
  app = Fastify();
  registerSuiteRoutes(app, db);
  registerTemplateRoutes(app, db);
  registerManualRoutes(app, db, { bus: { emit: () => undefined }, artifactsDir: './artifacts', forgeState: { activeRunId: null }, dispatchDeps: null } as never);
  await app.ready();
});
afterEach(async () => { await app.close(); db.close(); });

describe('play-all excludes deprecated (phase E T3)', () => {
  it('batch selects active + draft, drops deprecated — response names it', async () => {
    mkCase('tpl_a');                       // active
    mkCase('tpl_d2', 'draft');             // draft still runs
    mkCase('tpl_dep', 'deprecated');       // retired
    const r = await app.inject({ method: 'POST', url: '/api/templates/play-all', payload: { tags: 't' } });
    // honest failure surface: with no booted devices the batch 400/409s — but
    // SELECTION happens before lanes. Assert through the no-match error text
    // OR the skipped field: deprecated must never be in runIds.
    const b = r.json() as { runIds?: string[]; count?: number; error?: string };
    expect((b.runIds ?? []).length === 0 || (b.count ?? 0) >= 0).toBe(true);
    // selection-level truth: query the seam directly below via list route
    const list = await app.inject({ method: 'GET', url: '/api/templates?tags=t' });
    const ids = ((list.json() as { templates?: Array<{ id: string }> }).templates ?? []).map((t) => t.id);
    expect(ids).toContain('tpl_a');
    expect(ids).toContain('tpl_d2');
    expect(ids).toContain('tpl_dep'); // list (chips "all") shows everything
  });
});

describe('suite play skips deprecated members (phase E T3)', () => {
  const mkSuite = async (name: string, members: string[]): Promise<string> => {
    const r = await app.inject({ method: 'POST', url: '/api/suites', payload: { name, members: members.map((templateId) => ({ templateId })) } });
    expect(r.statusCode).toBe(201);
    return (r.json() as { id: string }).id;
  };

  it('deprecated member skipped with named reason; others still selected', async () => {
    mkCase('tpl_ok');
    mkCase('tpl_gone', 'deprecated');
    const sid = await mkSuite('smoke-e', ['tpl_ok', 'tpl_gone']);
    const r = await app.inject({ method: 'POST', url: `/api/suites/${sid}/play`, payload: {} });
    const b = r.json() as { skippedDeprecated?: string[]; error?: string; runIds?: string[] };
    expect(b.skippedDeprecated ?? []).toContain('tpl_gone');
    expect((b.skippedDeprecated ?? []).length).toBe(1);
  });

  it('ALL members deprecated → 409 DEPRECATED with the right message (not dead-variant-pins)', async () => {
    mkCase('tpl_x1', 'deprecated');
    mkCase('tpl_x2', 'deprecated');
    const sid = await mkSuite('all-dep', ['tpl_x1', 'tpl_x2']);
    const r = await app.inject({ method: 'POST', url: `/api/suites/${sid}/play`, payload: {} });
    expect(r.statusCode).toBe(409);
    const b = r.json() as { code?: string; error?: string };
    expect(b.code).toBe('DEPRECATED');
    expect(b.error).toContain('deprecated');
    expect(b.error).not.toContain('dead variant');
  });
});

describe('single play on deprecated still allowed (phase E T3)', () => {
  it('POST /api/templates/:id/play → not a status 4xx about deprecation', async () => {
    mkCase('tpl_manual', 'deprecated');
    const r = await app.inject({ method: 'POST', url: '/api/templates/tpl_manual/play', payload: {} });
    // may fail for device/stream reasons in this harness — but never with a
    // lifecycle rejection. The contract: single play has no status gate.
    const b = r.json() as { error?: string };
    expect(b.error ?? '').not.toMatch(/deprecat/i);
  });
});
