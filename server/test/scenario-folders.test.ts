import { registerScenarioFolderRoutes } from '../src/routes/scenario-folders.ts';
import { registerForgeRoutes } from '../src/forge/routes.ts';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { migrateM1 } from '../src/db/schema.ts';
import { createHash } from 'node:crypto';

/** Plan 20260928T092527Z rev 2 — scenario folders (GLOBAL tree, no app
 *  scoping), list extensions (runCount/usedBy/changedSincePlay), duplicate.
 *  Review: F1 (snapshot-verbatim marker), F2 (three-surface usedBy +
 *  per-surface delete policy), F4 (duplicate isolation), F7 (both counts). */

let db: Database.Database;
let app: FastifyInstance;

const mkScenario = (id: string, name: string, folder: string | null = null, launchArg: string | null = null): void => {
  db.prepare(`INSERT INTO scenarios(id, name, launch_arg, folder_id, created_by, immutable_since) VALUES (?, ?, ?, ?, 'qa', NULL)`)
    .run(id, name, launchArg, folder);
};
const mkPreset = (id: string, path: string): void => {
  db.prepare(`INSERT INTO presets(id, method, path_pattern, match, status, headers_json, body_path, delay_ms, seq_json, failure, throttle_kbps, created_by, created_at, sha256, guards_json)
              VALUES (?, 'GET', ?, 'exact', 200, '{}', NULL, NULL, NULL, NULL, NULL, 'qa', 1, 'x', NULL)`).run(id, path);
};
const member = (scn: string, preset: string, enabled = 1): void => {
  db.prepare(`INSERT INTO scenario_overrides(scenario_id, preset_id, enabled) VALUES (?, ?, ?)`).run(scn, preset, enabled);
};
const mkCase = (id: string, name: string, variantsJson: string | null): void => {
  db.prepare(`INSERT INTO templates(id, name, steps_json, tags_json, udid, variants_json, created_by, created_at, updated_at)
              VALUES (?, ?, '[]', '[]', '', ?, 'qa', 1, 1)`).run(id, name, variantsJson);
};
const mkRun = (id: string, scnChoice: string, sha: string | null): void => {
  db.prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at, scenario_id, scenario_sha)
              VALUES (?, '-', 'manual', 'passed', 'qa', 'sim', 1, ?, ?)`).run(id, scnChoice, sha);
};

beforeEach(async () => {
  db = new Database(':memory:');
  migrateM1(db);
  app = Fastify();
  app.addHook('onRequest', async (req) => { (req as unknown as { user: unknown }).user = { name: 'qa', role: 'operator' }; });
  registerScenarioFolderRoutes(app, db);
  registerForgeRoutes(app, db, {} as never);
  await app.ready();
});
afterEach(async () => { await app.close(); db.close(); });

describe('scenario folders CRUD (global tree)', () => {
  it('creates root + nested folders; duplicate sibling name → 409; depth capped at 8', async () => {
    const r1 = await app.inject({ method: 'POST', url: '/api/scenario-folders', payload: { name: 'tariff worlds' } });
    expect(r1.statusCode).toBe(201);
    const f1 = (r1.json() as { id: string });
    const r2 = await app.inject({ method: 'POST', url: '/api/scenario-folders', payload: { parentId: f1.id, name: 'countries' } });
    expect(r2.statusCode).toBe(201);
    const dup = await app.inject({ method: 'POST', url: '/api/scenario-folders', payload: { name: 'tariff worlds' } });
    expect(dup.statusCode).toBe(409);
    // same name OK under a different parent
    const r3 = await app.inject({ method: 'POST', url: '/api/scenario-folders', payload: { name: 'countries' } });
    expect(r3.statusCode).toBe(201);
    // depth cap
    let parent = f1.id;
    let lastCode = 201;
    for (let i = 0; i < 9; i++) {
      const r = await app.inject({ method: 'POST', url: '/api/scenario-folders', payload: { parentId: parent, name: `l${i}` } });
      lastCode = r.statusCode;
      if (r.statusCode === 201) parent = (r.json() as { id: string }).id;
    }
    expect(lastCode).toBe(400);
  });

  it('delete: empty leaf OK; folder with scenario → 409 naming BOTH counts (F7)', async () => {
    const f1 = (await app.inject({ method: 'POST', url: '/api/scenario-folders', payload: { name: 'outer' } })).json() as { id: string };
    const f2 = (await app.inject({ method: 'POST', url: '/api/scenario-folders', payload: { parentId: f1.id, name: 'inner' } })).json() as { id: string };
    mkScenario('s_a', 'a', f2.id);
    const blocked = await app.inject({ method: 'DELETE', url: `/api/scenario-folders/${f1.id}` });
    expect(blocked.statusCode).toBe(409);
    const body = blocked.json() as { error: string };
    expect(body.error).toContain('1 scenario');
    expect(body.error).toContain('1 subfolder');
    // move the scenario away → both folders deletable
    await app.inject({ method: 'PATCH', url: '/api/forge/scenarios/s_a', payload: { folderId: null } });
    expect((await app.inject({ method: 'DELETE', url: `/api/scenario-folders/${f2.id}` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: `/api/scenario-folders/${f1.id}` })).statusCode).toBe(200);
  });

  it('children listing: folders first with SUBTREE scenario counts + direct scenario ids + path', async () => {
    const f1 = (await app.inject({ method: 'POST', url: '/api/scenario-folders', payload: { name: 'w' } })).json() as { id: string };
    const f2 = (await app.inject({ method: 'POST', url: '/api/scenario-folders', payload: { parentId: f1.id, name: 'c' } })).json() as { id: string };
    mkScenario('s_root', 'root case');
    mkScenario('s_deep', 'deep', f2.id);
    mkScenario('s_direct', 'direct', f1.id);
    const root = (await (await app.inject({ method: 'GET', url: '/api/scenario-folders' })).json()) as { folders: Array<{ id: string; name: string; scenarioCount: number }>; scenarios: Array<{ id: string; name: string }> };
    expect(root.folders.map((f) => f.name)).toEqual(['w']);
    expect(root.folders[0]!.scenarioCount).toBe(2); // direct + deep
    expect(root.scenarios.map((s) => s.id)).toEqual(['s_root']);
    const inner = (await (await app.inject({ method: 'GET', url: `/api/scenario-folders?parentId=${f1.id}` })).json()) as { folders: unknown[]; scenarios: Array<{ id: string }>; path: Array<{ name: string }> };
    expect(inner.folders.length).toBe(1);
    expect(inner.scenarios.map((s) => s.id)).toEqual(['s_direct']);
    expect(inner.path.map((pp) => pp.name)).toEqual(['w']);
  });
});

describe('scenario list extensions', () => {
  it('runCount matches id OR name (runs store the choice string); usedBy scans three surfaces; changedSincePlay via scenarioSnapshot (F1/F2)', async () => {
    mkPreset('p_1', '/v1/tariff');
    mkScenario('s_sg', 'countries-sg');
    member('s_sg', 'p_1');
    mkCase('tpl_1', 'intl drill', JSON.stringify([{ id: 'sg', scenarios: ['countries-sg'] }]));
    mkRun('run_1', 'countries-sg', null); // name-keyed provenance
    // stamped sha from the VERBATIM snapshot fn (F1: same recipe, no parallel)
    const { scenarioSnapshot } = await import('../src/manual/case-versions.ts');
    const sha = createHash('sha256').update(JSON.stringify(scenarioSnapshot(db, 's_sg'))).digest('hex');
    mkRun('run_2', 'countries-sg', sha);
    const list = (await (await app.inject({ method: 'GET', url: '/api/forge/scenarios' })).json()) as { scenarios: Array<Record<string, unknown>> };
    const row = list.scenarios.find((s) => s.id === 's_sg')!;
    expect(row.runCount).toBe(2); // both id- and name-keyed runs count
    expect(row.memberCount).toBe(1);
    expect(JSON.stringify(row.usedBy)).toContain('variant `sg` of case “intl drill”');
    expect(row.changedSincePlay).toBe(false); // sha matches → unchanged
    // membership edit flips the marker (disable the member — snapshot only counts enabled)
    db.prepare('UPDATE scenario_overrides SET enabled = 0 WHERE scenario_id = ? AND preset_id = ?').run('s_sg', 'p_1');
    const list2 = (await (await app.inject({ method: 'GET', url: '/api/forge/scenarios' })).json()) as { scenarios: Array<Record<string, unknown>> };
    expect((list2.scenarios.find((s) => s.id === 's_sg') as Record<string, unknown>).changedSincePlay).toBe(true);
  });

  it('duplicate copies membership + launch_arg into the source folder; source untouched (F4)', async () => {
    mkPreset('p_1', '/v1/tariff');
    const f1 = (await app.inject({ method: 'POST', url: '/api/scenario-folders', payload: { name: 'w' } })).json() as { id: string };
    mkScenario('s_sg', 'countries-sg', f1.id, 'LP_COUNTRY=SG');
    member('s_sg', 'p_1');
    const dup = await app.inject({ method: 'POST', url: '/api/forge/scenarios/s_sg/duplicate', payload: { name: 'countries-sg-2' } });
    expect(dup.statusCode).toBe(201);
    const d = dup.json() as { id: string };
    expect(d.id).not.toBe('s_sg');
    const srcMembers = db.prepare('SELECT preset_id, enabled FROM scenario_overrides WHERE scenario_id = ?').all('s_sg');
    expect(srcMembers.length).toBe(1); // source untouched
    const dupRow = db.prepare('SELECT name, launch_arg, folder_id, immutable_since FROM scenarios WHERE id = ?').get(d.id) as { name: string; launch_arg: string | null; folder_id: string | null; immutable_since: number | null };
    expect(dupRow).toMatchObject({ name: 'countries-sg-2', launch_arg: 'LP_COUNTRY=SG', folder_id: f1.id, immutable_since: null });
    const dupMembers = db.prepare('SELECT preset_id, enabled FROM scenario_overrides WHERE scenario_id = ?').all(d.id);
    expect(dupMembers).toEqual([{ preset_id: 'p_1', enabled: 1 }]);
  });
});

describe('scenario delete policy (F2)', () => {
  it('409 when a variant pins it (by name or id); warn-only when only runs reference it', async () => {
    mkScenario('s_sg', 'countries-sg');
    mkCase('tpl_1', 'intl drill', JSON.stringify([{ id: 'sg', scenarios: ['countries-sg'] }]));
    const blocked = await app.inject({ method: 'DELETE', url: '/api/forge/scenarios/s_sg' });
    expect(blocked.statusCode).toBe(409);
    const body = blocked.json() as { error: string; consumers: Array<{ label: string }> };
    expect(body.consumers.length).toBeGreaterThan(0);
    expect(body.error).toContain('intl drill');
    // remove the pin → runs-only → proceeds with warning + count
    db.prepare('UPDATE templates SET variants_json = NULL WHERE id = ?').run('tpl_1');
    mkRun('run_1', 'countries-sg', null);
    mkRun('run_2', 'countries-sg', null);
    const allowed = await app.inject({ method: 'DELETE', url: '/api/forge/scenarios/s_sg' });
    expect(allowed.statusCode).toBe(200);
    const w = allowed.json() as { warning?: string; runCount?: number };
    expect(w.runCount).toBe(2);
    expect(w.warning).toContain('2 run');
  });

  it('case_versions pins block too (id or name)', async () => {
    mkScenario('s_old', 'account-active');
    db.prepare(`INSERT INTO case_versions(id, template_id, revision, steps_sha256, yaml_canonical, scenario_id, source, created_by, created_at)
                VALUES ('cv_1', 'tpl_x', 1, 'h', '', 'account-active', 'run', 'qa', 1)`).run();
    const r = await app.inject({ method: 'DELETE', url: '/api/forge/scenarios/s_old' });
    expect(r.statusCode).toBe(409);
  });
});

describe('preset delete guard (F3)', () => {
  it('409 naming member scenarios whenever an override row exists — even enabled=0', async () => {
    mkPreset('p_1', '/v1/tariff');
    mkScenario('s_sg', 'countries-sg');
    member('s_sg', 'p_1', 0); // DISABLED member still guards
    const r = await app.inject({ method: 'DELETE', url: '/api/forge/presets/p_1' });
    expect(r.statusCode).toBe(409);
    const body = r.json() as { error: string };
    expect(body.error).toContain('countries-sg');
    // remove membership → delete proceeds
    db.prepare('DELETE FROM scenario_overrides WHERE preset_id = ?').run('p_1');
    const ok = await app.inject({ method: 'DELETE', url: '/api/forge/presets/p_1' });
    expect(ok.statusCode).toBe(200);
  });
});
