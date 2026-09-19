import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerSuiteRoutes } from '../src/routes/suites.ts';
import { registerManualRoutes } from '../src/routes/manual.ts';
import { registerRunRoutes } from '../src/routes/runs.ts';
import { migrateM1 } from '../src/db/schema.ts';

/** Phase D — suites. Route-level harness (no device/alloy runtime):
 *  T2 CRUD + membership validation, T5 plans exactly-one-of, T7 runs
 *  filter. Play semantics with REAL playback live in batch-variants.test.ts
 *  (full buildApp harness); here play is probed only through its honest
 *  failure surfaces (empty suite 400, unknown 404, ghost member 400). */

let db: Database.Database;
let app: FastifyInstance;

const mkCase = (id: string, name: string, variants?: string[]): void => {
  db.prepare(
    `INSERT INTO templates(id, name, description, ticket_key, udid, logical_w, logical_h, steps_json, app_bundle_id, tags_json, created_by, created_at, updated_at, variants_json)
     VALUES (?, ?, NULL, NULL, '', 428, 926, ?, 'com.lp.x', '[]', 't', 1, 1, ?)`,
  ).run(id, name, JSON.stringify([{ tap: { selector: 'label == "Anything"' } }]), variants ? JSON.stringify(variants.map((v) => ({ id: v }))) : null);
};

beforeEach(async () => {
  db = new Database(':memory:');
  migrateM1(db);
  app = Fastify();
  registerSuiteRoutes(app, db);
  registerRunRoutes(app, db, { emit: () => undefined } as never);
  registerManualRoutes(app, db, { bus: { emit: () => undefined }, artifactsDir: './artifacts', forgeState: { activeRunId: null }, dispatchDeps: null } as never);
  await app.ready();
});
afterEach(async () => { await app.close(); db.close(); });

describe('T2 — suites CRUD + membership validation', () => {
  it('create + read back: members ordered, verdicts from runs, null variantIds = default', async () => {
    mkCase('tpl_a', 'A');
    mkCase('tpl_b', 'B', ['sg', 'my']);
    db.prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at, note, template_id)
                VALUES ('run_a1', 'T', 'manual', 'passed', 'qa', 'sim', 100, '', 'tpl_a')`).run();
    const res = await app.inject({ method: 'POST', url: '/api/suites', payload: { name: 'smoke', members: [{ templateId: 'tpl_a' }, { templateId: 'tpl_b', variantIds: ['sg'] }] } });
    expect(res.statusCode).toBe(201);
    const s = res.json() as { id: string; members: Array<{ templateId: string; variantIds: string[] | null; lastStatus: string | null; totalRuns: number }> };
    expect(s.members).toHaveLength(2);
    expect(s.members[0]).toMatchObject({ templateId: 'tpl_a', variantIds: null, lastStatus: 'passed', totalRuns: 1 });
    expect(s.members[1]).toMatchObject({ templateId: 'tpl_b', variantIds: ['sg'] });
    const got = await app.inject({ method: 'GET', url: `/api/suites/${s.id}` });
    expect(got.statusCode).toBe(200);
    expect((got.json() as { members: unknown[] }).members).toHaveLength(2);
  });

  it('unknown template / unknown variant / duplicate member → 400, nothing inserted', async () => {
    mkCase('tpl_c', 'C', ['sg']);
    for (const bad of [
      { members: [{ templateId: 'tpl_ghost' }] },
      { members: [{ templateId: 'tpl_c', variantIds: ['nope'] }] },
      { members: [{ templateId: 'tpl_c' }, { templateId: 'tpl_c' }] },
    ]) {
      const res = await app.inject({ method: 'POST', url: '/api/suites', payload: { name: `x${Math.random()}`, ...bad } });
      expect(res.statusCode).toBe(400);
    }
    expect((db.prepare('SELECT COUNT(*) n FROM suites').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) n FROM suite_members').get() as { n: number }).n).toBe(0);
  });

  it('duplicate name → 409; delete suite → members gone, runs.suite_id SET NULL', async () => {
    mkCase('tpl_d', 'D');
    const a = await app.inject({ method: 'POST', url: '/api/suites', payload: { name: 'dup', members: [{ templateId: 'tpl_d' }] } });
    expect(a.statusCode).toBe(201);
    const b = await app.inject({ method: 'POST', url: '/api/suites', payload: { name: 'dup', members: [] } });
    expect(b.statusCode).toBe(409);
    const sid = (a.json() as { id: string }).id;
    db.prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at, note, template_id, suite_id)
                VALUES ('run_d1', 'T', 'manual', 'passed', 'qa', 'sim', 100, '', 'tpl_d', ?)`).run(sid);
    const del = await app.inject({ method: 'DELETE', url: `/api/suites/${sid}` });
    expect(del.statusCode).toBe(200);
    expect((db.prepare('SELECT COUNT(*) n FROM suite_members').get() as { n: number }).n).toBe(0);
    const run = db.prepare('SELECT suite_id FROM runs WHERE id = ?').get('run_d1') as { suite_id: string | null };
    expect(run.suite_id).toBeNull();
  });

  it('patch replaces members wholesale; name conflict → 409', async () => {
    mkCase('tpl_e', 'E');
    mkCase('tpl_f', 'F');
    const a = await app.inject({ method: 'POST', url: '/api/suites', payload: { name: 'one', members: [{ templateId: 'tpl_e' }] } });
    const sid = (a.json() as { id: string }).id;
    await app.inject({ method: 'POST', url: '/api/suites', payload: { name: 'two', members: [] } });
    const p = await app.inject({ method: 'PATCH', url: `/api/suites/${sid}`, payload: { members: [{ templateId: 'tpl_f' }, { templateId: 'tpl_e', variantIds: null }] } });
    expect(p.statusCode).toBe(200);
    const got = (await app.inject({ method: 'GET', url: `/api/suites/${sid}` })).json() as { members: Array<{ templateId: string; position: number }> };
    expect(got.members.map((m) => m.templateId)).toEqual(['tpl_f', 'tpl_e']);
    const conflict = await app.inject({ method: 'PATCH', url: `/api/suites/${sid}`, payload: { name: 'two' } });
    expect(conflict.statusCode).toBe(409);
  });
});

