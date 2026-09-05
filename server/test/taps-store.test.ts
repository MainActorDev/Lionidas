import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateM1 } from '../src/db/schema.ts';
import { recordTap, tapsForRun } from '../src/evidence/taps-store.ts';

/** Task 1 — persist taps (record side). Domain contract:
 *  recordTap() stores a tap row per tap/fill dispatch; ts injected for
 *  determinism; zero-dims rejected; rows ordered by seq. */
describe('run_taps store', () => {
  let db: Database.Database;
  let dir: string;
  const base = { runId: 'run_t1', idx: 3, logicalW: 393, logicalH: 852 };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crucible-taps-'));
    db = new Database(join(dir, 'test.db'));
    migrateM1(db);
    db.prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, freshness) VALUES ('run_t1', 'X-1', 'manual', 'passed', 'qa', 'u1', 'unchecked')`).run();
  });

  it('records a tap row with injected ts, ordered by seq', () => {
    recordTap(db, { ...base, x: 196, y: 488 }, 1000);
    recordTap(db, { ...base, runId: 'run_t1', x: 100, y: 200 }, 1500);
    const rows = tapsForRun(db, 'run_t1');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ seq: 1, ts: 1000, x: 196, y: 488, logicalW: 393 });
    expect(rows[1]).toMatchObject({ seq: 2, ts: 1500, x: 100, y: 200 });
  });

  it('rejects zero-dims taps (pre-snapshot targetW ?? 0)', () => {
    recordTap(db, { ...base, x: 5, y: 5, logicalW: 0, logicalH: 0 }, 1000);
    expect(tapsForRun(db, 'run_t1')).toHaveLength(0);
  });

  it('rejects out-of-bounds taps (x<0 || x>logicalW || y<0 || y>logicalH)', () => {
    recordTap(db, { ...base, x: -1, y: 100 }, 1000);
    recordTap(db, { ...base, x: 400, y: 100 }, 1000);
    recordTap(db, { ...base, x: 100, y: 900 }, 1000);
    expect(tapsForRun(db, 'run_t1')).toHaveLength(0);
  });

  it('cascade-deletes with the run (retention stays owner)', () => {
    recordTap(db, { ...base, x: 196, y: 488 }, 1000);
    db.prepare('DELETE FROM runs WHERE id = ?').run('run_t1');
    expect(tapsForRun(db, 'run_t1')).toHaveLength(0);
  });
});
