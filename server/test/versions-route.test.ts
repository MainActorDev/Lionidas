/** Phase A T4 — version read routes: list shape/order, single fetch with
 *  runs, survival after template deletion, 404s, auth gate. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/index.ts';
import { migrateM1 } from '../src/db/schema.ts';
import { snapshotCaseVersion } from '../src/manual/case-versions.ts';

let db: Database.Database;
let tmp: string;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'cv-routes-'));
  const dbPath = join(tmp, 't.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  migrateM1(db);
  migrateM1(db);
  app = await buildApp({ CRUCIBLE_REQUIRE_AUTH: '0', CRUCIBLE_DB_PATH: dbPath, CRUCIBLE_ARTIFACTS_DIR: tmp, VITEST: 'true' });
  await app.app.ready();
});
afterEach(async () => {
  await app.close();
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const seedTemplate = (id: string, steps: unknown[]): void => {
  db.prepare(`INSERT INTO templates(id, name, ticket_key, udid, steps_json, created_by, created_at, updated_at)
              VALUES (?, ?, NULL, 'sim-1', ?, 'qa', 0, 0)`).run(id, id, JSON.stringify(steps));
};
const seedRun = (runId: string, templateId: string, versionId: string, status: string): void => {
  db.prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at, template_id, case_version_id)
              VALUES (?, 'MANUAL', 'automated', ?, 'qa', 'sim-1', ?, ?, ?)`).run(runId, status, Date.now(), templateId, versionId);
};

describe('GET /api/templates/:id/versions', () => {
  it('lists revisions desc with yaml inline, run counts, source', async () => {
    seedTemplate('tpl_r', [{ idx: 0, action: 'tap', x: 1, y: 2 }]);
    const v1 = snapshotCaseVersion(db, { templateId: 'tpl_r' });
    db.prepare('UPDATE templates SET steps_json = ? WHERE id = ?').run(JSON.stringify([{ idx: 0, action: 'tap', x: 3, y: 4 }]), 'tpl_r');
    const v2 = snapshotCaseVersion(db, { templateId: 'tpl_r' }); // creates revision 2 (new steps)
    void v2;
    seedRun('run_a', 'tpl_r', v1.id, 'passed');
    seedRun('run_b', 'tpl_r', v1.id, 'failed');
    const r = await app.app.inject({ method: 'GET', url: '/api/templates/tpl_r/versions' });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { versions: Array<{ revision: number; yaml: string; runCount: number; source: string; stepsSha: string; scenarioId: string | null; scenarioSnapshot: unknown }> };
    expect(body.versions).toHaveLength(2);
    expect(body.versions[0]!.revision).toBe(2);
    expect(body.versions[0]!.runCount).toBe(0);
    expect(body.versions[1]!.runCount).toBe(2);
    expect(body.versions[1]!.yaml).toContain('name: tpl_r');
    expect(body.versions[1]!.source).toBe('run');
    expect(body.versions.every((v) => v.scenarioId === null && v.scenarioSnapshot === null)).toBe(true);
  });

  it('unknown template → empty list (not 404 — versions are a sub-resource, absence is honest)', async () => {
    const r = await app.app.inject({ method: 'GET', url: '/api/templates/ghost/versions' });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { versions: unknown[] }).versions).toHaveLength(0);
  });
});

describe('GET /api/versions/:id', () => {
  it('returns the version + its runs, desc by started_at', async () => {
    seedTemplate('tpl_s', [{ idx: 0, action: 'tap', x: 1, y: 2 }]);
    const v = snapshotCaseVersion(db, { templateId: 'tpl_s' });
    seedRun('run_x', 'tpl_s', v.id, 'passed');
    const r = await app.app.inject({ method: 'GET', url: `/api/versions/${v.id}` });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { version: { revision: number; templateId: string }; runs: Array<{ id: string }> };
    expect(body.version.revision).toBeGreaterThanOrEqual(1);
    expect(body.version.templateId).toBe('tpl_s');
    expect(body.runs.map((x) => x.id)).toEqual(['run_x']);
  });

  it('SURVIVES template deletion — the audit link outlives the case', async () => {
    seedTemplate('tpl_dead', [{ idx: 0, action: 'tap', x: 1, y: 2 }]);
    const v = snapshotCaseVersion(db, { templateId: 'tpl_dead' });
    db.prepare('DELETE FROM templates WHERE id = ?').run('tpl_dead');
    const r = await app.app.inject({ method: 'GET', url: `/api/versions/${v.id}` });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { version: { yaml: string } }).version.yaml).toContain('name: tpl_dead');
  });

  it('unknown version → 404', async () => {
    const r = await app.app.inject({ method: 'GET', url: '/api/versions/cv_nope' });
    expect(r.statusCode).toBe(404);
  });
});

describe('run detail carries provenance (SELECT * receipt)', () => {
  it('runs/:id response includes case_version_id + scenario columns', async () => {
    seedTemplate('tpl_t', [{ idx: 0, action: 'tap', x: 1, y: 2 }]);
    const v = snapshotCaseVersion(db, { templateId: 'tpl_t' });
    seedRun('run_prov', 'tpl_t', v.id, 'passed');
    const r = await app.app.inject({ method: 'GET', url: '/api/runs/run_prov' });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { run: { case_version_id: string | null; scenario_id: string | null; scenario_sha: string | null } };
    expect(body.run.case_version_id).toBe(v.id);
    expect(body.run.scenario_id).toBeNull();
  });
});
