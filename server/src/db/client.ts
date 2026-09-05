import Database from 'better-sqlite3';

export interface Db {
  raw: Database.Database;
  close(): void;
}

/** Open SQLite with WAL + busy timeout (single-writer orchestrator, PLAN §14). */
export function openDb(path: string): Db {
  const raw = new Database(path);
  raw.pragma('journal_mode = WAL');
  raw.pragma('busy_timeout = 5000');
  raw.pragma('synchronous = NORMAL'); // crash-safe under WAL, faster than FULL
  raw.pragma('foreign_keys = ON');
  // M0: schema_meta only (idempotent; M1 supersedes with drizzle-kit migrations).
  raw.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta(
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  const insert = raw.prepare(
    "INSERT INTO schema_meta(key, value) VALUES ('schema_version', '0') ON CONFLICT(key) DO NOTHING",
  );
  insert.run();
  return { raw, close: () => raw.close() };
}
