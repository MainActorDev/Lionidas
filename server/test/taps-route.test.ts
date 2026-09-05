import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { migrateM1 } from '../src/db/schema.ts';
import { registerTemplateRoutes } from '../src/routes/templates.ts';
import { recordTap } from '../src/evidence/taps-store.ts';

/** Task 3 — taps API for the evidence-player overlay. Serves the SAME run
 *  the video route serves (shared selector); shape {taps, videoStartedAt};
 *  404 {error} when template/run/video anchor missing. */
let db: Database.Database;
let app: FastifyInstance;
beforeEach(async () => {
  db = new Database(':memory:');
  migrateM1(db);
  app = Fastify();
  registerTemplateRoutes(app, db);
  await app.ready();
});
afterEach(async () => { await app.close(); db.close(); });

function seedTemplate(id: string): void {
  db.prepare(`INSERT INTO templates(id, name, udid, steps_json, created_by, created_at, updated_at)
              VALUES (?, 'case', 'sim', '[]', 'qa', 0, 0)`).run(id);
}
function seedRun(id: string, tpl: string, opts: { finished?: boolean; videoStartedAt?: number | null; templateId?: string | null; startedAt?: number } = {}): void {
  db.prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, freshness, template_id, started_at, finished_at, video_started_at)
              VALUES (?, 'X', 'manual', ?, 'qa', 'u', 'unchecked', ?, ?, ?, ?)`)
    .run(id, opts.finished === false ? 'running' : 'passed', opts.templateId === null ? null : (opts.templateId ?? tpl), opts.startedAt ?? 100, opts.finished === false ? null : 200, opts.videoStartedAt ?? null);
}

describe('GET /api/templates/:id/run-taps', () => {
  it('serves taps + videoStartedAt for the latest finished run', async () => {
    seedTemplate('tpl_1');
    seedRun('run_old', 'tpl_1', { videoStartedAt: 50, startedAt: 100 });
    seedRun('run_new', 'tpl_1', { videoStartedAt: 100, startedAt: 300 });
    recordTap(db, { runId: 'run_old', idx: 0, x: 1, y: 1, logicalW: 393, logicalH: 852 }, 60);
    recordTap(db, { runId: 'run_new', idx: 2, x: 196, y: 488, logicalW: 393, logicalH: 852 }, 150);
    const r = await app.inject({ method: 'GET', url: '/api/templates/tpl_1/run-taps' });
    expect(r.statusCode).toBe(200);
    const b = r.json() as { runId: string; videoStartedAt: number | null; taps: Array<{ seq: number; ts: number; x: number; y: number }> };
    expect(b.runId).toBe('run_new');                       // same-latest-run invariant
    expect(b.videoStartedAt).toBe(100);
    expect(b.taps).toHaveLength(1);                        // only the served run's taps
    expect(b.taps[0]).toMatchObject({ ts: 150, x: 196, y: 488 });
  });

  it('404 {error} when template has no finished run', async () => {
    seedTemplate('tpl_2');
    seedRun('run_live', 'tpl_2', { finished: false });
    const r = await app.inject({ method: 'GET', url: '/api/templates/tpl_2/run-taps' });
    expect(r.statusCode).toBe(404);
    expect((r.json() as { error: string }).error).toMatch(/no finished run/i);
  });

  it('404 {error} when the latest finished run has no video anchor (video was unavailable)', async () => {
    seedTemplate('tpl_3');
    seedRun('run_noanchor', 'tpl_3', { videoStartedAt: null });
    const r = await app.inject({ method: 'GET', url: '/api/templates/tpl_3/run-taps' });
    expect(r.statusCode).toBe(404);
    expect((r.json() as { error: string }).error).toMatch(/no video/i);
  });
});
