import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateM1 } from '../src/db/schema.ts';

/** Wall QoL T1 — device_pins: per-account favorites. Pins survive device-row
 *  deletion (no FK on udid) so they re-arm when the sim returns. */
let tmp: string;
let db: Database.Database;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'pins-'));
  db = new Database(join(tmp, 't.db'));
  migrateM1(db);
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('T1 — device_pins', () => {
  it('table exists with per-account composite PK', () => {
    const cols = db.prepare("SELECT name FROM pragma_table_info('device_pins')").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toEqual(['user_id', 'udid', 'pinned_at']);
  });

  it('composite PK: same user+device twice rejected; other users independent', () => {
    db.prepare('INSERT INTO device_pins VALUES (?,?,?)').run('usr_a', 'sim_1', 1);
    expect(() => db.prepare('INSERT INTO device_pins VALUES (?,?,?)').run('usr_a', 'sim_1', 2)).toThrow();
    db.prepare('INSERT INTO device_pins VALUES (?,?,?)').run('usr_b', 'sim_1', 3);
    expect(db.prepare('SELECT COUNT(*) c FROM device_pins').get()).toEqual({ c: 2 });
  });

  it('pin survives device-row deletion (mirror hygiene sweep)', () => {
    db.prepare("INSERT INTO devices(udid, name, state, last_seen) VALUES (?,?,?,?)").run('sim_1', 'iPhone 14', 'Shutdown', 1);
    db.prepare('INSERT INTO device_pins VALUES (?,?,?)').run('usr_a', 'sim_1', 1);
    db.prepare('DELETE FROM devices WHERE udid = ?').run('sim_1');
    expect(db.prepare('SELECT COUNT(*) c FROM device_pins').get()).toEqual({ c: 1 });
  });

  it('legacy DB (pre-pins) gains the table on re-migrate', () => {
    db.exec('DROP TABLE device_pins');
    migrateM1(db); // idempotent
    expect(db.prepare('SELECT COUNT(*) c FROM device_pins').get()).toEqual({ c: 0 });
  });
});
