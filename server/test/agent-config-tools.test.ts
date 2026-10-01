import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/index.ts';

/** Breakdown steps_001: read tools (suites/scenarios/presets) + folders.tree
 *  kind param. F3: route-shape parity (scenarios.get members join). F6:
 *  global vs app-scoped folder trees. Steps 2-3 write tests extend this file. */

// butler is a pinned dep: static import (its absence fails the transform honestly)
import { ToolRegistry as _TR } from '@mainactordev/butler';
const hasButler = typeof _TR === 'function';

describe.skipIf(!hasButler)('config tools (read + write, route-faithful)', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let db: import('better-sqlite3').Database;
  let dir: string;
  let syncSpy: { calls: number };
  const CTX = { sessionId: 'cfg', signal: undefined };
  const READ = { name: 'read', allows: 'read' as const };
  const DRAFT = { name: 'draft', allows: 'draft' as const };
  const exec = (name: string, args: Record<string, unknown>, policy = READ): Promise<string> =>
    app.agent.registry.execute(name, args, CTX, policy);

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cfg-tools-'));
    process.env['CRUCIBLE_DB_PATH'] = join(dir, 't.db');
    process.env['CRUCIBLE_ARTIFACTS_DIR'] = join(dir, 'artifacts');
    process.env['CRUCIBLE_SILENT'] = '1';
    process.env['CRUCIBLE_WATCHDOG'] = '0';
    process.env['CRUCIBLE_PIN'] = 'cli-test-pin-1';
    app = await buildApp(process.env);
    db = (app as unknown as { db: { raw: import('better-sqlite3').Database } }).db.raw;
    syncSpy = { calls: 0 };
    const now = Date.now();

    // ── seed: two cases (same bundle), one suite with both, one scenario with
    // two preset members, one preset in a preset folder, folders in both trees
    for (const [id, name] of [['tpl_c1', 'Case One'], ['tpl_c2', 'Case Two']] as const) {
      db.prepare(`INSERT INTO templates(id, name, udid, steps_json, app_bundle_id, status, created_by, created_at, updated_at) VALUES (?, ?, '', '[]', 'com.test.app', 'active', 'seed', ?, ?)`).run(id, name, now, now);
    }
    db.prepare(`INSERT INTO suites(id, name, app_bundle_id, created_by, created_at, updated_at) VALUES ('suite_1', 'My Suite', 'com.test.app', 'seed', ?, ?)`).run(now, now);
    const ins = db.prepare('INSERT INTO suite_members(suite_id, template_id, variant_ids_json, position) VALUES (?, ?, ?, ?)');
    ins.run('suite_1', 'tpl_c2', null, 0);
    ins.run('suite_1', 'tpl_c1', JSON.stringify(['v1']), 1);

    db.prepare(`INSERT INTO preset_folders(id, parent_id, name, created_by, created_at, updated_at) VALUES ('pf_1', NULL, 'Errors', 'seed', ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO presets(id, method, path_pattern, match, status, headers_json, created_by, created_at, sha256) VALUES ('p_a', 'GET', '/v2/a', 'exact', 200, NULL, 'seed', ?, 'x')`).run(now);
    db.prepare(`INSERT INTO presets(id, method, path_pattern, match, status, headers_json, created_by, created_at, sha256, folder_id) VALUES ('p_b', 'POST', '/v2/b', 'glob', 502, NULL, 'seed', ?, 'y', 'pf_1')`).run(now);
    db.prepare(`INSERT INTO scenario_folders(id, parent_id, name, created_by, created_at, updated_at) VALUES ('sf_1', NULL, 'Net', 'seed', ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO scenarios(id, name, description, launch_arg, created_by, immutable_since, folder_id) VALUES ('s_one', 'scenario one', NULL, NULL, 'seed', NULL, NULL)`).run();
    db.prepare(`INSERT INTO scenarios(id, name, description, launch_arg, created_by, immutable_since, folder_id) VALUES ('s_two', 'scenario two', NULL, NULL, 'seed', NULL, 'sf_1')`).run();
    db.prepare('INSERT INTO scenario_overrides(scenario_id, preset_id, enabled) VALUES (?, ?, 1)').run('s_one', 'p_a');
    db.prepare('INSERT INTO scenario_overrides(scenario_id, preset_id, enabled) VALUES (?, ?, 0)').run('s_one', 'p_b');
  });

  // ── Step 1: reads ─────────────────────────────────────────────────────────

  it('suites.list: members with template names, NO verdict keys', async () => {
    const out = JSON.parse(await exec('suites.list', {})) as Array<Record<string, unknown>>;
    const s = out.find((r) => r['id'] === 'suite_1');
    expect(s).toBeTruthy();
    expect(s!['name']).toBe('My Suite');
    const members = s!['members'] as Array<Record<string, unknown>>;
    expect(members.map((m) => m['templateId'])).toEqual(['tpl_c2', 'tpl_c1']); // position order
    expect(members[1]!['variantIds']).toEqual(['v1']);
    expect(JSON.stringify(s)).not.toMatch(/verdict|playState/i);
  });

  it('suites.get by name and id', async () => {
    const byName = JSON.parse(await exec('suites.get', { idOrName: 'My Suite' })) as Record<string, unknown>;
    expect(byName['id']).toBe('suite_1');
    const byId = JSON.parse(await exec('suites.get', { idOrName: 'suite_1' })) as Record<string, unknown>;
    expect(byId['name']).toBe('My Suite');
    const miss = await exec('suites.get', { idOrName: 'nope' });
    expect(miss).toMatch(/^error: no suite/);
  });

  it('scenarios.get: members join parity with the route (F3)', async () => {
    const out = JSON.parse(await exec('scenarios.get', { idOrName: 'scenario one' })) as { scenario: Record<string, unknown>; members: Array<Record<string, unknown>> };
    expect(out.scenario['name']).toBe('scenario one');
    // the route's join: preset_id, enabled, method, path_pattern, status
    expect(out.members).toEqual([
      { preset_id: 'p_a', enabled: 1, method: 'GET', path_pattern: '/v2/a', status: 200 },
      { preset_id: 'p_b', enabled: 0, method: 'POST', path_pattern: '/v2/b', status: 502 },
    ]);
  });

  it('scenarios.list / presets.list with folderId direct-children rule', async () => {
    const all = JSON.parse(await exec('scenarios.list', {})) as Array<Record<string, unknown>>;
    expect(all.length).toBe(2);
    const inFolder = JSON.parse(await exec('scenarios.list', { folderId: 'sf_1' })) as Array<Record<string, unknown>>;
    expect(inFolder.map((r) => r['id'])).toEqual(['s_two']);
    const root = JSON.parse(await exec('scenarios.list', { folderId: '' })) as Array<Record<string, unknown>>;
    expect(root.map((r) => r['id'])).toEqual(['s_one']);
    const presets = JSON.parse(await exec('presets.list', { folderId: 'pf_1' })) as Array<Record<string, unknown>>;
    expect(presets.map((r) => r['id'])).toEqual(['p_b']);
  });

  it('folders.tree kind matrix (F6): cases app-scoped, scenarios/presets global', async () => {
    const cases = JSON.parse(await exec('folders.tree', { kind: 'cases' })) as Array<Record<string, unknown>>;
    expect(JSON.stringify(cases)).not.toContain('Net'); // global trees don't leak into cases
    const scen = JSON.parse(await exec('folders.tree', { kind: 'scenarios' })) as Array<Record<string, unknown>>;
    expect(scen[0]!['name']).toBe('Net');
    expect(scen[0]!['count']).toBe(1);
    const pres = JSON.parse(await exec('folders.tree', { kind: 'presets' })) as Array<Record<string, unknown>>;
    expect(pres[0]!['name']).toBe('Errors');
    expect(pres[0]!['count']).toBe(1);
    // default kind = cases (unchanged behavior)
    const def = JSON.parse(await exec('folders.tree', {})) as Array<Record<string, unknown>>;
    expect(JSON.stringify(def)).toEqual(JSON.stringify(cases));
    const bad = await exec('folders.tree', { kind: 'bogus' });
    expect(bad).toMatch(/^error: unknown kind/);
  });

  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
});
