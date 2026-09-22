import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateM1 } from '../src/db/schema.ts';
import { registerManualRoutes } from '../src/routes/manual.ts';
import { __setAlloyForTest } from '../src/alloy/client.ts';
import { __setForgeHealthForTest } from '../src/forge/health.ts';
import type { FastifyInstance } from 'fastify';

/** Overview slice T2 — batch stamping. Every run minted by a batch engine
 *  (play-all / suite play) carries the SAME batch_id; the solo variant
 *  lane-chain play mints its own; true solo plays stay NULL. */
let db: Database.Database;
let app: FastifyInstance;
let tmp: string;

// proven fake shape (playback-variant.test.ts): tool-aware envelope with a
// matching node so expect steps settle instead of walking into probe paths
const snapshotNodes = [{ label: 'Home Screen', rect: { x: 0, y: 0, width: 428, height: 926 } }];
const fakeAlloy = () => ({
  dispatch: async (tool: string) => {
    if (tool === 'alloy_snapshot') return { ok: true, result: { nodes: snapshotNodes, root: { rect: { width: 428, height: 926 } } } };
    return { ok: true, result: {} };
  },
});

beforeEach(async () => {
  process.env.CRUCIBLE_EXPECT_SETTLE_MS = '10';
  process.env.CRUCIBLE_EXPECT_POLL_MS = '5';
  tmp = mkdtempSync(join(tmpdir(), 'ov-stamp-'));
  db = new Database(join(tmp, 't.db'));
  db.pragma('journal_mode = WAL');
  migrateM1(db);
  __setAlloyForTest({ dispatch: fakeAlloy().dispatch } as never);
  __setForgeHealthForTest({ mitmRunning: true, routingEnabled: true });
  db.prepare(`INSERT INTO devices(udid, name, state, platform, kind, last_seen) VALUES ('sim-1', 'S', 'Booted', 'ios', 'simulator', ?)`).run(Date.now());
  db.prepare(`INSERT INTO templates(id, name, udid, steps_json, app_bundle_id, tags_json, created_by, created_at, updated_at)
              VALUES ('tpl_a', 'case a', '', ?, 'com.lp.x', '[]', 't', 1, 1)`).run(JSON.stringify([{ idx: 0, action: 'expect', selector: { labelContains: 'Home' } }]));
  const { default: Fastify } = await import('fastify');
  app = Fastify();
  registerManualRoutes(app, db, { bus: { emit: () => undefined }, artifactsDir: tmp, forgeState: { activeRunId: null }, dispatchDeps: null } as never);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  __setAlloyForTest(null);
  __setForgeHealthForTest(null);
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('T2 — batch stamping', () => {
  /** playback is fire-and-forget: rows are stamped at INSERT but the loop
   *  keeps running past the assertions. Drain to terminal before afterEach
   *  closes the DB — otherwise the terminal write races teardown. */
  async function drainRuns(budgetMs = 90_000): Promise<void> {
    const t0 = Date.now();
    for (;;) {
      const c = (db.prepare(`SELECT COUNT(*) c FROM runs WHERE status IN ('running','queued')`).get() as { c: number }).c;
      if (c === 0 || Date.now() - t0 > budgetMs) return;
      await new Promise((res) => setTimeout(res, 200));
    }
  }

  it('play-all stamps every member run with one shared batch_id', { timeout: 60_000 }, async () => {
    const r = await app.inject({ method: 'POST', url: '/api/templates/play-all', payload: {} });
    expect(r.statusCode).toBeLessThan(500);
    const body = r.json() as { batchId?: string };
    expect(body.batchId).toMatch(/^batch_/);
    await drainRuns();
    const rows = db.prepare(`SELECT batch_id FROM runs WHERE template_id = 'tpl_a'`).all() as Array<{ batch_id: string | null }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.batch_id).toBe(body.batchId);
  });

  it('solo play of a variantless case leaves batch_id NULL (not an execution set)', { timeout: 60_000 }, async () => {
    const r = await app.inject({ method: 'POST', url: '/api/templates/tpl_a/play', payload: {} });
    expect(r.statusCode).toBeLessThan(500);
    await drainRuns();
    const rows = db.prepare(`SELECT batch_id FROM runs WHERE template_id = 'tpl_a' ORDER BY started_at DESC LIMIT 1`).all() as Array<{ batch_id: string | null }>;
    expect(rows[0]!.batch_id).toBeNull();
  });

  it('multi-variant lane-chain play stamps its own batch_id on every lane', { timeout: 120_000 }, async () => {
    db.prepare(`UPDATE templates SET variants_json = ? WHERE id = 'tpl_a'`).run(
      JSON.stringify([{ id: 'sg', env: { COUNTRY: 'Batam' } }, { id: 'th', env: { COUNTRY: 'Bangkok' } }]),
    );
    const r = await app.inject({ method: 'POST', url: '/api/templates/tpl_a/play', payload: {} });
    expect(r.statusCode).toBeLessThan(500);
    const body = r.json() as { batchId?: string };
    expect(body.batchId).toMatch(/^batch_/);
    // lanes 2..N are detached (start after lane 1 settles — c1032d1 contract);
    // poll for both stamped rows instead of asserting at response time
    let rows: Array<{ batch_id: string }> = [];
    for (let i = 0; i < 450; i++) { // 90s budget: lanes are serial (lane N starts after N-1 settles)
      rows = db.prepare(`SELECT batch_id FROM runs WHERE template_id = 'tpl_a' AND batch_id IS NOT NULL`).all() as Array<{ batch_id: string }>;
      if (rows.length >= 2) break;
      await new Promise((res) => setTimeout(res, 200));
    }
    expect(rows.length).toBe(2); // both lanes stamped
    for (const row of rows) expect(row.batch_id).toBe(body.batchId);
    await drainRuns();
  });
});
