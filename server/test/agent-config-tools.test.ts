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
  const exec = (name: string, args: Record<string, unknown>, policy: { name: string; allows: 'read' | 'draft' } = READ): Promise<string> =>
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

  // ── Step 2: suite writes (F4: tx-catch mirrored, no partial writes) ─────

  it('suite.draft.save: happy path + bundle from first member', async () => {
    const out = await exec('suite.draft.save', { name: 'Agent Suite', members: [{ templateId: 'tpl_c1' }, { templateId: 'tpl_c2' }] }, DRAFT);
    const parsed = JSON.parse(out) as { suiteId: string; name: string; memberCount: number };
    expect(parsed.memberCount).toBe(2);
    const row = db.prepare('SELECT app_bundle_id FROM suites WHERE id = ?').get(parsed.suiteId) as { app_bundle_id: string };
    expect(row.app_bundle_id).toBe('com.test.app'); // derived from members
    const members = db.prepare('SELECT template_id, position FROM suite_members WHERE suite_id = ? ORDER BY position').all(parsed.suiteId) as Array<{ template_id: string; position: number }>;
    expect(members).toEqual([{ template_id: 'tpl_c1', position: 0 }, { template_id: 'tpl_c2', position: 1 }]);
  });

  it('mixed-bundle member → VERBATIM route 400; no partial write', async () => {
    db.prepare(`INSERT INTO templates(id, name, udid, steps_json, app_bundle_id, status, created_by, created_at, updated_at) VALUES ('tpl_other', 'Other App Case', '', '[]', 'com.other.app', 'active', 'seed', ?, ?)`).run(Date.now(), Date.now());
    const before = (db.prepare('SELECT COUNT(*) n FROM suite_members').get() as { n: number }).n;
    const out = await exec('suite.draft.save', { name: 'Mixed', members: [{ templateId: 'tpl_c1' }, { templateId: 'tpl_other' }] }, DRAFT);
    expect(out).toBe('INVALID: member tpl_other belongs to com.other.app — suite is com.test.app');
    const after = (db.prepare('SELECT COUNT(*) n FROM suite_members').get() as { n: number }).n;
    expect(after).toBe(before);
    expect(db.prepare('SELECT 1 FROM suites WHERE name = ?').get('Mixed')).toBeUndefined();
  });

  it('unknown template / variant-pin / duplicate-member → verbatim', async () => {
    expect(await exec('suite.draft.save', { name: 'X1', members: [{ templateId: 'nope' }] }, DRAFT)).toBe('INVALID: unknown template: nope');
    db.prepare(`UPDATE templates SET variants_json = ? WHERE id = 'tpl_c1'`).run(JSON.stringify([{ id: 'v1' }, { id: 'v2' }]));
    expect(await exec('suite.draft.save', { name: 'X2', members: [{ templateId: 'tpl_c1', variantIds: ['v9'] }] }, DRAFT)).toBe('INVALID: member tpl_c1: unknown variants v9');
    expect(await exec('suite.draft.save', { name: 'X3', members: [{ templateId: 'tpl_c1' }, { templateId: 'tpl_c1' }] }, DRAFT)).toBe('INVALID: duplicate member tpl_c1');
  });

  it('duplicate suite name → verbatim 409 via tx-catch; first suite untouched', async () => {
    const out = await exec('suite.draft.save', { name: 'My Suite', members: [{ templateId: 'tpl_c1' }] }, DRAFT);
    expect(out).toBe('INVALID: suite name already exists');
    const members = db.prepare('SELECT template_id FROM suite_members WHERE suite_id = ? ORDER BY position').all('suite_1') as Array<{ template_id: string }>;
    expect(members.map((m) => m.template_id)).toEqual(['tpl_c2', 'tpl_c1']); // unchanged
  });

  it('suite.draft.edit: rename + member replace; appBundleId immutable verbatim', async () => {
    const ok = await exec('suite.draft.edit', { idOrName: 'My Suite', name: 'My Suite v2', members: [{ templateId: 'tpl_c1', variantIds: ['v1'] }] }, DRAFT);
    expect(JSON.parse(ok) as object).toBeTruthy();
    const row = db.prepare('SELECT name FROM suites WHERE id = ?').get('suite_1') as { name: string };
    expect(row.name).toBe('My Suite v2');
    const members = db.prepare('SELECT template_id, variant_ids_json FROM suite_members WHERE suite_id = ? ORDER BY position').all('suite_1') as Array<{ template_id: string; variant_ids_json: string | null }>;
    expect(members).toEqual([{ template_id: 'tpl_c1', variant_ids_json: JSON.stringify(['v1']) }]); // wholesale replace
    const imm = await exec('suite.draft.edit', { idOrName: 'My Suite v2', appBundleId: 'com.other.app' }, DRAFT);
    expect(imm).toBe('INVALID: appBundleId is immutable — create a new suite to change app scope');
  });

  // ── Step 3: scenario + preset writes (F1 name guard, immutable-first, F2 sync) ──

  it('F1 regression: same-name scenario create CANNOT silently mutate', async () => {
    const first = await exec('scenario.draft.save', { name: 'pay-err', presetIds: ['p_a'] }, DRAFT);
    expect(JSON.parse(first) as object).toBeTruthy();
    // second create with the SAME name and DIFFERENT members → refusal, row untouched
    const second = await exec('scenario.draft.save', { name: 'pay-err', presetIds: ['p_b'] }, DRAFT);
    expect(second).toBe('INVALID: a scenario named "pay-err" already exists');
    const members = db.prepare('SELECT preset_id FROM scenario_overrides WHERE scenario_id = (SELECT id FROM scenarios WHERE name = ?)').all('pay-err') as Array<{ preset_id: string }>;
    expect(members.map((m) => m.preset_id)).toEqual(['p_a']); // NOT mutated
  });

  it('scenario save: unknown preset → verbatim', async () => {
    const out = await exec('scenario.draft.save', { name: 'pay-err-2', presetIds: ['p_zz'] }, DRAFT);
    expect(out).toBe('INVALID: unknown preset p_zz');
  });

  it('immutable guard fires BEFORE name-409; edit and members.set both refused', async () => {
    db.prepare(`UPDATE scenarios SET immutable_since = ? WHERE id = 's_one'`).run(Date.now());
    // rename that would ALSO collide — immutability message wins (order pinned)
    db.prepare(`INSERT INTO scenarios(id, name, created_by) VALUES ('s_clash', 'clash-name', 'seed')`).run();
    
    const edit = await exec('scenario.draft.edit', { idOrName: 's_one', name: 'clash-name' }, DRAFT);
    expect(edit).toMatch(/^INVALID: scenario is immutable/);
    expect(edit).toContain('duplicate');
    const members = await exec('scenario.members.set', { idOrName: 's_one', members: [{ presetId: 'p_a' }] }, DRAFT);
    expect(members).toMatch(/^INVALID: scenario is immutable/);
  });

  it('scenario edit: name 409 verbatim + happy rename', async () => {
    const clash = await exec('scenario.draft.edit', { idOrName: 's_two', name: 'clash-name' }, DRAFT);
    expect(clash).toBe('INVALID: a scenario named "clash-name" already exists');
    const ok = await exec('scenario.draft.edit', { idOrName: 's_two', description: 'renamed by agent' }, DRAFT);
    expect(JSON.parse(ok) as object).toBeTruthy();
    const row = db.prepare('SELECT description FROM scenarios WHERE id = ?').get('s_two') as { description: string | null };
    expect(row.description).toBe('renamed by agent');
  });

  it('preset save/edit: F2 sync fires + stamps mirrored; partial edit preserves untouched fields', async () => {
    const syncBefore = (app.agent as unknown as { syncPresetsCalls: number }).syncPresetsCalls ?? 0;
    const saved = JSON.parse(await exec('preset.draft.save', { pathPattern: '/v2/pay', status: 502, method: 'POST', seq: [{ status: 500, delayMs: 100 }], headers: { 'x-seed': '1' } }, DRAFT)) as { presetId: string };
    const row = db.prepare('SELECT method, seq_json, headers_json, created_by FROM presets WHERE id = ?').get(saved.presetId) as Record<string, unknown>;
    expect(row['method']).toBe('POST');
    expect(JSON.parse(row['seq_json'] as string)).toEqual([{ status: 500, delayMs: 100 }]);
    expect(row['created_by']).toBe('api'); // route default on CREATE (editor stamp is PATCH-only)
    // partial edit: pathPattern only — seq/headers intact, editor stamp, sync fired
    const edited = await exec('preset.draft.edit', { presetId: saved.presetId, pathPattern: '/v2/pay2' }, DRAFT);
    expect(JSON.parse(edited) as object).toBeTruthy();
    const row2 = db.prepare('SELECT path_pattern, seq_json, headers_json, created_by FROM presets WHERE id = ?').get(saved.presetId) as Record<string, unknown>;
    expect(row2['path_pattern']).toBe('/v2/pay2');
    expect(JSON.parse(row2['seq_json'] as string)).toEqual([{ status: 500, delayMs: 100 }]);
    expect(row2['created_by']).toBe('editor');
    const syncAfter = (app.agent as unknown as { syncPresetsCalls: number }).syncPresetsCalls ?? 0;
    expect(syncAfter).toBeGreaterThanOrEqual(syncBefore + 2); // save + edit both synced (F2)
  });

  it('preset save: required fields verbatim; edit: no-fields verbatim', async () => {
    expect(await exec('preset.draft.save', { status: 200 }, DRAFT)).toBe('INVALID: pathPattern and status required');
    expect(await exec('preset.draft.edit', { presetId: 'p_a' }, DRAFT)).toBe('INVALID: no updatable fields provided');
  });

  // ── Step 4: case lifecycle (edit guard, revise-from-copy, deprecate) ────

  it('case.draft.edit on an ACTIVE case → refusal naming revise; nothing written', async () => {
    db.prepare(`INSERT INTO templates(id, name, udid, steps_json, app_bundle_id, status, created_by, created_at, updated_at) VALUES ('tpl_active', 'Active Case', '', '[{"action":"tap","on":"x"}]', 'com.test.app', 'active', 'seed', ?, ?)`).run(Date.now(), Date.now());
    db.prepare(`INSERT INTO app_screens(app_bundle_id, screen_id, revision, entry_json, states_json, updated_at) VALUES ('com.test.app','scr-one',1,'{"navigate":[{"on":"root"}]}','{"default":{"all":[{"identifier":"scr_one_root"}]}}',?)`).run(Date.now());
    const out = await exec('case.draft.edit', { idOrName: 'Active Case', yaml: 'name: Active Case\napp: com.test.app\nsteps:\n  - tap: { on: y }\n' }, DRAFT);
    expect(out).toMatch(/^INVALID: case "Active Case" is active — use case\.draft\.revise/);
    const steps = db.prepare('SELECT steps_json FROM templates WHERE id = ?').get('tpl_active') as { steps_json: string };
    expect(steps.steps_json).toContain('"x"'); // untouched
  });

  it('case.draft.revise: active → NEW draft with user yaml; original untouched (F5)', async () => {
    const out = await exec('case.draft.revise', { idOrName: 'Active Case', yaml: 'name: Active Case v2\napp: com.test.app\nsteps:\n  - tap: { on: y }\n  - expect screen: scr-one.default\n' }, DRAFT);
    const parsed = JSON.parse(out) as { templateId: string; name: string; status: string };
    expect(parsed.name).toBe('Active Case v2');
    expect(parsed.status).toBe('draft');
    const orig = db.prepare('SELECT status, steps_json FROM templates WHERE id = ?').get('tpl_active') as { status: string; steps_json: string };
    expect(orig.status).toBe('active');
    expect(orig.steps_json).toContain('"x"'); // original untouched
    const copy = db.prepare('SELECT status, steps_json FROM templates WHERE id = ?').get(parsed.templateId) as { status: string; steps_json: string };
    expect(copy.status).toBe('draft');
    expect(copy.steps_json).toContain('"y"');
  });

  it('revise without yaml name → keeps the (copy) name (F5 pin); already-draft → refused', async () => {
    const out = await exec('case.draft.revise', { idOrName: 'Active Case', yaml: 'app: com.test.app\nsteps:\n  - tap: { on: z }\n' }, DRAFT);
    const parsed = JSON.parse(out) as { name: string };
    expect(parsed.name).toMatch(/^Active Case \(copy( 2)?\)$/); // F5: yaml without name keeps the collision-loop copy name
    const draftCase = 'Agent Suite'; // suite not case — use the LP fixture: create a draft first
    const made = await exec('case.draft.save', { yaml: 'name: Revise Me Draft\napp: com.test.app\nsteps:\n  - tap: { on: q }\n' }, DRAFT);
    void draftCase;
    const id = (JSON.parse(made) as { templateId: string }).templateId;
    const refused = await exec('case.draft.revise', { idOrName: id, yaml: 'name: Revise Me Draft\napp: com.test.app\nsteps:\n  - tap: { on: q }\n' }, DRAFT);
    expect(refused).toMatch(/^INVALID: already a draft — use case\.draft\.edit/);
  });

  it('revise with INVALID yaml → INVALID + copy id returned; copy SURVIVES with original steps', async () => {
    const out = await exec('case.draft.revise', { idOrName: 'Active Case', yaml: 'name: Broken Revise\napp: com.test.app\nsteps:\n  - expect screen: no-suchScreen.state\n' }, DRAFT);
    expect(out).toMatch(/^INVALID:/);
    expect(out).toMatch(/a plain draft copy was saved as tpl_/);
    const copyId = /tpl_[a-f0-9]+/.exec(out)![0]!;
    const copy = db.prepare('SELECT status, steps_json FROM templates WHERE id = ?').get(copyId) as { status: string; steps_json: string } | undefined;
    expect(copy).toBeTruthy();
    expect(copy!.status).toBe('draft');
    expect(copy!.steps_json).toContain('"x"'); // original steps preserved in the surviving copy
  });

  it('case.deprecate: active → deprecated; idempotent; draft refused', async () => {
    const ok = JSON.parse(await exec('case.deprecate', { idOrName: 'Active Case' }, DRAFT)) as { status: string };
    expect(ok.status).toBe('deprecated');
    const again = JSON.parse(await exec('case.deprecate', { idOrName: 'Active Case' }, DRAFT)) as { note?: string };
    expect(again['note']).toBe('already deprecated');
    const made = await exec('case.draft.save', { yaml: 'name: Draft To Deprecate\napp: com.test.app\nsteps:\n  - tap: { on: w }\n' }, DRAFT);
    const id = (JSON.parse(made) as { templateId: string }).templateId;
    const refused = await exec('case.deprecate', { idOrName: id }, DRAFT);
    expect(refused).toMatch(/^INVALID: drafts aren't deprecated/);
  });

  it('preset.body.write: atomic write + contentType merge + sync (route parity)', async () => {
    const before = (app.agent as unknown as { syncPresetsCalls: number }).syncPresetsCalls;
    const out = await exec('preset.body.write', { presetId: 'p_a', text: '{ "data": [{ "city": "MEDAN" }] }', contentType: 'application/json' }, DRAFT);
    const parsed = JSON.parse(out) as { bodyPath: string; bytes: number };
    expect(parsed.bytes).toBeGreaterThan(0);
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(parsed.bodyPath, 'utf8')).toContain('MEDAN');
    const row = db.prepare('SELECT body_path, headers_json FROM presets WHERE id = ?').get('p_a') as { body_path: string; headers_json: string };
    expect(row.body_path).toBe(parsed.bodyPath);
    expect(JSON.parse(row.headers_json)['content-type']).toBe('application/json');
    // oversized → verbatim
    const big = await exec('preset.body.write', { presetId: 'p_a', text: 'x'.repeat(262_200) }, DRAFT);
    expect(big).toMatch(/^INVALID: body too large/);
    const after = (app.agent as unknown as { syncPresetsCalls: number }).syncPresetsCalls;
    expect(after).toBe(before + 1);
  });

  it('scenario.duplicate: editable copy with members; immutable guard points at it', async () => {
    db.prepare(`UPDATE scenarios SET immutable_since = ? WHERE id = 's_one'`).run(Date.now());
    const out = await exec('scenario.duplicate', { idOrName: 's_one' }, DRAFT);
    const parsed = JSON.parse(out) as { scenarioId: string; name: string };
    expect(parsed.name).toMatch(/^scenario one \(copy/);
    const copy = db.prepare('SELECT immutable_since FROM scenarios WHERE id = ?').get(parsed.scenarioId) as { immutable_since: number | null };
    expect(copy.immutable_since).toBeNull();
    const members = db.prepare('SELECT preset_id FROM scenario_overrides WHERE scenario_id = ?').all(parsed.scenarioId) as Array<{ preset_id: string }>;
    expect(members.map((m) => m.preset_id).sort()).toEqual(['p_a', 'p_b']); // members carried
    // guard message now names the tool
    const refused = await exec('scenario.draft.edit', { idOrName: 's_one', description: 'x' }, DRAFT);
    expect(refused).toContain('use scenario.duplicate');
  });

  it('registry sweep: NO activate/delete tool names exist (condition 6)', () => {
    const names = app.agent.registry.list().map((t) => (t as { name: string }).name);
    expect(names.some((n) => /activate|delete/i.test(n))).toBe(false);
  });

  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
});
