import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateM1 } from '../src/db/schema.ts';
import { registerOverviewRoutes } from '../src/routes/overview.ts';
import type { FastifyInstance } from 'fastify';

/** Overview slice T3 — GET /api/overview aggregate. Metric definitions are
 *  pinned in docs/plans/2026-09-22-overview-vertical-slice.md:
 *  running-first health order, worst-of-lanes collapse per template,
 *  passRate = passed/(passed+failed) with blocked separate, comparability
 *  guard (suite + app_version), new-vs-recurring attention, coverage. */
let db: Database.Database;
let app: FastifyInstance;
let tmp: string;
let now: number;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'ov-api-'));
  db = new Database(join(tmp, 't.db'));
  db.pragma('journal_mode = WAL');
  migrateM1(db);
  now = Date.now();
  const { default: Fastify } = await import('fastify');
  app = Fastify();
  registerOverviewRoutes(app, db, { now: () => now });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const mkTpl = (id: string, status = 'active', variants = 0): void => {
  db.prepare(`INSERT INTO templates(id, name, udid, steps_json, app_bundle_id, tags_json, created_by, created_at, updated_at, status, variants_json)
              VALUES (?, ?, '', '[]', 'com.lp.x', '[]', 't', 1, 1, ?, ?)`)
    .run(id, id, status, variants > 0 ? JSON.stringify(Array.from({ length: variants }, (_, i) => ({ id: `v${i}` }))) : null);
};

