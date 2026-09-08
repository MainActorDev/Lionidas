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

    CREATE TABLE IF NOT EXISTS queue(
      id TEXT PRIMARY KEY,
      spec_json TEXT NOT NULL,
      priority INTEGER NOT NULL CHECK(priority IN (0,1,2)),
      state TEXT NOT NULL CHECK(state IN ('waiting','dispatched','done','aborted')),
      requested_by TEXT NOT NULL,
      enqueued_at INTEGER NOT NULL,
      dispatched_run_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_queue_state ON queue(state, priority, enqueued_at);

    CREATE TABLE IF NOT EXISTS presets(
      id TEXT PRIMARY KEY,
      method TEXT NOT NULL,
      path_pattern TEXT NOT NULL,
      match TEXT NOT NULL CHECK(match IN ('exact','glob','regex')),
      status INTEGER NOT NULL,
      headers_json TEXT,
      body_path TEXT,
      delay_ms INTEGER,
      seq_json TEXT,
      failure TEXT,
      throttle_kbps INTEGER,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      sha256 TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scenarios(
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      launch_arg TEXT,
      created_by TEXT NOT NULL,
      immutable_since INTEGER
    );
    CREATE TABLE IF NOT EXISTS scenario_overrides(
      scenario_id TEXT NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
      preset_id TEXT NOT NULL REFERENCES presets(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY(scenario_id, preset_id)
    );
    CREATE TABLE IF NOT EXISTS traffic(
      id TEXT PRIMARY KEY,
      run_id TEXT,
      ts INTEGER NOT NULL,
      mode TEXT NOT NULL,
      method TEXT NOT NULL,
      host TEXT,
      path TEXT NOT NULL,
      matched_preset_id TEXT,
      status INTEGER NOT NULL,
      latency_ms INTEGER NOT NULL,
      req_sha TEXT,
      res_sha TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_traffic_run ON traffic(run_id, ts);

    -- captured request/response bodies (content-addressed; one row per unique body)
    CREATE TABLE IF NOT EXISTS traffic_bodies(
      sha TEXT PRIMARY KEY,
      content_type TEXT,
      body BLOB NOT NULL,
      bytes INTEGER NOT NULL,
      first_seen INTEGER NOT NULL
    );

    -- QA test templates: recorded manual flows, replayable as regression configs
    CREATE TABLE IF NOT EXISTS templates(
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      ticket_key TEXT,
      udid TEXT NOT NULL,
      logical_w INTEGER, logical_h INTEGER,
      steps_json TEXT NOT NULL,
      default_preset_id TEXT REFERENCES presets(id) ON DELETE SET NULL,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_templates_ticket ON templates(ticket_key);

    CREATE TABLE IF NOT EXISTS baselines(
      id TEXT PRIMARY KEY,
      scope_key TEXT NOT NULL,
      image_sha256 TEXT NOT NULL,
      evidence_id TEXT,
      approved_by TEXT NOT NULL,
      approved_at INTEGER NOT NULL,
      supersedes_id TEXT,
      ticket_key TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_baselines_scope ON baselines(scope_key, approved_at DESC);
    CREATE TABLE IF NOT EXISTS baseline_diffs(
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      scope_key TEXT NOT NULL,
      old_sha TEXT,
      new_sha TEXT,
      evidence_id TEXT,
      state TEXT NOT NULL CHECK(state IN ('pending','approved','rejected')),
      decided_by TEXT,
      decided_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_diffs_state ON baseline_diffs(state, scope_key);

    CREATE TABLE IF NOT EXISTS manual_sessions(
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      udid TEXT NOT NULL,
      operator TEXT NOT NULL,
      logical_w INTEGER, logical_h INTEGER,
      started_at INTEGER NOT NULL,
      last_activity INTEGER NOT NULL,
      finished_at INTEGER,
      recording_json TEXT
    );
    CREATE TABLE IF NOT EXISTS flow_quarantine(
      flow_key TEXT PRIMARY KEY,
      reason TEXT NOT NULL,
      by TEXT NOT NULL,
      at INTEGER NOT NULL,
      released_by TEXT,
      released_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS devices(
      udid TEXT PRIMARY KEY,
      name TEXT,
      state TEXT,
      platform TEXT,
      kind TEXT,
      os_version TEXT,
      lease_holder TEXT,
      lease_engine TEXT,
      last_seen INTEGER NOT NULL
    );
  `);
  db.prepare("INSERT OR IGNORE INTO schema_meta(key, value) VALUES ('schema_version', '1')").run();
  // M3 additions (guarded ALTERs — idempotent on existing DBs)
  for (const col of [
    'ALTER TABLE runs ADD COLUMN jira_comment_id TEXT',
    // device mirror gains platform/kind (sim vs physical vs host) — older DBs lack the columns
    'ALTER TABLE devices ADD COLUMN platform TEXT',
    'ALTER TABLE devices ADD COLUMN kind TEXT',
    'ALTER TABLE devices ADD COLUMN os_version TEXT',
    // logical screen, points + scale (e.g. '428×926 @3x') — static per model
    // (deviceTypeIdentifier table), available even while shutdown
    'ALTER TABLE devices ADD COLUMN resolution TEXT',
    // manual sessions gain the recorder steps store (QA records flows for templates)
    'ALTER TABLE manual_sessions ADD COLUMN recording_json TEXT',
    // templates bind to the app they were recorded in — playback launches it first
    'ALTER TABLE templates ADD COLUMN app_bundle_id TEXT',
    'ALTER TABLE templates ADD COLUMN setup_json TEXT',
    'ALTER TABLE templates ADD COLUMN alerts_policy TEXT',
    'ALTER TABLE templates ADD COLUMN app_name TEXT',
    'ALTER TABLE templates ADD COLUMN app_version TEXT',
    // Maestro batch 1: template tags (filtered regression selection) + evaluated
    // step logging (post-substitution audit truth)
    'ALTER TABLE templates ADD COLUMN tags_json TEXT',
    'ALTER TABLE run_steps ADD COLUMN evaluated_json TEXT',
    // Batch 4 — suite management: runs carry their template (case) for
    // history/trend joins, the app build they tested, and the blocked
    // dimension (infra failure ≠ app failure; boolean, NOT a status value —
    // the status CHECK constraint would need a table rebuild).
    'ALTER TABLE runs ADD COLUMN template_id TEXT REFERENCES templates(id) ON DELETE SET NULL',
    'ALTER TABLE runs ADD COLUMN video_path TEXT',
    'ALTER TABLE runs ADD COLUMN app_version TEXT',
    'ALTER TABLE runs ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0',
    // Tier 2.2 — tap-overlay evidence: per-dispatch tap/fill points
    // (manual runs) + the video alignment anchor. Guards live in
    // taps-store.recordTap; retention deletes ride ON DELETE CASCADE.
    'ALTER TABLE runs ADD COLUMN video_started_at INTEGER',
    // Auth v2 — admin approval gate: Jira auto-created users are born pending (approved=0)
    // and cannot log in until an admin approves. Local users are admin-created → born approved.
    'ALTER TABLE users ADD COLUMN approved INTEGER NOT NULL DEFAULT 1',
  ]) {
    try { db.exec(col); } catch { /* column exists */ }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_taps(
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      idx INTEGER,
      x REAL NOT NULL,
      y REAL NOT NULL,
      logical_w REAL NOT NULL,
      logical_h REAL NOT NULL,
      PRIMARY KEY(run_id, seq)
    );
  `);
  // build anchoring: filter/index runs by app version
  db.exec('CREATE INDEX IF NOT EXISTS idx_runs_app_version ON runs(app_version, started_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_runs_template ON runs(template_id, started_at DESC)');
  // Batch 4 — plans: remembered suite invocations (tag filter + device + app +
  // scenario + env) replayed through the same play-all path
  db.exec(`
    CREATE TABLE IF NOT EXISTS plans(
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      tags_json TEXT NOT NULL DEFAULT '[]',
      udid TEXT,
      app_bundle_id TEXT,
      scenario_id TEXT,
      env_json TEXT NOT NULL DEFAULT '{}',
      created_by TEXT NOT NULL DEFAULT 'qa',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_catalog(
      bundle_id TEXT PRIMARY KEY,
      artifact_path TEXT NOT NULL,
      artifact_sha TEXT,
      app_version TEXT,
      recorded_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users(
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('viewer','operator','admin','bot')),
      password_hash TEXT,
      auth_source TEXT NOT NULL DEFAULT 'local',
      jira_subject TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      approved INTEGER NOT NULL DEFAULT 1,  -- 0 = awaiting admin approval (Jira first-login)
      created_at INTEGER NOT NULL,
      last_login_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS sessions(
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mx_payloads(
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      app_version TEXT,
      device_id TEXT,
      device_model TEXT,
      os_version TEXT,
      kind TEXT NOT NULL,               -- metric | diagnostic
      received_at INTEGER NOT NULL,
      captured_at INTEGER,
      source TEXT,                      -- pull:<udid> | inject
      payload_json TEXT NOT NULL,
      summary_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_mx_feed ON mx_payloads(app_id, received_at DESC);
    CREATE INDEX IF NOT EXISTS idx_mx_dedupe ON mx_payloads(device_id, captured_at, kind);
    CREATE TABLE IF NOT EXISTS auth_log(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      email TEXT,
      user_id TEXT,
      event TEXT NOT NULL,            -- login | login_failed | logout | session_killed
      detail TEXT
    );
  `);
  // additive auth-era columns (older DBs migrate in place)
  const cols = db.prepare("SELECT name FROM pragma_table_info('templates')").all() as Array<{ name: string }>;
  const has = (c: string): boolean => cols.some((x) => x.name === c);
  if (!has('created_by')) db.prepare('ALTER TABLE templates ADD COLUMN created_by TEXT').run();
  if (!has('updated_by')) db.prepare('ALTER TABLE templates ADD COLUMN updated_by TEXT').run();
  db.exec(`
  `);
}
