import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateM1 } from '../src/db/schema.ts';

/** Run detail build anchoring — runs.app_build (CFBundleVersion) stamped at
 *  run creation alongside app_version. NULL on legacy rows (never backfilled)
 *  and when simctl reports no CFBundleVersion. */
let tmp: string;
let db: Database.Database;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'appbuild-'));
  db = new Database(join(tmp, 't.db'));
  migrateM1(db);
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('runs.app_build', () => {
  it('column exists on fresh DBs', () => {
    const cols = db.prepare("SELECT name FROM pragma_table_info('runs')").all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'app_build')).toBe(true);
  });

  it('legacy DB keeps column + data through re-migrate (guarded ALTER idempotent)', () => {
    db.prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at) VALUES ('rx','T','manual','passed','qa','sim',1)`).run();
    db.prepare("UPDATE runs SET app_build = '420' WHERE id = 'rx'").run();
    migrateM1(db);
    const v = db.prepare('SELECT app_build FROM runs WHERE id = ?').get('rx') as { app_build: string | null };
    expect(v.app_build).toBe('420');
  });

  it('run insert with app_build round-trips (shape the playback INSERT uses)', () => {
    db.prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at, note, template_id, app_version, app_build)
                VALUES ('r1','T','manual','passed','qa','sim',1,'n',NULL,'1.2.0','420')`).run();
    const r = db.prepare('SELECT app_version, app_build FROM runs WHERE id = ?').get('r1') as { app_version: string; app_build: string };
    expect(r).toEqual({ app_version: '1.2.0', app_build: '420' });
  });

  it('NULL allowed (legacy rows, simctl miss)', () => {
    db.prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at) VALUES ('r2','T','manual','passed','qa','sim',1)`).run();
    const r = db.prepare('SELECT app_build FROM runs WHERE id = ?').get('r2') as { app_build: string | null };
    expect(r.app_build).toBeNull();
  });
});