const mkRun = (o: { tpl: string; batch: string; status: string; blocked?: number; variant?: string; at?: number; version?: string }): void => {
  db.prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at, finished_at, template_id, app_version, variant_id, batch_id, blocked, case_version_id)
              VALUES (?, 'T', 'manual', ?, 'qa', 'sim', ?, ?, ?, '1.0.0', ?, ?, ?, ?)`)
    .run(`run_${o.tpl}_${o.batch}${o.variant ? `_${o.variant}` : ''}_${Math.random().toString(36).slice(2, 6)}`, o.status, o.at ?? now, o.status === 'running' ? null : (o.at ?? now) + 1000, o.tpl, o.variant ?? null, o.batch, o.blocked ?? 0, o.version ?? null);
};

const get = async (qs = ''): Promise<any> =>
  (await app.inject({ method: 'GET', url: `/api/overview${qs}` })).json() as never;

describe('T3 — /api/overview health', () => {
  it('empty DB → no_data, passRate null (never 0)', async () => {
    const b = await get();
    expect(b.health.status).toBe('no_data');
    expect(b.health.passRate).toBeNull();
  });

  it('latest batch all-passed → healthy with counts + lastSuccessfulAt', async () => {
    mkTpl('t1'); mkTpl('t2');
    mkRun({ tpl: 't1', batch: 'b1', status: 'passed', at: now - 10_000 });
    mkRun({ tpl: 't2', batch: 'b1', status: 'passed', at: now - 9_000 });
    const b = await get();
    expect(b.health.status).toBe('healthy');
    expect(b.health.passed).toBe(2);
    expect(b.health.passRate).toBe(1);
    expect(b.health.failed).toBe(0);
    expect(b.health.blocked).toBe(0);
  });

  it('any failed → failed; passRate = passed/(passed+failed)', async () => {
    mkTpl('t1'); mkTpl('t2'); mkTpl('t3');
    mkRun({ tpl: 't1', batch: 'b1', status: 'passed' });
    mkRun({ tpl: 't2', batch: 'b1', status: 'failed' });
    mkRun({ tpl: 't3', batch: 'b1', status: 'passed' });
    const b = await get();
    expect(b.health.status).toBe('failed');
    expect(b.health.passRate).toBeCloseTo(2 / 3);
  });

  it('blocked never counts as failed and yields degraded', async () => {
    mkTpl('t1'); mkTpl('t2');
    mkRun({ tpl: 't1', batch: 'b1', status: 'passed' });
    mkRun({ tpl: 't2', batch: 'b1', status: 'aborted', blocked: 1 });
    const b = await get();
    expect(b.health.status).toBe('degraded');
    expect(b.health.failed).toBe(0);
    expect(b.health.blocked).toBe(1);
    expect(b.health.passRate).toBe(1); // blocked excluded from denominator
  });

  it('running wins over an older failed batch (running-first order)', async () => {
    mkTpl('t1'); mkTpl('t2');
    mkRun({ tpl: 't1', batch: 'b_old', status: 'failed', at: now - 50_000 });
    mkRun({ tpl: 't2', batch: 'b_old', status: 'passed', at: now - 49_000 });
    mkRun({ tpl: 't1', batch: 'b_new', status: 'running', at: now - 1_000 });
    const b = await get();
    expect(b.health.status).toBe('running');
  });

  it('worst-of-lanes: one template with pass+fail lanes counts ONE failed observation', async () => {
    mkTpl('t1', 'active', 2);
    mkRun({ tpl: 't1', batch: 'b1', status: 'passed', variant: 'v0' });
    mkRun({ tpl: 't1', batch: 'b1', status: 'failed', variant: 'v1' });
    mkTpl('t2');
    mkRun({ tpl: 't2', batch: 'b1', status: 'passed' });
    const b = await get();
    expect(b.health.failed).toBe(1); // not 2 — lanes collapse
    expect(b.health.passed).toBe(1);
    expect(b.health.passRate).toBeCloseTo(1 / 2);
  });
});

describe('T3 — comparability', () => {
  it('delta compares against previous batch with SAME app_version; different build never compared', async () => {
    mkTpl('t1');
    // old batch on 1.0.0: passed
    db.prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at, finished_at, template_id, app_version, batch_id, blocked)
                VALUES ('run_old', 'T', 'manual', 'passed', 'qa', 'sim', ?, ?, 't1', '1.0.0', 'b_old', 0)`).run(now - 100_000, now - 99_000);
    // an intervening batch on a DIFFERENT build — must be skipped for comparison
    db.prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at, finished_at, template_id, app_version, batch_id, blocked)
                VALUES ('run_mid', 'T', 'manual', 'failed', 'qa', 'sim', ?, ?, 't1', '2.0.0', 'b_mid', 0)`).run(now - 50_000, now - 49_000);
    // latest batch on 1.0.0 again: failed
    db.prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at, finished_at, template_id, app_version, batch_id, blocked)
                VALUES ('run_new', 'T', 'manual', 'failed', 'qa', 'sim', ?, ?, 't1', '1.0.0', 'b_new', 0)`).run(now - 10_000, now - 9_000);
    const b = await get();
    // previous comparable = b_old (same build), NOT b_mid (different build)
    expect(b.health.delta).toBe(-1);
    expect(b.health.previousBatch).toBe('b_old');
  });

  it('mixed-version batch labels comparison, never fabricates a build', async () => {
    mkTpl('t1'); mkTpl('t2');
    mkRun({ tpl: 't1', batch: 'b1', status: 'failed' });
    db.prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at, finished_at, template_id, app_version, batch_id, blocked)
                VALUES ('run_null', 'T', 'manual', 'passed', 'qa', 'sim', ?, ?, 't2', NULL, 'b1', 0)`).run(now - 500, now + 500);
    const b = await get();
    expect(b.health.buildLabel).toBe('mixed builds');
  });
});

describe('T3 — attention', () => {
  it('new failure ranks first with drill-down ids; ordering new > blocked > stale', async () => {
    mkTpl('t_new'); mkTpl('t_block'); mkTpl('t_stale');
    // previous comparable: everything green
    mkRun({ tpl: 't_new', batch: 'b_prev', status: 'passed', at: now - 100_000 });
    mkRun({ tpl: 't_block', batch: 'b_prev', status: 'passed', at: now - 100_000 });
    // latest: t_new newly failed, t_block infra-blocked, t_stale never run (7d+ old template)
    db.prepare(`UPDATE templates SET updated_at = ? WHERE id = 't_stale'`).run(now - 8 * 86400_000);
    mkRun({ tpl: 't_new', batch: 'b_now', status: 'failed', at: now - 5_000 });
    mkRun({ tpl: 't_block', batch: 'b_now', status: 'aborted', blocked: 1, at: now - 4_000 });
    const b = await get();
    const kinds = (b.attention as Array<{ kind: string }>).map((a) => a.kind);
    expect(kinds.indexOf('new_failure')).toBeLessThan(kinds.indexOf('infra_blocked'));
    expect(kinds).toContain('stale_case');
    const nf = (b.attention as Array<{ kind: string; templateId: string; runId?: string }>).find((a) => a.kind === 'new_failure') as { kind: string; templateId: string; runId?: string };
    expect(nf.templateId).toBe('t_new');
    expect(nf.runId).toBeTruthy(); // drill-down identity
  });

  it('failure with NO comparable baseline is no_baseline, never recurring (live drill catch)', async () => {
    mkTpl('t1'); mkTpl('t2');
    // mixed-version single batch (Maps 1.0 + LP 1.2.0 style): no honest previous build
    mkRun({ tpl: 't1', batch: 'b1', status: 'failed', version: '1.0' });
    db.prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at, finished_at, template_id, app_version, batch_id, blocked)
                VALUES ('run_null', 'T', 'manual', 'passed', 'qa', 'sim', ?, ?, 't2', NULL, 'b1', 0)`).run(now - 500, now + 500);
    const b = await get();
    const items = (b.attention as Array<{ kind: string; templateId?: string; tag?: string }>).filter((a) => a.kind === 'repeated_failure');
    expect(items.length).toBe(1);
    expect(items[0]!.tag).toBe('no_baseline');
    expect(b.health.previousBatch).toBeNull();
    expect(b.health.buildLabel).toBe('mixed builds');
  });

  it('repeated failure (2+ consecutive comparable sets) is flagged recurring', async () => {
    mkTpl('t1');
    mkRun({ tpl: 't1', batch: 'b1', status: 'failed', at: now - 100_000 });
    mkRun({ tpl: 't1', batch: 'b2', status: 'failed', at: now - 50_000 });
    mkRun({ tpl: 't1', batch: 'b3', status: 'failed', at: now - 5_000 });
    const b = await get();
    const item = (b.attention as Array<{ kind: string; templateId?: string; tag?: string }>).find((a) => a.templateId === 't1' || a.kind === 'repeated_failure');
    expect(item?.tag).toBe('recurring');
  });
});

