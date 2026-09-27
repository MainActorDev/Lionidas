/** Phase C T4 — batch variant expansion: variants case → one lane entry per
 *  variant, stamped runs; planner dedupes on templateId+variantId. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/index.ts';
import { __setAlloyForTest } from '../src/alloy/client.ts';
import type { AlloyExports } from '../src/alloy/client.ts';
import type { SnapNode } from '../src/manual/selector.ts';
import { migrateM1 } from '../src/db/schema.ts';
import { planLanes } from '../src/manual/batch/plan.ts';
import { hasAlloy } from './helpers/capabilities.ts';
const describeIfAlloy = describe.skipIf(!(hasAlloy()));  // variant lanes play through the alloy runtime

let db: Database.Database;
let tmp: string;
let app: Awaited<ReturnType<typeof buildApp>>;

const FAKE_NODES: SnapNode[] = [
  { index: 0, parentIndex: -1, type: 'Application', label: 'App', rect: { x: 0, y: 0, width: 428, height: 926 }, hittable: false },
  { index: 1, parentIndex: 0, type: 'StaticText', label: 'Anything', rect: { x: 0, y: 0, width: 100, height: 10 }, hittable: true },
];

function fakeAlloy(): AlloyExports {
  return {
    createRuntime: async () => ({ state: {}, deps: null }),
    dispatch: async (tool: string) => {
      if (tool === 'alloy_apps') return { ok: true, result: {} };
      if (tool === 'alloy_snapshot') return { ok: true, result: { nodes: FAKE_NODES, root: { rect: { width: 428, height: 926 } } } };
      if (tool === 'alloy_act') return { ok: true, result: {} };
      if (tool === 'alloy_screenshot') return { ok: true, result: { path: '/dev/null' } };
      return { ok: true, result: {} };
    },
  } as unknown as AlloyExports;
}

beforeEach(async () => {
  process.env.CRUCIBLE_EXPECT_SETTLE_MS = '10';
  process.env.CRUCIBLE_EXPECT_POLL_MS = '5';
  tmp = mkdtempSync(join(tmpdir(), 'pc-t4-'));
  const dbPath = join(tmp, 't.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  migrateM1(db);
  migrateM1(db);
  db.prepare(`INSERT INTO devices(udid, name, state, platform, kind, last_seen) VALUES ('sim-1', 'Sim One', 'Booted', 'ios', 'simulator', ?)`).run(Date.now());
  __setAlloyForTest(fakeAlloy());
  const { initAlloyRuntime } = await import('../src/alloy/runtime.ts');
  await initAlloyRuntime();
  app = await buildApp({ CRUCIBLE_REQUIRE_AUTH: '0', CRUCIBLE_DB_PATH: dbPath, CRUCIBLE_ARTIFACTS_DIR: tmp, VITEST: 'true' });
  await app.app.ready();
});
afterEach(async () => {
  __setAlloyForTest(null);
  const { resetAlloyRuntimeForTests } = await import('../src/alloy/runtime.ts');
  resetAlloyRuntimeForTests();
  await app.close();
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

function seedTemplate(id: string, steps: unknown[], variants: unknown[] | null): void {
  db.prepare(`INSERT INTO templates(id, name, ticket_key, udid, steps_json, variants_json, app_bundle_id, logical_w, logical_h, tags_json, created_by, created_at, updated_at)
              VALUES (?, ?, NULL, 'sim-1', ?, ?, NULL, 428, 926, '["batch"]', 'qa', 0, 0)`).run(id, id, JSON.stringify(steps), variants ? JSON.stringify(variants) : null);
}

const STEPS = [{ idx: 0, action: 'expect', selector: { label: 'Anything' } }];

describeIfAlloy('planLanes — variantId dedupe (unit)', () => {
  it('templateId+variantId dedupes; same template different variants BOTH survive', () => {
    const lanes = planLanes({
      cases: [
        { templateId: 't1', variantId: 'a', costMs: null },
        { templateId: 't1', variantId: 'a', costMs: null }, // dup — dropped
        { templateId: 't1', variantId: 'b', costMs: null }, // sibling — kept
        { templateId: 't2', costMs: null },
      ],
      devices: [{ udid: 's', name: null }],
    });
    const ids = lanes[0]!.cases.map((c) => `${c.templateId}/${c.variantId ?? ''}`);
    expect(ids).toEqual(['t1/a', 't1/b', 't2/']);
  });
});

describeIfAlloy('runBatch — variant expansion (route)', () => {
  it('2-variant case + plain case → 3 stamped runs', { timeout: 60_000 }, async () => {
    seedTemplate('tpl_bv', STEPS, [{ id: 'on', env: { t: '1' } }, { id: 'off', env: { t: '0' } }]);
    seedTemplate('tpl_bp', STEPS, null);
    const r = await app.app.inject({ method: 'POST', url: '/api/templates/play-all', payload: { tags: 'batch', udid: 'sim-1' } });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { runIds: string[]; count: number };
    expect(body.count).toBe(2); // 2 cases selected
    expect(body.runIds).toHaveLength(3); // 2 variants + 1 plain
    const rows = db.prepare('SELECT variant_id FROM runs WHERE template_id = ? ORDER BY started_at').all('tpl_bv') as Array<{ variant_id: string | null }>;
    expect(rows.map((x) => x.variant_id).sort()).toEqual(['off', 'on']);
    const plain = db.prepare('SELECT variant_id FROM runs WHERE template_id = ?').get('tpl_bp') as { variant_id: string | null };
    expect(plain.variant_id).toBeNull();
  });
});
