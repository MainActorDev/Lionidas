# Plan — Phase 2: freshness & hygiene (retention, stamping, env secrets)

- Source: brainstorm/20261008T103310Z-phase2-freshness-hygiene.md — all
  questions closed by the user (2026-10-08, "go with your recommendation"):
  N=10 · prepare-side stamping · env names CRUCIBLE_GITHUB_TOKEN /
  CRUCIBLE_JIRA_TOKEN · per-project token field DEPRECATED (column kept).
  Scheduler REMOVED from scope (user: "manual run is fine").
- Status: Ready

## Objective

Three independent stages, one branch off main. Verifiable end states:
(T1) disk bounded by retention with evidence immunity; (T2) a real build's
artifact reports CFBundleVersion == its Lionidas build number; (T3) clone/
pull authenticates via CRUCIBLE_GITHUB_TOKEN when set, Settings mirrors
secret env status, the per-project token UI is gone.

## T1 — Retention (keep-last-N, evidence immunity)

- Schema: `ALTER TABLE projects ADD COLUMN retention INTEGER` (nullable;
  NULL = default 10; CREATE parity for fresh DBs).
- `server/src/projects/retention.ts`: `enforceRetention(db, projectId?):
  { deleted: string[] }` — per project: builds WITH artifact_path ordered
  by started_at DESC; keep set = newest N ∪ builds referenced by any run
  (runs.build_id) ∪ newest passing build. For the rest: delete the file,
  `DELETE FROM package_owner WHERE package_path = ?`, set
  `artifact_path = NULL` on the row (smoke-crash semantics — history
  stays). Returns deleted paths (for the build log / boot log).
- Call sites: end of `startBuild`'s success/failure settle path (after
  claim/smoke), and once at boot for all projects (fire-and-log).
- Editor: `retention` number field (blank = default 10) in ProjectsPage
  editor + PUT round-trip (`retention?: number | null`, '' → null).
- Tests: keeps newest N; keeps run-referenced builds beyond N; keeps
  newest passing beyond N; deletes file + claim, nulls path, keeps row;
  default-10 when column NULL.

## T2 — Version stamping (env → prepare → CFBundleVersion)

- Engine: in `runCommand` invocations for prepare steps and the
  xcbuddy/xcodebuild legs, pass `env: { ...process.env,
  LIONIDAS_BUILD_NUMBER: String(number), LIONIDAS_BUILD_ID: id }` — one
  helper `buildEnv(number, id)` in builds.ts, used by all spawned steps
  (documented contract: repo-owned prepare scripts MAY stamp from it).
- Drill-repo prepare script (server/repos clone, committed to the app-repo
  PR branch): after spec surgery, inject
  `settings.CURRENT_PROJECT_VERSION` (fallback: top-level) =
  `${LIONIDAS_BUILD_NUMBER}` into project.lionidas-sim.yml when the env is
  set — xcodegen turns CURRENT_PROJECT_VERSION into CFBundleVersion.
  Fallback when unset: repo literal (current 20250515) — behavior on a
  dev machine unchanged.
- App-repo PR #413: add the same injection to scripts/prepare-sim.sh (the
  committed one) — the drill clone's copy is the spec; push one commit.
- Tests: unit — spec surgery output carries CURRENT_PROJECT_VERSION when
  env set (test the injection function on a fixture project.yml — extract
  the ruby to accept an env-tested flag or test via running the script in
  a temp dir with fake xcodegen); engine — spawned prepare children see
  LIONIDAS_BUILD_NUMBER (fake prepare script echoes env to a file).
- Drill: build #21 on the real repo → unzip artifact → CFBundleVersion ==
  '21'.

## T3 — Env secrets (status mirror, clone auth, deprecate column UI)

- `server/src/secrets.ts`: `secretStatus(): { githubToken: boolean,
  jiraToken: boolean }` — presence-only reads of the two env keys; values
  never leave the process.
- Route: `GET /api/settings/secrets` (admin) → the status object.
  SettingsPage: credentials section becomes the read-only mirror
  (`github token ✓ set via env` / `✗ unset — set CRUCIBLE_GITHUB_TOKEN`),
  each row naming its env key.
- Clone/pull auth precedence in workspace.ts: `projectAuthToken(db, id)
  ?? process.env['CRUCIBLE_GITHUB_TOKEN'] ?? null` — env token flows
  through the EXISTING token machinery (https token-in-URL / ssh
  askpass / redaction) with zero new auth paths.
- Jira connector: wherever the Jira token is configured today, accept
  `CRUCIBLE_JIRA_TOKEN` as a fallback source (survey usage in
  implementation; if Jira auth is not env-plumbed today, wire the fallback
  and note the surface).
- Deprecate per-project token: ProjectsPage editor hides the token field
  (column + projectAuthToken kept for compat; no UI writes). SettingsPage
  token-management rows (if any) replaced by the mirror.
- Tests: workspace auth precedence (per-project > env > none) with the
  fake-git harness asserting the token used; secrets route returns
  presence booleans and NEVER values; PUT project still accepts
  authToken for compat (no break) but UI never sends it.

## Edge cases

- T1: artifact already deleted on disk → GC treats as done (null path,
  drop claim) — no error.
- T1: retention = 0 → keep only immune set (runs-referenced + newest
  passing) — valid config, not special-cased.
- T2: prepare absent (repo-lane transport) → no stamping (lane owns
  everything — R2 rule). Document.
- T3: env token set AND per-project token set → per-project wins
  (explicit > ambient), documented in the precedence line.

## Verification

- `pnpm --filter server typecheck && pnpm --filter server test`; web
  typecheck + test. All green with new tests.
- T1 drill: fabricate 12 builds with fake artifacts on disk → enforce →
  assert disk keeps 10 + immune; row history intact.
- T2 drill: real build #21 → `unzip -p … Info.plist | plutil` shows
  CFBundleVersion 21.
- T3 drill: export CRUCIBLE_GITHUB_TOKEN=<value set by the USER in the
  server env, or a deliberately-wrong value> → wipe clone → clone via
  API: with a valid token private-clone works; with a wrong token the
  failure is the existing honest GIT_FAILED with redaction (no hang, no
  leak). If the user prefers not to set a real token now: drill the
  wrong-token branch only + document the valid-token drill as pending
  operator action.

## Rollout

Branch `feat/phase2-hygiene` off main; one PR, three independent commits
(T1/T2/T3). App-repo PR #413 gains the stamping commit (its branch
already carries prepare-sim.sh).