describe('T3 — coverage', () => {
  it('counts by status, variants, executed-in-range, not-run-recently', async () => {
    mkTpl('a1'); mkTpl('d1', 'draft'); mkTpl('x1', 'deprecated'); mkTpl('v1', 'active', 3); mkTpl('never');
    db.prepare(`UPDATE templates SET updated_at = ? WHERE id = 'never'`).run(now - 10 * 86400_000);
    mkRun({ tpl: 'a1', batch: 'b1', status: 'passed' });
    const b = await get();
    expect(b.coverage.active).toBe(3); // a1, v1, never
    expect(b.coverage.draft).toBe(1);
    expect(b.coverage.deprecated).toBe(1);
    expect(b.coverage.variants).toBe(3);
    expect(b.coverage.executedInRange).toBe(1);
    expect(b.coverage.notRunRecently).toBe(2); // 'never' (10d old) + 'v1' (active, never executed)
  });
});

describe('T3 — latestRuns', () => {
  it('top runs in scope with drill-down identity; solo NULL-batch runs still listed', async () => {
    mkTpl('t1'); mkTpl('t2');
    mkRun({ tpl: 't1', batch: 'b1', status: 'failed', at: now - 1_000 });
    db.prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at, finished_at, template_id, app_version, batch_id, blocked)
                VALUES ('run_solo', 'T', 'manual', 'passed', 'qa', 'sim', ?, ?, 't2', '1.0.0', NULL, 0)`).run(now - 500, now + 500);
    const b = await get();
    const runs = b.latestRuns as Array<{ runId: string; templateId: string; templateName: string | null }> | undefined;
    expect(runs!.length).toBe(2);
    expect(runs![0]!.runId).toBe('run_solo'); // newest first
    expect(runs!.some((r) => r.runId === 'run_solo')).toBe(true); // solo visible
    // names ride along (UI gap caught live: rows rendered bare tpl_ ids)
    expect(runs!.every((r) => typeof r.templateName === 'string' && r.templateName.length > 0)).toBe(true);
    const att0 = (b.attention as Array<{ templateName: string | null }>) ?? [];
    expect(att0.every((a) => typeof a.templateName === 'string')).toBe(true);
  });
});
