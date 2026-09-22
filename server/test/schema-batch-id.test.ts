import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateM1 } from '../src/db/schema.ts';

/** Overview slice T1 — runs.batch_id: persisted execution-set identity.
 *  Fresh DBs carry the column in CREATE; legacy DBs gain it via guarded
 *  ALTER; NULL is honest ("pre-batch" / solo play), never backfilled. */
let tmp: string;
let db: Database.Database;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ov-batch-'));
  db = new Database(join(tmp, 't.db'));
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const COL = "SELECT 1 FROM pragma_table_info('runs') WHERE name = 'batch_id'";

describe('T1 — runs.batch_id migration', () => {
  it('fresh DB: column exists after migrateM1', () => {
    migrateM1(db);
    expect(db.prepare(COL).get()).toBeDefined();
  });

  it('legacy DB (pre-column): guarded ALTER adds it; existing rows read NULL', () => {
    // genuine pre-slice shape: runs WITHOUT batch_id, minimal columns
    db.exec(`CREATE TABLE runs(
      id TEXT PRIMARY KEY, ticket_key TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
      triggered_by TEXT NOT NULL, device_udid TEXT NOT NULL, started_at INTEGER, finished_at INTEGER, note TEXT
    )`);
    db.prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at)
                VALUES ('run_legacy', 'T-1', 'manual', 'passed', 'qa', 'sim-1', 1)`).run();
    migrateM1(db);
    expect(db.prepare(COL).get()).toBeDefined();
    const row = db.prepare('SELECT batch_id FROM runs WHERE id = ?').get('run_legacy') as { batch_id: string | null };
    expect(row.batch_id).toBeNull(); // no invented identity
  });

  it('batch_id is writable and indexed', () => {
    migrateM1(db);
    db.prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at, batch_id)
                VALUES ('run_b', 'T-1', 'manual', 'passed', 'qa', 'sim-1', 1, 'batch_ab12')`).run();
    expect((db.prepare('SELECT batch_id FROM runs WHERE id = ?').get('run_b') as { batch_id: string }).batch_id).toBe('batch_ab12');
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='runs' AND name='idx_runs_batch'").get();
    expect(idx).toBeDefined();
  });

  it('idempotent: second migrateM1 is a no-op', () => {
    migrateM1(db);
    expect(() => migrateM1(db)).not.toThrow();
    expect(db.prepare(COL).get()).toBeDefined();
  });
});
