/** Phase C T3 — single-play expansion: variants case → one run per variant
 *  (sequential, declaration order); `variant:` body param runs exactly one. */
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

let db: Database.Database;
let tmp: string;
let app: Awaited<ReturnType<typeof buildApp>>;

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
let FAKE_NODES: SnapNode[];

beforeEach(async () => {
  // static fake hierarchies settle instantly — shrink the expect settle
  // window like playback-expect does, or each run polls for seconds
  process.env.CRUCIBLE_EXPECT_SETTLE_MS = '10';
  process.env.CRUCIBLE_EXPECT_POLL_MS = '5';
  tmp = mkdtempSync(join(tmpdir(), 'pc-t3-'));
  const dbPath = join(tmp, 't.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  migrateM1(db);
  migrateM1(db);
  __setAlloyForTest(fakeAlloy()); // seam first — initAlloyRuntime resolves it
  const { initAlloyRuntime } = await import('../src/alloy/runtime.ts');
  await initAlloyRuntime();
  app = await buildApp({ CRUCIBLE_REQUIRE_AUTH: '0', CRUCIBLE_DB_PATH: dbPath, CRUCIBLE_ARTIFACTS_DIR: tmp, VITEST: 'true' });
  await app.app.ready();
  // post-resolveUdid harness rule: a BOOTED devices row matching the
  // template's recorded udid, or device resolution 400s every play
  db.prepare(`INSERT INTO devices(udid, name, state, platform, kind, last_seen) VALUES ('sim-1', 'Sim One', 'Booted', 'ios', 'simulator', ?)`).run(Date.now());
  FAKE_NODES = [
    { index: 0, parentIndex: -1, type: 'Application', label: 'App', rect: { x: 0, y: 0, width: 428, height: 926 }, hittable: false },
    { index: 1, parentIndex: 0, type: 'StaticText', label: 'Anything', rect: { x: 0, y: 0, width: 100, height: 10 }, hittable: true },
  ];
});
afterEach(async () => {
  // Background runs (variantless/one-shot paths return WITHOUT awaiting
  // done) are still mid-flight at assert time — wait for every run this
  // test created to reach its terminal write BEFORE teardown closes the DB.
  // Bounded poll on finished_at; the fake settles in ms, this only guards
  // the last async hop of the run bookkeeping.
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

function seedTemplate(id: string, steps: unknown[], variants: unknown[] | null): void {
  db.prepare(`INSERT INTO templates(id, name, ticket_key, udid, steps_json, variants_json, app_bundle_id, logical_w, logical_h, tags_json, created_by, created_at, updated_at)
              VALUES (?, ?, NULL, 'sim-1', ?, ?, NULL, 428, 926, '[]', 'qa', 0, 0)`).run(id, id, JSON.stringify(steps), variants ? JSON.stringify(variants) : null);
}

const STEPS = [{ idx: 0, action: 'expect', selector: { label: 'Anything' } }];
const THREE = [
  { id: 'active', env: { t: 'A' } },
  { id: 'pending', env: { t: 'P' } },
  { id: 'rejected', env: { t: 'R' } },
];

describe('POST /api/templates/:id/play — variant expansion', () => {
  it('no variants → exactly today\'s response shape {runId, udid}', async () => {
    seedTemplate('tpl_s1', STEPS, null);
    const r = await app.app.inject({ method: 'POST', url: '/api/templates/tpl_s1/play', payload: {} });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { runId: string; udid: string; runIds?: string[] };
    expect(body.runId).toBeTruthy();
    expect(body.runIds).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) n FROM runs WHERE template_id = ?').get('tpl_s1')).toMatchObject({ n: 1 });
  });

  it('3 variants → 3 runs, declaration order, each stamped; response carries runIds + per-variant map', { timeout: 90_000 }, async () => {
    seedTemplate('tpl_s2', STEPS, THREE);
    const r = await app.app.inject({ method: 'POST', url: '/api/templates/tpl_s2/play', payload: {} });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { runIds: string[]; variants: Array<{ id: string; runId: string }> };
    expect(body.runIds).toHaveLength(3);
    expect(body.variants.map((v) => v.id)).toEqual(['active', 'pending', 'rejected']);
    const rows = db.prepare('SELECT variant_id FROM runs WHERE template_id = ? ORDER BY started_at').all('tpl_s2') as Array<{ variant_id: string | null }>;
    expect(rows.map((x) => x.variant_id)).toEqual(['active', 'pending', 'rejected']);
  });

  it('variant: "pending" → exactly ONE run, stamped pending', async () => {
    seedTemplate('tpl_s3', STEPS, THREE);
    const r = await app.app.inject({ method: 'POST', url: '/api/templates/tpl_s3/play', payload: { variant: 'pending' } });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { runId: string; variants: Array<{ id: string }> };
    expect(body.variants).toEqual([{ id: 'pending', runId: body.runId }]);
    expect(db.prepare('SELECT COUNT(*) n FROM runs WHERE template_id = ?').get('tpl_s3')).toMatchObject({ n: 1 });
    expect(db.prepare('SELECT variant_id FROM runs WHERE template_id = ?').get('tpl_s3')).toMatchObject({ variant_id: 'pending' });
  });

  it('unknown variant id → 422 naming it and listing what exists', async () => {
    seedTemplate('tpl_s4', STEPS, THREE);
    const r = await app.app.inject({ method: 'POST', url: '/api/templates/tpl_s4/play', payload: { variant: 'nope' } });
    expect(r.statusCode).toBe(422);
    const body = r.json() as { error: string };
    expect(body.error).toContain('no variant "nope"');
    expect(body.error).toContain('active, pending, rejected');
    expect(db.prepare('SELECT COUNT(*) n FROM runs WHERE template_id = ?').get('tpl_s4')).toMatchObject({ n: 0 });
  });

  it('variant param on a variantless case → 422 honest', async () => {
    seedTemplate('tpl_s5', STEPS, null);
    const r = await app.app.inject({ method: 'POST', url: '/api/templates/tpl_s5/play', payload: { variant: 'x' } });
    expect(r.statusCode).toBe(422);
    expect((r.json() as { error: string }).error).toContain('case has no variants');
  });
});
