import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateM1 } from '../src/db/schema.ts';
import { suiteVerdicts, runTrend } from '../src/db/suite.ts';

let db: Database.Database;
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'b4-'));
  db = new Database(':memory:');
  migrateM1(db);
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

function seedTpl(id: string, name: string): void {
  db.prepare(`INSERT INTO templates(id, name, udid, steps_json, created_by, created_at, updated_at)
              VALUES (?, ?, 'sim', '[]', 'qa', 0, 0)`).run(id, name);
}
function seedRun(id: string, tpl: string | null, status: string, blocked: number, at: number, appVersion: string | null = null): void {
  db.prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at, finished_at, template_id, app_version, blocked)
              VALUES (?, 'T', 'manual', ?, 'qa', 'sim', ?, ?, ?, ?, ?)`)
    .run(id, status, at, at + 1000, tpl, appVersion, blocked);
}

describe('suiteVerdicts (last verdict + trend per case)', () => {
  it('empty state: never run — absent from verdict map (caller renders "never run"), not zero-filled', () => {
    seedTpl('t1', 'login');
    const v = suiteVerdicts(db);
    expect(v.has('t1')).toBe(false);
    expect(v.size).toBe(0);
  });

  it('single pass: verdict green, trend p', () => {
    seedTpl('t1', 'login');
    seedRun('r1', 't1', 'passed', 0, 1000);
    const v = suiteVerdicts(db).get('t1')!;
    expect(v.lastStatus).toBe('passed');
    expect(v.lastRunId).toBe('r1');
    expect(v.trend).toBe('p');
    expect(v.totalRuns).toBe(1);
  });

  it('trend ordered oldest→newest, last 10, distinct glyphs', () => {
    seedTpl('t1', 'login');
    // statuses: passed/failed/aborted; skipped shows as steps not run status — use aborted
    let t = 1000;
    for (const [st] of [['passed'], ['failed'], ['passed'], ['passed'], ['aborted']] as Array<[string]>) {
      seedRun(`r${t}`, 't1', st, 0, t); t += 10;
    }
    const v = suiteVerdicts(db).get('t1')!;
    expect(v.trend).toBe('pfppa');
    expect(v.lastStatus).toBe('aborted');
  });

  it('blocked renders uppercase glyph + lastBlocked set', () => {
    seedTpl('t1', 'login');
    seedRun('r1', 't1', 'failed', 1, 1000);
    const v = suiteVerdicts(db).get('t1')!;
    expect(v.trend![0]).toBe('F');
    expect(v.lastBlocked).toBe(1);
  });

  it('trend window capped at 5 (oldest dropped), totalRuns keeps counting', () => {
    seedTpl('t1', 'login');
    for (let i = 0; i < 13; i++) seedRun(`r${i}`, 't1', 'passed', 0, 1000 + i * 10);
    const v = suiteVerdicts(db).get('t1')!;
    expect(v.trend!.length).toBe(5);
    expect(v.totalRuns).toBe(13);
  });

  it('runs without template_id are not attributed to any case', () => {
    seedTpl('t1', 'login');
    seedRun('r0', null, 'failed', 0, 500);
    seedRun('r1', 't1', 'passed', 0, 1000);
    const v = suiteVerdicts(db).get('t1')!;
    expect(v.totalRuns).toBe(1);
    expect(v.trend).toBe('p');
  });

  it('app_version surfaces on last verdict', () => {
    seedTpl('t1', 'login');
    seedRun('r1', 't1', 'passed', 0, 1000, '1.2.3');
    expect(suiteVerdicts(db).get('t1')!.lastAppVersion).toBe('1.2.3');
  });
});

describe('runTrend + history filter', () => {
  it('history returns runs newest-first for one case', () => {
    seedTpl('t1', 'login');
    seedRun('r1', 't1', 'passed', 0, 1000);
    seedRun('r2', 't1', 'failed', 0, 2000);
    seedRun('r3', null, 'passed', 0, 3000); // not this case
    const rows = runTrend(db, 't1');
    expect(rows.map((r) => r.id)).toEqual(['r2', 'r1']);
  });
});

describe('suiteVerdicts — suite scope (shared members never leak)', () => {
  function seedSuite(id: string, members: string[]): void {
    db.prepare(`INSERT INTO suites(id, name, created_by, created_at, updated_at) VALUES (?, ?, 'qa', 0, 0)`).run(id, id);
    members.forEach((t, i) => db.prepare('INSERT INTO suite_members(suite_id, template_id, position) VALUES (?, ?, ?)').run(id, t, i));
  }
  function seedSuiteRun(id: string, tpl: string, status: string, suite: string, at: number): void {
    db.prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at, finished_at, template_id, suite_id)
                VALUES (?, 'T', 'manual', ?, 'qa', 'sim', ?, ?, ?, ?)`)
      .run(id, status, at, at + 1000, tpl, suite);
  }

  it('running one suite does not change the other suite sharing the same member cases', () => {
    seedTpl('t1', 'login');
    seedSuite('s1', ['t1']);
    seedSuite('s2', ['t1']); // same case, different pack
    seedSuiteRun('r1', 't1', 'passed', 's1', 1000);
    // s2 has NO runs of t1 stamped with s2 — its verdict must stay absent
    expect(suiteVerdicts(db, 's1').get('t1')?.lastStatus).toBe('passed');
    expect(suiteVerdicts(db, 's2').has('t1')).toBe(false);
  });

  it('suite-scoped trend counts only runs stamped with this suite', () => {
    seedTpl('t1', 'login');
    seedSuite('s1', ['t1']);
    seedSuite('s2', ['t1']);
    seedSuiteRun('r1', 't1', 'passed', 's1', 1000);
    seedSuiteRun('r2', 't1', 'failed', 's2', 2000);
    seedSuiteRun('r3', 't1', 'passed', 's1', 3000);
    const v1 = suiteVerdicts(db, 's1').get('t1')!;
    expect(v1.lastStatus).toBe('passed');      // r3 — s1's own last play
    expect(v1.totalRuns).toBe(2);              // r1, r3 — not s2's r2
    const v2 = suiteVerdicts(db, `s2`).get('t1')!;
    expect(v2.lastStatus).toBe('failed');      // s2's own last play
    expect(v2.totalRuns).toBe(1);
  });

  it('no suiteId = case-level semantics (cases page unchanged)', () => {
    seedTpl('t1', 'login');
    seedSuite('s1', ['t1']);
    seedSuite('s2', ['t1']);
    seedSuiteRun('r1', 't1', 'passed', 's1', 1000);
    seedSuiteRun('r2', 't1', 'failed', 's2', 2000);
    const v = suiteVerdicts(db).get('t1')!; // all runs
    expect(v.lastStatus).toBe('failed');
    expect(v.totalRuns).toBe(2);
  });
});
