/** M1 schema (append-only; DDL is contract per plans/M1 §1). */
import type Database from 'better-sqlite3';

export function migrateM1(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta(
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runs(
      id TEXT PRIMARY KEY,
      ticket_key TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('automated','manual','rerun')),
      status TEXT NOT NULL CHECK(status IN ('queued','running','passed','failed','aborted')),
      triggered_by TEXT NOT NULL,
      device_udid TEXT NOT NULL,
      artifact_path TEXT, artifact_hash TEXT, artifact_mtime INTEGER,
      src_path TEXT,
      freshness TEXT NOT NULL DEFAULT 'unchecked'
        CHECK(freshness IN ('fresh','stale_ignored','unchecked')),
      launch_args_json TEXT NOT NULL DEFAULT '[]',
      scenario_id TEXT, scenario_sha TEXT,
      parent_run_id TEXT REFERENCES runs(id),
      started_at INTEGER, finished_at INTEGER,
      note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_runs_ticket ON runs(ticket_key, started_at DESC);

    CREATE TABLE IF NOT EXISTS run_steps(
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      idx INTEGER NOT NULL,
      flow_name TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pass','fail','skip','error')),
      reason TEXT,
      started_at INTEGER,
      duration_ms INTEGER,
      evidence_ids_json TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY(run_id, idx)
    );

    CREATE TABLE IF NOT EXISTS ac_results(
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      ticket_key TEXT NOT NULL,
      ac_id TEXT NOT NULL,
      ac_text TEXT NOT NULL,
      category TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pass','fail','skip')),
      flow_names_json TEXT NOT NULL,
      bundle_id TEXT,
      PRIMARY KEY(run_id, ac_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ac_ticket ON ac_results(ticket_key, ac_id);

    CREATE TABLE IF NOT EXISTS evidence(
      id TEXT PRIMARY KEY,
      bundle_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('video','screenshot','diff','measurement','logs','network')),
      path TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      moov_ok INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_evidence_sha ON evidence(sha256);

    CREATE TABLE IF NOT EXISTS devices(
      udid TEXT PRIMARY KEY,
      name TEXT,
      state TEXT,
      lease_holder TEXT,
      lease_engine TEXT,
      last_seen INTEGER NOT NULL
    );
  `);
  db.prepare("INSERT OR IGNORE INTO schema_meta(key, value) VALUES ('schema_version', '1')").run();
}