describe('T3/T4 — suite play honest failures (full playback lives in batch-variants)', () => {
  it('empty suite → 400; unknown suite → 404; ghost member → honest 400', async () => {
    const empty = await app.inject({ method: 'POST', url: '/api/suites', payload: { name: 'empty', members: [] } });
    const sid = (empty.json() as { id: string }).id;
    expect((await app.inject({ method: 'POST', url: `/api/suites/${sid}/play`, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/suites/suite_ghost/play', payload: {} })).statusCode).toBe(404);
    // ghost member: impossible at the DB level — suite_members.template_id
    // FKs templates(id), so a deleted case's membership cascades away and a
    // ghost insert THROWS. runBatch's ghost 400 remains defense for the
    // cached-client-list path (b.cases straight from a stale UI).
    mkCase('tpl_g', 'G');
    const s = await app.inject({ method: 'POST', url: '/api/suites', payload: { name: 'ghost', members: [{ templateId: 'tpl_g' }] } });
    const gid = (s.json() as { id: string }).id;
    expect(() => db.prepare(`INSERT INTO suite_members(suite_id, template_id, variant_ids_json, position) VALUES (?, 'tpl_ghost2', NULL, 0)`).run(gid)).toThrow();
    db.prepare('DELETE FROM templates WHERE id = ?').run('tpl_g'); // membership cascades away
    expect((db.prepare('SELECT COUNT(*) n FROM suite_members WHERE suite_id = ?').get(gid) as { n: number }).n).toBe(0);
    const play = await app.inject({ method: 'POST', url: `/api/suites/${gid}/play`, payload: {} });
    expect(play.statusCode).toBe(400); // now empty → honest 400, not a 500 on the ghost
  });
});

describe('T5 — plans exactly-one-of tags|suite', () => {
  it('both set → 400; unknown suite → 400; suite-sourced plan is suiteId-only', async () => {
    mkCase('tpl_h', 'H', ['sg']);
    const s = await app.inject({ method: 'POST', url: '/api/suites', payload: { name: 'ps', members: [{ templateId: 'tpl_h' }] } });
    expect(s.statusCode).toBe(201);
    const sid = (s.json() as { id: string }).id;
    const both = await app.inject({ method: 'POST', url: '/api/plans', payload: { name: 'both', tags: ['smoke'], suiteId: sid } });
    expect(both.statusCode).toBe(400);
    const ghost = await app.inject({ method: 'POST', url: '/api/plans', payload: { name: 'ghost', suiteId: 'suite_nope' } });
    expect(ghost.statusCode).toBe(400);
    const plan = await app.inject({ method: 'POST', url: '/api/plans', payload: { name: 'suiteplay', suiteId: sid } });
    expect(plan.statusCode).toBe(200);
    const pid = (plan.json() as { id: string }).id;
    const flip = await app.inject({ method: 'PATCH', url: `/api/plans/${pid}`, payload: { tags: ['x'], suiteId: sid } });
    expect(flip.statusCode).toBe(400);
    const row = db.prepare('SELECT tags_json, suite_id FROM plans WHERE id = ?').get(pid) as { tags_json: string; suite_id: string };
    expect(JSON.parse(row.tags_json)).toEqual([]);
    expect(row.suite_id).toBe(sid);
  });
});

describe('T7 — runs ?suite= filter', () => {
  it('suite id filter matches stamped runs; unassigned matches the rest', async () => {
    mkCase('tpl_i', 'I');
    const s = await app.inject({ method: 'POST', url: '/api/suites', payload: { name: 'f', members: [{ templateId: 'tpl_i' }] } });
    const sid = (s.json() as { id: string }).id;
    db.prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at, note, template_id, suite_id)
                VALUES ('run_s', 'T', 'manual', 'passed', 'qa', 'sim', 100, '', 'tpl_i', ?)`).run(sid);
    db.prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at, note, template_id)
                VALUES ('run_x', 'T', 'manual', 'passed', 'qa', 'sim', 200, '', 'tpl_i')`).run();
    const hit = (await app.inject({ method: 'GET', url: `/api/runs?suite=${sid}` })).json() as { runs: Array<{ id: string }> };
    expect(hit.runs.map((r) => r.id)).toEqual(['run_s']);
    const rest = (await app.inject({ method: 'GET', url: '/api/runs?suite=unassigned' })).json() as { runs: Array<{ id: string }> };
    expect(rest.runs.map((r) => r.id)).toEqual(['run_x']);
  });
});
