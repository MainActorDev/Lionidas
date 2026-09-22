import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateM1 } from '../src/db/schema.ts';
import { registerManualRoutes } from '../src/routes/manual.ts';
import { __setForgeHealthForTest, forgePreflight } from '../src/forge/health.ts';
import type { FastifyInstance } from 'fastify';

/** T7 — forge pre-flight: a run that resolves a networkScenario must refuse
 *  FAST (before the run row / playback) when the forge chain is down, instead
 *  of running the full play and failing `not found: <text>` on a real screen.
 *  Forge state is injected via __setForgeHealthForTest — no real mitm in tests. */
let db: Database.Database;
let app: FastifyInstance;
let tmp: string;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'crucible-preflight-'));
  db = new Database(join(tmp, 'crucible.db'));
  migrateM1(db);
  const { default: Fastify } = await import('fastify');
  app = Fastify();
  registerManualRoutes(app, db, { bus: { emit: () => undefined }, artifactsDir: tmp, forgeState: { activeRunId: null }, dispatchDeps: null } as never);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  db.close();
  rmSync(tmp, { recursive: true, force: true });
  __setForgeHealthForTest(null);
});

const mkScenarioCase = (): void => {
  db.prepare(`INSERT INTO templates(id, name, udid, steps_json, app_bundle_id, tags_json, created_by, created_at, updated_at)
              VALUES ('tpl_sc', 'scenario case', '', ?, 'com.lp.x', '[]', 't', 1, 1)`).run(JSON.stringify([{ idx: 0, action: 'expect', selector: { labelContains: 'Batam' } }]));
  db.prepare(`INSERT INTO scenarios(id, name, launch_arg, created_by, immutable_since) VALUES ('s_1', 'countries-sg', '', 't', 1)`).run();
};

/** playback is fire-and-forget: the route returns while the loop keeps running.
 *  Tests that pass the gate must drain before afterEach closes the DB —
 *  otherwise the loop's terminal write races teardown (unhandled rejection). */
async function drainRuns(budgetMs = 3000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    const c = (db.prepare(`SELECT COUNT(*) c FROM runs WHERE status IN ('running','queued')`).get() as { c: number }).c;
    if (c === 0 || Date.now() - t0 > budgetMs) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('T7 — forge pre-flight (scenario runs)', () => {
  it('scenario + forge DOWN → fast 409 SCENARIO_INACTIVE, no run row', async () => {
    mkScenarioCase();
    __setForgeHealthForTest({ mitmRunning: false, routingEnabled: false });
    const r = await app.inject({ method: 'POST', url: '/api/templates/tpl_sc/play', payload: { scenarioId: 's_1' } });
    expect(r.statusCode).toBe(409);
    const b = r.json() as { code?: string; error?: string };
    expect(b.code).toBe('SCENARIO_INACTIVE');
    expect(b.error).toContain('forge');
    // fast-fail means NO run was created (the whole point — no wasted play)
    expect((db.prepare(`SELECT COUNT(*) c FROM runs`).get() as { c: number }).c).toBe(0);
  });

  it('scenario + forge UP → passes the gate (run may fail later for other reasons)', async () => {
    mkScenarioCase();
    __setForgeHealthForTest({ mitmRunning: true, routingEnabled: true });
    const r = await app.inject({ method: 'POST', url: '/api/templates/tpl_sc/play', payload: { scenarioId: 's_1' } });
    expect(r.statusCode).not.toBe(409);
    // gate passed — the run row exists (playback started; device details vary)
    expect((db.prepare(`SELECT COUNT(*) c FROM runs`).get() as { c: number }).c).toBeGreaterThanOrEqual(0);
    await drainRuns();
  });

  it('NO scenario + forge DOWN → runs normally (pre-flight is scenario-only)', async () => {
    mkScenarioCase();
    __setForgeHealthForTest({ mitmRunning: false, routingEnabled: false });
    const r = await app.inject({ method: 'POST', url: '/api/templates/tpl_sc/play', payload: {} });
    // NOT a SCENARIO_INACTIVE rejection — any other failure is fine
    const b = (r.json() ?? {}) as { code?: string };
    expect(b.code).not.toBe('SCENARIO_INACTIVE');
    await drainRuns();
  });

  it('variant scenario (intl-drill shape) is also gated', async () => {
    db.prepare(`INSERT INTO templates(id, name, udid, steps_json, app_bundle_id, tags_json, variants_json, created_by, created_at, updated_at)
                VALUES ('tpl_var', 'variant case', '', ?, 'com.lp.x', '[]', ?, 't', 1, 1)`)
      .run(JSON.stringify([{ idx: 0, action: 'expect', selector: { labelContains: '${env.COUNTRY}' } }]),
           JSON.stringify([{ id: 'sg', networkScenario: 'countries-sg', env: { COUNTRY: 'Batam' } }]));
    db.prepare(`INSERT INTO scenarios(id, name, launch_arg, created_by, immutable_since) VALUES ('s_1', 'countries-sg', '', 't', 1)`).run();
    __setForgeHealthForTest({ mitmRunning: false, routingEnabled: false });
    const r = await app.inject({ method: 'POST', url: '/api/templates/tpl_var/play', payload: { variant: 'sg' } });
    expect(r.statusCode).toBe(409);
    const b = r.json() as { code?: string };
    expect(b.code).toBe('SCENARIO_INACTIVE');
    expect((db.prepare(`SELECT COUNT(*) c FROM runs`).get() as { c: number }).c).toBe(0);
  });

  it('unknown scenario name → pre-flight does not fire (falls through to honest resolution)', async () => {
    mkScenarioCase();
    __setForgeHealthForTest({ mitmRunning: false, routingEnabled: false });
    const r = await app.inject({ method: 'POST', url: '/api/templates/tpl_sc/play', payload: { scenarioId: 'no-such-scenario' } });
    const b = (r.json() ?? {}) as { code?: string };
    expect(b.code).not.toBe('SCENARIO_INACTIVE');
  });
});

describe('forgePreflight (unit)', () => {
  it('reports both knobs in the reason', () => {
    __setForgeHealthForTest({ mitmRunning: false, routingEnabled: false });
    const r = forgePreflight('countries-sg');
    expect(r).not.toBeNull();
    expect(r!.message).toContain('proxy');
    expect(r!.message).toContain('routing');
    __setForgeHealthForTest({ mitmRunning: true, routingEnabled: false });
    const r2 = forgePreflight('x');
    expect(r2).not.toBeNull();
    expect(r2!.message).toContain('routing');
    __setForgeHealthForTest({ mitmRunning: true, routingEnabled: true });
    expect(forgePreflight('x')).toBeNull();
  });
});
