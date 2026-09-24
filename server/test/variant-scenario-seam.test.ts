/** Phase C drill regression — variant scenario seam:
 *  1. variant.networkScenario carries a scenario NAME (phase B vocabulary)
 *  2. activation + version snapshot resolve name→id and actually fire
 *  3. runs row records the raw CHOICE, case_versions gets a real snapshot */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/index.ts';
import { __setAlloyForTest } from '../src/alloy/client.ts';
import { __setForgeHealthForTest } from '../src/forge/health.ts';
import type { AlloyExports } from '../src/alloy/client.ts';
import type { SnapNode } from '../src/manual/selector.ts';
import { migrateM1 } from '../src/db/schema.ts';
import { hasAlloy } from './helpers/capabilities.ts';
const describeIfAlloy = describe.skipIf(!(hasAlloy()));  // scenario seams reach the alloy runtime

let db: Database.Database;
let tmp: string;
let app: Awaited<ReturnType<typeof buildApp>>;

const FAKE_NODES: SnapNode[] = [
  { index: 0, parentIndex: -1, type: 'Application', label: 'App', rect: { x: 0, y: 0, width: 428, height: 926 }, hittable: false },
  { index: 1, parentIndex: 0, type: 'StaticText', label: 'ACCOUNT', rect: { x: 0, y: 0, width: 100, height: 10 }, hittable: true },
];

function fakeAlloy(): AlloyExports {
  return {
    createRuntime: async () => ({ state: {}, deps: null }),
    dispatch: async (tool: string) => {
      if (tool === 'alloy_snapshot') return { ok: true, result: { nodes: FAKE_NODES, root: { rect: { width: 428, height: 926 } } } };
      return { ok: true, result: {} };
    },
  } as unknown as AlloyExports;
}

beforeEach(async () => {
  process.env.CRUCIBLE_EXPECT_SETTLE_MS = '10';
  process.env.CRUCIBLE_EXPECT_POLL_MS = '5';
  tmp = mkdtempSync(join(tmpdir(), 'pc-seam-'));
  const dbPath = join(tmp, 't.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  migrateM1(db);
  __setForgeHealthForTest({ mitmRunning: true, routingEnabled: true }); // T7: scenario tests assume a live chain
  db.prepare(`INSERT INTO devices(udid, name, state, platform, kind, last_seen) VALUES ('sim-1', 'Sim One', 'Booted', 'ios', 'simulator', ?)`).run(Date.now());
  // a scenario named like the variant vocabulary will reference it
  db.prepare(`INSERT INTO scenarios(id, name, description, launch_arg, created_by, immutable_since) VALUES ('s_world1', 'account-active', 'x', NULL, 'qa', NULL)`).run();
  db.prepare(`INSERT INTO presets(id, method, path_pattern, match, status, headers_json, body_path, delay_ms, seq_json, failure, throttle_kbps, guards_json, created_by, created_at, sha256)
              VALUES ('p_w1', 'GET', '/v2/account/profile/me', 'exact', 200, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'qa', 0, 'x')`).run();
  db.prepare(`INSERT INTO scenario_overrides(scenario_id, preset_id, enabled) VALUES ('s_world1', 'p_w1', 1)`).run();
  db.prepare(`INSERT INTO templates(id, name, ticket_key, udid, steps_json, variants_json, app_bundle_id, logical_w, logical_h, tags_json, created_by, created_at, updated_at)
              VALUES ('tpl_seam', 'seam case', NULL, 'sim-1', ?, ?, NULL, 428, 926, '[]', 'qa', 0, 0)`)
    .run(JSON.stringify([{ idx: 0, action: 'expect', selector: { labelContains: 'ACCOUNT' } }]),
         JSON.stringify([{ id: 'active', networkScenario: 'account-active', env: { WORLD: 'active' } }]));
  __setAlloyForTest(fakeAlloy());
  const { initAlloyRuntime } = await import('../src/alloy/runtime.ts');
  await initAlloyRuntime();
  app = await buildApp({ CRUCIBLE_REQUIRE_AUTH: '0', CRUCIBLE_DB_PATH: dbPath, CRUCIBLE_ARTIFACTS_DIR: tmp, VITEST: 'true' });
  await app.app.ready();
});
afterEach(async () => {
  __setForgeHealthForTest(null);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const pending = (db.prepare('SELECT COUNT(*) AS n FROM runs WHERE finished_at IS NULL').get() as { n: number }).n;
    if (pending === 0) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  __setAlloyForTest(null);
  const { resetAlloyRuntimeForTests } = await import('../src/alloy/runtime.ts');
  resetAlloyRuntimeForTests();
  await app.close();
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describeIfAlloy('variant scenario seam — name→id resolution', () => {
  it('variant by NAME: snapshot non-NULL, activation fires, run records the choice', { timeout: 60_000 }, async () => {
    const r = await app.app.inject({ method: 'POST', url: '/api/templates/tpl_seam/play', payload: {} });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { runIds: string[] };
    expect(body.runIds).toHaveLength(1);
    const runId = body.runIds[0]!;

    // wait for run completion (route awaits done for expansions)
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const row = db.prepare('SELECT finished_at FROM runs WHERE id = ?').get(runId) as { finished_at: string | null } | undefined;
      if (row?.finished_at) break;
      await new Promise((res) => setTimeout(res, 50));
    }
    const run = db.prepare('SELECT scenario_id, variant_id, status FROM runs WHERE id = ?').get(runId) as { scenario_id: string; variant_id: string; status: string };
    expect(run.variant_id).toBe('active');
    expect(run.scenario_id).toBe('account-active');       // the raw CHOICE
    expect(run.status).toBe('passed');

    const cv = db.prepare('SELECT scenario_id, scenario_snapshot_json FROM case_versions WHERE template_id = ? ORDER BY revision DESC LIMIT 1').get('tpl_seam') as { scenario_id: string | null; scenario_snapshot_json: string | null };
    expect(cv.scenario_id).toBe('s_world1');               // RESOLVED id
    expect(cv.scenario_snapshot_json).toBeTruthy();        // real snapshot, not NULL
    expect(JSON.parse(cv.scenario_snapshot_json!).presets[0].id).toBe('p_w1');
  });
});
