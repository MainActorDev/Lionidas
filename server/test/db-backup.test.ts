import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrateM1 } from '../src/db/schema.ts';
import { backupDb } from '../src/db/backup.ts';

let db: Database.Database;
let dir: string;

beforeEach(() => {
  db = new Database(':memory:');
  migrateM1(db);
  dir = mkdtempSync(join(tmpdir(), 'bkp-'));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('backupDb', () => {
  it('writes a valid sqlite snapshot with the expected tables', async () => {
    db.prepare(`INSERT INTO templates(id, name, ticket_key, udid, steps_json, created_by, created_at, updated_at)
                VALUES ('t1', 'n', NULL, 'u', '[]', 'qa', 0, 0)`).run();
    const path = await backupDb(db, dir);
    expect(path).not.toBeNull();
    expect(existsSync(path as string)).toBe(true);
    const copy = new Database(path as string);
    const tables = copy.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain('templates');
    expect((copy.prepare(`SELECT COUNT(*) c FROM templates`).get() as { c: number }).c).toBe(1);
    copy.close();
  });

  it('same-day second call is a no-op (idempotent stamp)', async () => {
    const a = await backupDb(db, dir);
    const files = readdirSync(dir).filter((f) => f.endsWith('.db'));
    const b = await backupDb(db, dir);
    expect(a).toBe(b);
    expect(readdirSync(dir).filter((f) => f.endsWith('.db')).length).toBe(files.length);
  });

  it('prunes beyond KEEP backups', async () => {
    // simulate 9 dated files
    for (let i = 1; i <= 9; i++) {
      const stamp = `2026${String(Math.floor((i - 1) / 28) + 1).padStart(2, '0')}${String(((i - 1) % 28) + 1).padStart(2, '0')}`;
      db.backup(join(dir, `crucible-${stamp}.db`)).then(() => undefined, () => undefined);
    }
    await new Promise((r) => setTimeout(r, 300));
    // today's real backup triggers the prune
    await backupDb(db, dir);
    await new Promise((r) => setTimeout(r, 200));
    const files = readdirSync(dir).filter((f) => f.endsWith('.db'));
    expect(files.length).toBeLessThanOrEqual(8); // 7 kept + today's
  });
});
