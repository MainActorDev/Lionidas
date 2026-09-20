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

const mkCase = (id: string, name: string, variants?: string[], bundle?: string): void => {
  db.prepare(
    `INSERT INTO templates(id, name, description, ticket_key, udid, logical_w, logical_h, steps_json, app_bundle_id, tags_json, created_by, created_at, updated_at, variants_json)
     VALUES (?, ?, NULL, NULL, '', 428, 926, ?, ?, '[]', 't', 1, 1, ?)`,
  ).run(id, name, JSON.stringify([{ tap: { selector: 'label == "Anything"' } }]), bundle ?? 'com.lp.x', variants ? JSON.stringify(variants.map((v) => ({ id: v }))) : null);
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
  it('create + read back: members ordered, suite-scoped verdicts (unstamped runs do not count), null variantIds = default', async () => {
    mkCase('tpl_a', 'A');
    mkCase('tpl_b', 'B', ['sg', 'my']);
    // a run with NO suite stamp: case-level truth, but not this suite's play
    db.prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at, note, template_id)
                VALUES ('run_a1', 'T', 'manual', 'passed', 'qa', 'sim', 100, '', 'tpl_a')`).run();
    const res = await app.inject({ method: 'POST', url: '/api/suites', payload: { name: 'smoke', members: [{ templateId: 'tpl_a' }, { templateId: 'tpl_b', variantIds: ['sg'] }] } });
    expect(res.statusCode).toBe(201);
    const s = res.json() as { id: string; members: Array<{ templateId: string; variantIds: string[] | null; lastStatus: string | null; totalRuns: number }> };
    expect(s.members).toHaveLength(2);
    expect(s.members[0]).toMatchObject({ templateId: 'tpl_a', variantIds: null, lastStatus: null, totalRuns: 0 });
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

describe("bundle scope — a suite is one app's pack", () => {
  it('mixed-bundle members → 400 naming the offender; nothing inserted', async () => {
    mkCase('tpl_lp', 'lp case');
    mkCase('tpl_maps', 'maps case', undefined, 'com.apple.Maps');
    const r = await app.inject({ method: 'POST', url: '/api/suites', payload: { name: 'mixed', members: [{ templateId: 'tpl_lp' }, { templateId: 'tpl_maps' }] } });
    expect(r.statusCode).toBe(400);
    expect((r.json() as { error: string }).error).toContain('com.apple.Maps');
    expect(db.prepare('SELECT COUNT(*) c FROM suites').get()).toEqual({ c: 0 });
  });

  it('create derives bundle from members; homogeneous pack stamps it on the suite', async () => {
    mkCase('tpl_g', 'G');
    const r = await app.inject({ method: 'POST', url: '/api/suites', payload: { name: 'derived', members: [{ templateId: 'tpl_g' }] } });
    expect(r.statusCode).toBe(201);
    expect((r.json() as { appBundleId: string | null }).appBundleId).toBe('com.lp.x');
  });

  it('explicit appBundleId validates members against it (foreign member → 400)', async () => {
    mkCase('tpl_h', 'H');
    const bad = await app.inject({ method: 'POST', url: '/api/suites', payload: { name: 'scoped', appBundleId: 'com.apple.Maps', members: [{ templateId: 'tpl_h' }] } });
    expect(bad.statusCode).toBe(400);
    const good = await app.inject({ method: 'POST', url: '/api/suites', payload: { name: 'scoped', appBundleId: 'com.lp.x', members: [{ templateId: 'tpl_h' }] } });
    expect(good.statusCode).toBe(201);
    expect((good.json() as { appBundleId: string | null }).appBundleId).toBe('com.lp.x');
  });

  it('appBundleId immutable on PATCH; foreign member on PATCH → 400', async () => {
    mkCase('tpl_i', 'I');
    mkCase('tpl_maps2', 'maps2', undefined, 'com.apple.Maps');
    const a = await app.inject({ method: 'POST', url: '/api/suites', payload: { name: 'fix', members: [{ templateId: 'tpl_i' }] } });
    const sid = (a.json() as { id: string }).id;
    const mut = await app.inject({ method: 'PATCH', url: `/api/suites/${sid}`, payload: { appBundleId: 'com.apple.Maps' } });
    expect(mut.statusCode).toBe(400);
    expect((mut.json() as { error: string }).error).toContain('immutable');
    const foreign = await app.inject({ method: 'PATCH', url: `/api/suites/${sid}`, payload: { members: [{ templateId: 'tpl_maps2' }] } });
    expect(foreign.statusCode).toBe(400);
  });

  it('play skips drifted members with named reason; all-drifted → 409 BUNDLE_DRIFT', async () => {
    mkCase('tpl_j', 'J');
    mkCase('tpl_k', 'K');
    const a = await app.inject({ method: 'POST', url: '/api/suites', payload: { name: 'driftme', members: [{ templateId: 'tpl_j' }, { templateId: 'tpl_k' }] } });
    const sid = (a.json() as { id: string }).id;
    // template's bundle edited away from suite scope AFTER joining
    db.prepare('UPDATE templates SET app_bundle_id = ? WHERE id = ?').run('com.apple.Maps', 'tpl_k');
    // route-level harness: playback needs a device row — expect the honest
    // DEVICE_BUSY-style failure (NOT 400 unknown / NOT silent run of drifted)
    const r = await app.inject({ method: 'POST', url: `/api/suites/${sid}/play`, payload: {} });
    // inScope = [tpl_j] only; drifted = [tpl_k] surfaced or blocked before playback
    const body = r.json() as { skippedDrifted?: string[]; error?: string; code?: string };
    expect(body.skippedDrifted ?? []).toContain('tpl_k');
    // all drifted → 409 with code
    db.prepare('UPDATE templates SET app_bundle_id = ? WHERE id = ?').run('com.apple.Maps', 'tpl_j');
    const all = await app.inject({ method: 'POST', url: `/api/suites/${sid}/play`, payload: {} });
    expect(all.statusCode).toBe(409);
    expect((all.json() as { code?: string }).code).toBe('BUNDLE_DRIFT');
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

describe('T8 — dead-variant pins at play', () => {
  it('all-dead pin → member skipped with named reason; all members dead → 409 DEAD_VARIANTS', async () => {
    mkCase('tpl_v1', 'V1', ['sg', 'my']);
    mkCase('tpl_v2', 'V2');
    const s = await app.inject({ method: 'POST', url: '/api/suites', payload: { name: 'pins', members: [{ templateId: 'tpl_v1', variantIds: ['sg'] }, { templateId: 'tpl_v2' }] } });
    const sid = (s.json() as { id: string }).id;
    // 'sg' deleted from the case vocab after the pin
    db.prepare('UPDATE templates SET variants_json = ? WHERE id = ?').run(JSON.stringify([{ id: 'my' }]), 'tpl_v1');
    const r = await app.inject({ method: 'POST', url: `/api/suites/${sid}/play`, payload: {} });
    const body = r.json() as { skippedDeadVariants?: Array<{ templateId: string; dead: string[] }>; error?: string; code?: string };
    // route-level harness (no device): honest playback failure, but the skip
    // must be named BEFORE playback — never a silent plain run
    expect(JSON.stringify(body.skippedDeadVariants ?? [])).toContain('sg');
    // now the only member is all-dead → 409 with code
    db.prepare('DELETE FROM suite_members WHERE suite_id = ? AND template_id = ?').run(sid, 'tpl_v2');
    const all = await app.inject({ method: 'POST', url: `/api/suites/${sid}/play`, payload: {} });
    expect(all.statusCode).toBe(409);
    expect((all.json() as { code?: string }).code).toBe('DEAD_VARIANTS');
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
