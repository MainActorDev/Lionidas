/** M1 schema (append-only; DDL is contract per plans/M1 §1). */
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';

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
      note TEXT,
      batch_id TEXT
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
      -- Phase E: case lifecycle. API validates; the CHECK is fresh-DB-only
      -- (guarded ALTERs cannot add constraints — house pattern).
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('draft','active','deprecated')),
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
    -- Device pins (wall QoL): per-account favorites. No FK on udid — a pin
    -- must survive the device row's deletion (mirror hygiene sweep) so it
    -- re-arms automatically when the sim comes back from a runtime reinstall.
    CREATE TABLE IF NOT EXISTS device_pins(
      user_id TEXT NOT NULL,
      udid TEXT NOT NULL,
      pinned_at INTEGER NOT NULL,
      PRIMARY KEY(user_id, udid)
    );
    -- R2 S3 — app screen registry: the app's map (how to arrive, how to
    -- refresh, named states). Cases REFERENCE screens; the registry owns the
    -- truth. JSON columns keep the shape flexible while the model settles;
    -- validation lives in domain/app-screens.ts (API validates on write).
    CREATE TABLE IF NOT EXISTS app_screens(
      app_bundle_id TEXT NOT NULL,
      screen_id TEXT NOT NULL,
      entry_json TEXT NOT NULL,
      refresh_json TEXT,
      states_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY(app_bundle_id, screen_id)
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
    // step narrate: optional per-step Gherkin acceptance line (display-only;
    // plan 20260929T030722Z) — old rows NULL
    'ALTER TABLE run_steps ADD COLUMN narrate TEXT',
    // app session heal: the bundle the session opened, so staleness can re-open it
    'ALTER TABLE manual_sessions ADD COLUMN app_bundle_id TEXT',
    // templates bind to the app they were recorded in — playback launches it first
    'ALTER TABLE templates ADD COLUMN app_bundle_id TEXT',
    'ALTER TABLE templates ADD COLUMN setup_json TEXT',
    'ALTER TABLE templates ADD COLUMN alerts_policy TEXT',
    // Phase B — test variants: one flow, N deterministic worlds (scenario +
    // env per variant). NULL ≡ no variants (absence IS the value — no backfill).
    'ALTER TABLE templates ADD COLUMN variants_json TEXT',
    // Phase C0 — preset guards persistence: the matcher supported query/
    // header guards since the forge spike but nothing ever STORED them
    // (presetRowToSpec never read them; no column existed). {query?, headers?}
    'ALTER TABLE presets ADD COLUMN guards_json TEXT',
    // Phase C — case_versions variant identity. NO-OP on fresh DBs (table
    // created below WITH the columns; the loop's catch swallows the missing
    // table) and EFFECTIVE on DBs whose case_versions predates Phase C.
    'ALTER TABLE case_versions ADD COLUMN variant_id TEXT',
    'ALTER TABLE case_versions ADD COLUMN variant_env_json TEXT',
    'ALTER TABLE templates ADD COLUMN app_name TEXT',
    'ALTER TABLE templates ADD COLUMN app_version TEXT',
    // Maestro batch 1: template tags (filtered regression selection) + evaluated
    // step logging (post-substitution audit truth)
    'ALTER TABLE templates ADD COLUMN tags_json TEXT',
    'ALTER TABLE run_steps ADD COLUMN evaluated_json TEXT',
    // R2 screen-state runner: case-level entry facet (which registry screen
    // the case enters, and via which mode) — persisted so the yaml
    // round-trip and playback agree without recovering it from steps
    'ALTER TABLE templates ADD COLUMN entry_json TEXT',
    // registry-UI stage 2 (review F3): optimistic-concurrency revision on the
    // screen registry — PUT with a stale revision 409s instead of last-write-wins
    'ALTER TABLE app_screens ADD COLUMN revision INTEGER NOT NULL DEFAULT 1',
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
    // Test-case management Phase A — case versions: every run pins the exact
    // content it executed. variant_id lands now (Phase C writes it) so the
    // migration era stays one; nothing writes it yet.
    'ALTER TABLE runs ADD COLUMN case_version_id TEXT',
    'ALTER TABLE runs ADD COLUMN variant_id TEXT',
    // Phase D — suites: runs name the suite that spawned them (survives suite
    // deletion: SET NULL renders `suite: <deleted>` honestly); plans may
    // reference a suite as their case source (exactly-one-of tags|suite, T5).
    'ALTER TABLE runs ADD COLUMN suite_id TEXT REFERENCES suites(id) ON DELETE SET NULL',
    'ALTER TABLE plans ADD COLUMN suite_id TEXT REFERENCES suites(id) ON DELETE SET NULL',
    // Phase E — case status lifecycle: draft | active | deprecated. NULL only
    // on pre-E DBs between ALTER and the backfill below; backfill normalizes.
    'ALTER TABLE templates ADD COLUMN status TEXT',
    // Overview slice — persisted execution-set identity: every run minted by
    // a batch (play-all / plan / suite play / multi-variant lane-chain play)
    // carries its batch's id. NULL = solo play or pre-slice run ("pre-batch",
    // honest label — never backfilled). Set membership replaces the 120s
    // timestamp-window guess suiteVerdicts uses for legacy rows.
    'ALTER TABLE runs ADD COLUMN batch_id TEXT',
    // Build anchoring (run detail): CFBundleVersion stamped at run creation —
    // the marketing version (app_version) alone doesn't identify a build.
    'ALTER TABLE runs ADD COLUMN app_build TEXT',
  ]) {
    try { db.exec(col); } catch { /* column exists */ }
  }
  // ── project registry (plan 20261005T092500Z): one project = one repo,
  // many bundle ids may hang off it later. auth_token is stored PLAINTEXT
  // (review M1: future consumers must PRESENT it to git — a hash cannot);
  // the store layer owns the projection and NEVER selects it into API
  // responses. Local SQLite + admin-only surface, env_vars precedent. ──
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects(
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      repo_url TEXT NOT NULL,
      local_path TEXT,
      default_branch TEXT,
      auth_token TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    -- package attribution: packages are FILES, not rows — the claim maps an
    -- exact packages-dir path to its owning project (re-claim after a rename
    -- is one click; review L2)
    CREATE TABLE IF NOT EXISTS package_owner(
      package_path TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE
    );
    -- CI builds (plan 20261007T054500Z): one row per build attempt; numbers
    -- monotonic PER PROJECT. Artifacts land in the packages dir + claim.
    CREATE TABLE IF NOT EXISTS builds(
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      number INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running','passed','failed')),
      transport TEXT NOT NULL CHECK(transport IN ('repo-lane','generic')),
      scheme TEXT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      log_path TEXT,
      artifact_path TEXT,
      error TEXT,
      UNIQUE(project_id, number)
    );
  `);
  // Phase E: legacy rows must READ active, not NULL. ALTER DEFAULT only
  // covers new inserts; normalize once. Idempotent (WHERE status IS NULL —
  // explicit draft/deprecated survive re-migrates).
  try { db.prepare("UPDATE templates SET status = 'active' WHERE status IS NULL").run(); } catch { /* table shape unexpected — tests pin the happy path */ }
  // Phase A — immutable case-version snapshots. Deliberately NO FK on
  // template_id: a version must survive its template's deletion (historical
  // runs keep resolving their inputs). Identity = (template, revision).
  db.exec(`
    CREATE TABLE IF NOT EXISTS case_versions(
      id TEXT PRIMARY KEY,
      template_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      steps_sha256 TEXT NOT NULL,
      yaml_canonical TEXT NOT NULL,
      scenario_id TEXT,
      scenario_snapshot_json TEXT,
      source TEXT NOT NULL CHECK(source IN ('run','backfill')) DEFAULT 'run',
      created_by TEXT,
      created_at INTEGER NOT NULL,
      -- Phase C: variant identity — label + the env that differentiates two
      -- variants of the same steps (in the CREATE because the guarded-ALTER
      -- loop above runs BEFORE this table exists on fresh DBs).
      variant_id TEXT,
      variant_env_json TEXT,
      UNIQUE(template_id, revision)
    );
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_case_versions_template ON case_versions(template_id, revision DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_runs_version ON runs(case_version_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_runs_batch ON runs(batch_id)');
  // Idempotent backfill: every existing case gets an honest revision 1
  // ("backfill" = current content, no invented provenance). tsx-watch
  // re-runs migrate on every edit — the NOT EXISTS guard makes repeats a
  // no-op. Runs created before versioning stay case_version_id NULL
  // (the UI shows "pre-versioning", never a fabricated link). The
  // canonical yaml is filled lazily by the snapshot service on next run —
  // backfill rows carry the steps hash, the honest minimum.
  {
    const insert = db.prepare(`
      INSERT INTO case_versions(id, template_id, revision, steps_sha256, yaml_canonical, source, created_by, created_at)
      VALUES (?, ?, 1, ?, '', 'backfill', ?, ?)`);
    const rows = db.prepare(`
      SELECT t.id, t.steps_json, t.created_by, t.updated_at FROM templates t
      WHERE NOT EXISTS (SELECT 1 FROM case_versions cv WHERE cv.template_id = t.id)`).all() as
      Array<{ id: string; steps_json: string; created_by: string | null; updated_at: number }>;
    for (const t of rows) {
      insert.run(`cv_bf_${t.id}`, t.id, createHash('sha256').update(t.steps_json).digest('hex'), t.created_by, t.updated_at);
    }
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
      updated_at INTEGER NOT NULL,
      -- Phase D: a plan may name a suite as its case source (T5 —
      -- exactly-one-of tags|suite validated at the route). In the CREATE so
      -- fresh DBs get it natively; the guarded ALTER covers pre-D DBs.
      suite_id TEXT REFERENCES suites(id) ON DELETE SET NULL
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
      event TEXT NOT NULL,            -- login | login_failed | logout | session_killed | approved | unapproved
                                      -- | role_changed | active_changed | password_changed | bot_token_rotated
      detail TEXT
    );
    -- Phase D — suites: a named, ordered collection of case memberships,
    -- each membership one case + an optional variant subset. Live read, not
    -- a snapshot (TestSuiteVersion forbidden by the brief); verdicts are
    -- computed from runs, never stored here. Membership dies with its case
    -- (CASCADE); a deleted suite's runs survive (runs.suite_id SET NULL).
    -- Bundle scope: every member shares the suite's app_bundle_id (API-level
    -- invariant — a suite answers "is THIS app ok", never a mixed bag).
    CREATE TABLE IF NOT EXISTS suites(
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      app_bundle_id TEXT,
      created_by TEXT NOT NULL DEFAULT 'qa',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS suite_members(
      suite_id TEXT NOT NULL REFERENCES suites(id) ON DELETE CASCADE,
      template_id TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
      -- NULL = the case's default play semantics (variants case → all
      -- variants; plain case → plain). ["sg","my"] = pinned subset.
      variant_ids_json TEXT,
      position INTEGER NOT NULL,
      UNIQUE(suite_id, template_id)
    );
    CREATE INDEX IF NOT EXISTS idx_suite_members_suite ON suite_members(suite_id, position);
  `);
  // additive auth-era columns (older DBs migrate in place)
  const cols = db.prepare("SELECT name FROM pragma_table_info('templates')").all() as Array<{ name: string }>;
  const has = (c: string): boolean => cols.some((x) => x.name === c);
  if (!has('created_by')) db.prepare('ALTER TABLE templates ADD COLUMN created_by TEXT').run();
  if (!has('updated_by')) db.prepare('ALTER TABLE templates ADD COLUMN updated_by TEXT').run();
  // bundle-scope migration: suites gain app_bundle_id. Older DBs get it via
  // guarded ALTER + truthful backfill from members (every pre-scope suite
  // was API-forced homogeneous? no — but single-member suites and uniform
  // packs backfill cleanly; a genuinely mixed legacy suite lands NULL,
  // which is honest: it has no single app identity until edited).
  const suiteCols = db.prepare("SELECT name FROM pragma_table_info('suites')").all() as Array<{ name: string }>;
  if (!suiteCols.some((x) => x.name === 'app_bundle_id')) {
    db.prepare('ALTER TABLE suites ADD COLUMN app_bundle_id TEXT').run();
    db.prepare(`UPDATE suites SET app_bundle_id = (
      SELECT t.app_bundle_id FROM suite_members m JOIN templates t ON t.id = m.template_id
      WHERE m.suite_id = suites.id AND t.app_bundle_id IS NOT NULL
      GROUP BY t.app_bundle_id ORDER BY COUNT(*) DESC LIMIT 1
    )`).run();
  }
  // managed env vars (plan rev 2, Stage 1): scoped key/value store resolved
  // by playback's env chain (global < app < plan < request body < variant).
  // Uniqueness via COALESCE expression index — SQLite UNIQUE treats NULLs as
  // distinct so a table-level constraint can't express "one key per scope".
  // Scope-column correctness (app ⇒ bundle set, plan ⇒ plan set, global ⇒
  // both NULL) is route-layer validation.
  db.exec(`
    CREATE TABLE IF NOT EXISTS env_vars(
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL CHECK(scope IN ('global','app','plan')),
      app_bundle_id TEXT,
      plan_id TEXT REFERENCES plans(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      secret INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      updated_by TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_env_vars_key
    ON env_vars(scope, COALESCE(app_bundle_id,''), COALESCE(plan_id,''), key);
  `);
  // login as an app-level procedure (login-as-app-procedure plan): one
  // definition per app — entry (full entry object), phone/password/submit
  // controls, verify (screen, state) REFERENCE. Screens never store login.
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_login(
      bundle_id TEXT PRIMARY KEY,
      login_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1
    );
  `);
  // ── folders (plan 20260928T023000Z): app-scoped multilevel test-case
  // organization. Sibling names unique per (app, parent); path derives at
  // read time via the parent chain — renames never rewrite descendants.
  db.exec(`
    CREATE TABLE IF NOT EXISTS folders(
      id TEXT PRIMARY KEY,
      app_bundle_id TEXT NOT NULL,
      parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_sibling ON folders(app_bundle_id, IFNULL(parent_id, ''), name);
    CREATE TABLE IF NOT EXISTS scenario_folders(
      id TEXT PRIMARY KEY,
      parent_id TEXT REFERENCES scenario_folders(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_scenario_folders_sibling ON scenario_folders(IFNULL(parent_id, ''), name);
    CREATE TABLE IF NOT EXISTS preset_folders(
      id TEXT PRIMARY KEY,
      parent_id TEXT REFERENCES preset_folders(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_preset_folders_sibling ON preset_folders(IFNULL(parent_id, ''), name);
  `);
  const tplCols = db.prepare("SELECT name FROM pragma_table_info('templates')").all() as Array<{ name: string }>;
  if (!tplCols.some((x) => x.name === 'folder_id')) {
    db.prepare('ALTER TABLE templates ADD COLUMN folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL').run();
  }
  // scenario folders (plan 20260928T092527Z): global tree, scenarios.folder_id NULL = root
  const scnCols = db.prepare("SELECT name FROM pragma_table_info('scenarios')").all() as Array<{ name: string }>;
  if (!scnCols.some((x) => x.name === 'folder_id')) {
    db.prepare('ALTER TABLE scenarios ADD COLUMN folder_id TEXT REFERENCES scenario_folders(id) ON DELETE SET NULL').run();
  }
  // preset folders (plan 20260928T105500Z): manual operator organization (e.g. by app);
  // matcher/serving unchanged — folders are pure organization
  const preCols = db.prepare("SELECT name FROM pragma_table_info('presets')").all() as Array<{ name: string }>;
  if (!preCols.some((x) => x.name === 'folder_id')) {
    db.prepare('ALTER TABLE presets ADD COLUMN folder_id TEXT REFERENCES preset_folders(id) ON DELETE SET NULL').run();
  }
  // preset display names (round 3): ids like p_65a8ffa0 are too abstract —
  // the operator names presets for clarity; ids stay the stable pin
  if (!preCols.some((x) => x.name === 'name')) {
    db.prepare('ALTER TABLE presets ADD COLUMN name TEXT').run();
  }
  // app_screens gains the login recipe (Stage 1.2): nullable JSON column,
  // shape {entry, phoneField, passwordField, submit, session}.
  const screenCols = db.prepare("SELECT name FROM pragma_table_info('app_screens')").all() as Array<{ name: string }>;
  if (!screenCols.some((x) => x.name === 'login_json')) {
    db.prepare('ALTER TABLE app_screens ADD COLUMN login_json TEXT').run();
  }
  // ── CLI personal access tokens (plan 20260930T092035Z F1): lion_<hex>,
  // stored scrypt-hashed; plaintext shown once at mint. Role = creating user.
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_tokens(
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER,
      revoked_at INTEGER
    );
  `);
  // ── logout recipe registry (plan 20260929T080249Z): app-level procedure,
  // mirror of app_login. ONE recipe per bundle; cases reference it with the
  // bare `ensure logout:` verb. ATOMIC settlement of the login duality in
  // the same migration pass (review F1/F3): migrate screen-level recipes →
  // app_login wins → drop the screen column. No server state exists where
  // the column is gone but readers/writers still reference it (routes and
  // the registry-replace snapshot are updated in this same change).
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_logout(
      bundle_id TEXT PRIMARY KEY,
      logout_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1
    );
  `);
  // login settlement: any screen-level recipes move to app_login exactly
  // once (existing app_login rows win), then the column drops.
  db.prepare(`INSERT INTO app_login(bundle_id, login_json, updated_at, revision)
              SELECT app_bundle_id, login_json, 0, 1 FROM app_screens
              WHERE login_json IS NOT NULL
                AND app_bundle_id NOT IN (SELECT bundle_id FROM app_login)`).run();
  try {
    db.prepare('ALTER TABLE app_screens DROP COLUMN login_json').run();
  } catch {
    // SQLite <3.35 cannot DROP COLUMN — leave the orphaned column (unused);
    // verified safe on this stack's better-sqlite3 (3.49.2), kept as a hedge.
  }
  // ── login recipe → steps form (plan 20260930T044550Z): reshape stored
  // 5-slot recipes into step lists. Env-ref names derive from the MOST-COMMON
  // refs across referencing cases (review F6 — order-independent); no
  // referencing case → LOGIN_PHONE/LOGIN_PASSWORD placeholders. Idempotent:
  // only rows still carrying `phone`/`submit` slots (legacy shape) convert.
  const legacyRecipes = db.prepare(`SELECT bundle_id, login_json FROM app_login WHERE login_json LIKE '%"phone"%' AND login_json NOT LIKE '%"steps"%'`).all() as Array<{ bundle_id: string; login_json: string }>;
  for (const row of legacyRecipes) {
    try {
      const old = JSON.parse(row.login_json) as { entry?: unknown; phone?: string; password?: string; submit?: string; verify?: { screen?: string; state?: string; via?: string } };
      if (!old.phone || !old.password || !old.submit || !old.verify?.screen || !old.verify.state) continue;
      // most-common env refs across referencing cases (F6)
      const refCases = db.prepare("SELECT setup_json FROM templates WHERE app_bundle_id = ?").all(row.bundle_id) as Array<{ setup_json: string }>;
      const countRef = (slot: 'phone' | 'password'): string => {
        const counts = new Map<string, number>();
        for (const c of refCases) {
          try {
            for (const st of JSON.parse(c.setup_json || '[]') as Array<{ ensureLogin?: { phone?: string; password?: string } }>) {
              const v = st.ensureLogin?.[slot];
              if (typeof v === 'string' && v.startsWith('\${env.')) {
                counts.set(v, (counts.get(v) ?? 0) + 1);
              }
            }
          } catch { /* skip malformed */ }
        }
        let best = ''; let bestN = -1;
        for (const [k, n] of counts) if (n > bestN) { best = k; bestN = n; }
        return best;
      };
      const phoneRef = countRef('phone') || '\${env.LOGIN_PHONE}';
      const pwRef = countRef('password') || '\${env.LOGIN_PASSWORD}';
      const steps = [
        { type: { on: old.phone, text: phoneRef } },
        { type: { on: old.password, text: pwRef } },
        { tap: { on: old.submit } },
      ];
      const next = { entry: old.entry, steps, verify: old.verify };
      db.prepare('UPDATE app_login SET login_json = ?, updated_at = ?, revision = revision + 1 WHERE bundle_id = ?').run(JSON.stringify(next), Date.now(), row.bundle_id);
    } catch { /* leave untouched — playback fails closed with the honest message */ }
  }
}
