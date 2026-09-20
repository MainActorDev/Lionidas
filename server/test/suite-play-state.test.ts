import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateM1 } from '../src/db/schema.ts';
import { lastSuitePlay, memberFreshness, suiteRunning } from '../src/db/suite-play-state.ts';

let db: Database.Database;
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ps-'));
  db = new Database(':memory:');
  migrateM1(db);
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

function seedTpl(id: string, stepsJson = '[]'): void {
  db.prepare(`INSERT INTO templates(id, name, udid, steps_json, created_by, created_at, updated_at)
              VALUES (?, ?, 'sim', ?, 'qa', 0, 0)`).run(id, id, stepsJson);
}
function seedSuite(id: string, members: Array<{ t: string; v?: string[] }>): void {
  db.prepare(`INSERT INTO suites(id, name, description, app_bundle_id, created_by, created_at, updated_at)
              VALUES (?, ?, NULL, NULL, 'qa', 0, 0)`).run(id, id);
  const ins = db.prepare('INSERT INTO suite_members(suite_id, template_id, variant_ids_json, position) VALUES (?, ?, ?, ?)');
  members.forEach((m, i) => ins.run(id, m.t, m.v ? JSON.stringify(m.v) : null, i));
}
function seedSuiteRun(id: string, tpl: string, status: string, suite: string, at: number, variantId: string | null = null): void {
  db.prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at, finished_at, template_id, suite_id, variant_id)
              VALUES (?, 'T', 'manual', ?, 'suite:x', 'sim', ?, ?, ?, ?, ?)`)
    .run(id, status, at, at + 1000, tpl, suite, variantId);
}
function seedVersion(id: string, tpl: string, sha: string): void {
  const rev = (db.prepare('SELECT COUNT(*) c FROM case_versions WHERE template_id = ?').get(tpl) as { c: number }).c;
  db.prepare(`INSERT INTO case_versions(id, template_id, revision, steps_sha256, yaml_canonical, source, created_by, created_at)
              VALUES (?, ?, ?, ?, '', 'run', 'qa', ?)`).run(id, tpl, rev, sha, 0);
}
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

describe('suite-play-state — fingerprint', () => {
  it('no runs → null lastPlay, not changed', () => {
    seedTpl('t1'); seedSuite('s1', [{ t: 't1' }]);
    const lp = lastSuitePlay(db, 's1', [{ templateId: 't1', variantIds: null }]);
    expect(lp.at).toBeNull();
    expect(lp.membersChanged).toBe(false);
    expect(lp.runIds).toEqual([]);
  });

  it('membership matches → membersChanged false', () => {
    seedTpl('t1'); seedSuite('s1', [{ t: 't1' }]);
    seedSuiteRun('r1', 't1', 'passed', 's1', 1000);
    const lp = lastSuitePlay(db, 's1', [{ templateId: 't1', variantIds: null }]);
    expect(lp.at).toBe(1000);
    expect(lp.membersChanged).toBe(false);
  });

  it('member added after the play → membersChanged true', () => {
    seedTpl('t1'); seedTpl('t2');
    seedSuite('s1', [{ t: 't1' }]);
    seedSuiteRun('r1', 't1', 'passed', 's1', 1000);
    // now the pack ALSO has t2 (never played)
    const lp = lastSuitePlay(db, 's1', [{ templateId: 't1', variantIds: null }, { templateId: 't2', variantIds: null }]);
    expect(lp.membersChanged).toBe(true);
  });

  it('member removed after the play → membersChanged true', () => {
    seedTpl('t1'); seedTpl('t2');
    seedSuite('s1', [{ t: 't1' }, { t: 't2' }]);
    seedSuiteRun('r1', 't1', 'passed', 's1', 1000);
    seedSuiteRun('r2', 't2', 'passed', 's1', 1000);
    const lp = lastSuitePlay(db, 's1', [{ templateId: 't1', variantIds: null }]);
    expect(lp.membersChanged).toBe(true);
  });

  it('reorder is NOT a change (order-insensitive fingerprint)', () => {
    seedTpl('t1'); seedTpl('t2');
    seedSuite('s1', [{ t: 't1' }, { t: 't2' }]);
    seedSuiteRun('r1', 't1', 'passed', 's1', 1000);
    seedSuiteRun('r2', 't2', 'passed', 's1', 1000);
    const lp = lastSuitePlay(db, 's1', [{ templateId: 't2', variantIds: null }, { templateId: 't1', variantIds: null }]);
    expect(lp.membersChanged).toBe(false);
  });

  it('variant re-pin after the play → membersChanged true', () => {
    seedTpl('t1');
    seedSuite('s1', [{ t: 't1' }]);
    seedSuiteRun('r1', 't1', 'passed', 's1', 1000, 'sg');
    // pack now pins ['sg','my'] but the play ran only 'sg'
    const lp = lastSuitePlay(db, 's1', [{ templateId: 't1', variantIds: ['sg', 'my'] }]);
    expect(lp.membersChanged).toBe(true);
  });

  it('variant-lane runs reconstruct the pin exactly → membersChanged false', () => {
    seedTpl('t1');
    seedSuite('s1', [{ t: 't1', v: ['sg', 'my'] }]);
    seedSuiteRun('r1', 't1', 'passed', 's1', 1000, 'sg');
    seedSuiteRun('r2', 't1', 'passed', 's1', 1000, 'my');
    const lp = lastSuitePlay(db, 's1', [{ templateId: 't1', variantIds: ['my', 'sg'] }]);
    expect(lp.membersChanged).toBe(false);
  });

  it('older play outside the window is excluded from the batch', () => {
    seedTpl('t1'); seedTpl('t2');
    seedSuite('s1', [{ t: 't1' }, { t: 't2' }]);
    seedSuiteRun('r0', 't2', 'passed', 's1', 1000); // old play: only t2
    seedSuiteRun('r1', 't1', 'passed', 's1', 500_000); // new play: only t1
    const lp = lastSuitePlay(db, 's1', [{ templateId: 't1', variantIds: null }]);
    expect(lp.at).toBe(500_000);
    expect(lp.runIds).toEqual(['r1']);
    expect(lp.membersChanged).toBe(false);
  });
});

describe('suite-play-state — member freshness', () => {
  it('no suite-scoped run → not stale, no ghost pins', () => {
    seedTpl('t1'); seedSuite('s1', [{ t: 't1' }]);
    const f = memberFreshness(db, 's1', 't1', null, []);
    expect(f).toEqual({ stale: false, staleVariants: [] });
  });

  it('content edited since the pinned version → stale', () => {
    seedTpl('t1', '[{"tap":"a"}]');
    seedSuite('s1', [{ t: 't1' }]);
    const v1 = sha('[{"tap":"a"}]');
    seedVersion('cv1', 't1', v1);
    db.prepare('UPDATE runs SET case_version_id = ? WHERE id = ?').run('cv1', 'r-nope');
    seedSuiteRun('r1', 't1', 'passed', 's1', 1000);
    db.prepare('UPDATE runs SET case_version_id = ? WHERE id = ?').run('cv1', 'r1');
    // case content now differs
    db.prepare('UPDATE templates SET steps_json = ? WHERE id = ?').run('[{"tap":"b"}]', 't1');
    const f = memberFreshness(db, 's1', 't1', null, []);
    expect(f.stale).toBe(true);
  });

  it('rename-only edit (same steps) → NOT stale', () => {
    seedTpl('t1', '[{"tap":"a"}]');
    seedSuite('s1', [{ t: 't1' }]);
    seedVersion('cv1', 't1', sha('[{"tap":"a"}]'));
    seedSuiteRun('r1', 't1', 'passed', 's1', 1000);
    db.prepare('UPDATE runs SET case_version_id = ? WHERE id = ?').run('cv1', 'r1');
    db.prepare('UPDATE templates SET name = ? WHERE id = ?').run('renamed', 't1');
    const f = memberFreshness(db, 's1', 't1', null, []);
    expect(f.stale).toBe(false);
  });

  it('ghost variant pins surface as staleVariants', () => {
    seedTpl('t1');
    seedSuite('s1', [{ t: 't1', v: ['sg', 'my'] }]);
    // current vocab only has 'sg'
    const f = memberFreshness(db, 's1', 't1', ['sg', 'my'], ['sg']);
    expect(f.staleVariants).toEqual(['my']);
  });

  it('run without a pinned version → not stale (nothing to compare)', () => {
    seedTpl('t1', '[{"tap":"a"}]');
    seedSuite('s1', [{ t: 't1' }]);
    seedSuiteRun('r1', 't1', 'passed', 's1', 1000);
    const f = memberFreshness(db, 's1', 't1', null, []);
    expect(f.stale).toBe(false);
  });
});

describe('suite-play-state — running', () => {
  it('queued or running run stamped with the suite → true', () => {
    seedTpl('t1'); seedSuite('s1', [{ t: 't1' }]);
    seedSuiteRun('r1', 't1', 'running', 's1', 1000);
    expect(suiteRunning(db, 's1')).toBe(true);
  });
  it('finished runs only → false', () => {
    seedTpl('t1'); seedSuite('s1', [{ t: 't1' }]);
    seedSuiteRun('r1', 't1', 'passed', 's1', 1000);
    expect(suiteRunning(db, 's1')).toBe(false);
  });
  it('other suite running → false (suite-scoped)', () => {
    seedTpl('t1');
    seedSuite('s1', [{ t: 't1' }]);
    seedSuite('s2', [{ t: 't1' }]);
    seedSuiteRun('r1', 't1', 'running', 's2', 1000);
    expect(suiteRunning(db, 's1')).toBe(false);
  });
});
