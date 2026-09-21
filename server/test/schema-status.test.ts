import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateM1 } from '../src/db/schema.ts';

/** Phase E T1 — templates.status lifecycle column.
 *  Contract: fresh DBs carry CHECK+default; legacy DBs (pre-column) get the
 *  guarded ALTER + NULL→active backfill; both paths idempotent. */
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function freshDb(): { db: Database.Database; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'crucible-status-'));
  dirs.push(dir);
  return { db: new Database(join(dir, 'crucible.db')), dir };
}

function seedTemplate(db: Database.Database, id: string): void {
  db.prepare(`INSERT INTO templates(id, name, udid, steps_json, created_by, created_at, updated_at)
              VALUES (?, ?, 'sim-1', '[]', 'qa', 0, 0)`).run(id, id);
}


describe('templates.status migration (phase E T1)', () => {
  it('fresh DB: column exists, rows read active with CHECK default', () => {
    const { db, dir } = freshDb();
    try {
      migrateM1(db);
      seedTemplate(db, 't_fresh');
      expect((db.prepare('SELECT status FROM templates WHERE id = ?').get('t_fresh') as { status: string }).status).toBe('active');
      // CHECK enforced on fresh tables: bogus status rejected by the DB itself
      expect(() => db.prepare("UPDATE templates SET status = 'bogus' WHERE id = 't_fresh'").run()).toThrow();
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('fresh DB: explicit draft/deprecated persist', () => {
    const { db, dir } = freshDb();
    try {
      migrateM1(db);
      seedTemplate(db, 't_d');
      db.prepare("UPDATE templates SET status = 'deprecated' WHERE id = 't_d'").run();
      expect((db.prepare('SELECT status FROM templates WHERE id = ?').get('t_d') as { status: string }).status).toBe('deprecated');
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('legacy DB: NULL rows backfilled to active on re-migrate', () => {
    const { db, dir } = freshDb();
    try {
      // genuine legacy simulation: a pre-E templates table WITHOUT status but
      // WITH every column the CREATE-block indexes (ticket_key) — a legacy DB
      // predates phase E, not M0. Fresh DBs get the CHECK'd column (NULL is
      // impossible there — which is the point; legacy ALTERs carry no CHECK).
      db.exec(`CREATE TABLE templates(
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT,
        ticket_key TEXT, udid TEXT NOT NULL, logical_w INTEGER, logical_h INTEGER,
        steps_json TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
      db.prepare(`INSERT INTO templates(id, name, udid, steps_json, created_by, created_at, updated_at)
                  VALUES ('t_legacy', 't_legacy', 'sim-1', '[]', 'qa', 0, 0)`).run();
      migrateM1(db); // ALTER adds column (NULL), backfill normalizes
      expect((db.prepare('SELECT status FROM templates WHERE id = ?').get('t_legacy') as { status: string | null }).status).toBe('active');
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('migration is idempotent: migrate twice, no error, values preserved', () => {
    const { db, dir } = freshDb();
    try {
      migrateM1(db);
      seedTemplate(db, 't_keep');
      db.prepare("UPDATE templates SET status = 'draft' WHERE id = 't_keep'").run();
      migrateM1(db);
      // backfill touches only NULL rows — draft survives
      expect((db.prepare('SELECT status FROM templates WHERE id = ?').get('t_keep') as { status: string }).status).toBe('draft');
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
