# Plan — Phase 1: the build→test loop (manual action, two verdicts on one row)

- Source: brainstorm/20261008T083419Z-build-test-loop.md — all three open
  questions closed by the user (2026-10-08, chat):
  - Q1: **pinned default suite per project + override in the picker** (rec accepted)
  - Q2: **manual action only** — no scheduler this round
  - Q3: **two verdicts on one row** — suite failure NEVER flips build status;
    the suite result is a chip (`46/50` red) beside the status ball
- Status: Ready

## Objective

A `passed · smoke=ok` build can be sent into a suite run from the builds
page. The suite provably runs THAT binary (install-first), and every run it
creates is pinned to the build (`runs.build_id`). The build row shows the
suite verdict chip. Verifiable: drill build #21 → ▶ test → runs recorded
with build pin → chip on the row reads N/M → run detail links back.

## Scope

IN: `runs.build_id` column · `POST /api/builds/:id/test` · runBatch/playback
threading of buildId · per-project default suite (projects column + editor
field + picker preselect) · suite-verdict chip on build rows · build chip on
run rows (detail view).
OUT: scheduler/overnight chain (Q2: deferred) · webhooks/retention/
version-stamping (Phase 2) · new pages (029-A stays the CI surface).

## Stages

### T1 — schema
- `ALTER TABLE runs ADD COLUMN build_id TEXT REFERENCES builds(id) ON DELETE SET NULL` + fresh-CREATE parity in the runs CREATE (find it; the
  registry tables' CREATE-then-ALTER ordering bug bit us once — runs is
  created EARLY in migrateM1, so the ALTER alone suffices for both fresh
  and existing DBs; verify which by checking where the runs CREATE sits
  relative to the ALTER loop before deciding to touch the CREATE).
- `ALTER TABLE projects ADD COLUMN default_suite_id TEXT` (nullable).

### T2 — runBatch + playback threading
- `runBatch` (routes/manual.ts:702): accept `buildId?: string` in its spec;
  pass through to the playback options.
- `playback.ts` run INSERT (line 424): add `build_id` to columns+values from
  `opts.buildId ?? null`.
- Suite-play caller (`/api/suites/:id/play`) unchanged.

### T3 — `POST /api/builds/:id/test` (admin)
Location: `server/src/projects/routes.ts` (beside the build routes; it
bridges builds→suites).
1. Guards (honest 409s, house style):
   - build exists (404), status `passed` (409 `BUILD_NOT_PASSED`), smoke
     `ok` (409 `SMOKE_NOT_OK` — a crash-failed build can't be tested),
     `artifact_path` non-null and file exists (409 `ARTIFACT_MISSING`).
   - suite resolved: body `{ suiteId?: string, udid?: string }`; missing →
     project's `default_suite_id`; neither → 422 `SUITE_UNSPECIFIED` naming
     the fix (set a default on the project or pass suiteId).
   - suite exists (404), has members (409 `EMPTY_SUITE` — reuse the
     existing play endpoint's semantics), suite's `app_bundle_id` matches
     the build artifact's bundle id via `readIpaIdentity` (409
     `BUNDLE_MISMATCH` naming both ids).
2. Install-first (the point of the phase): resolve device — body udid, else
   first booted sim from the devices mirror (409 `NO_DEVICE` if none, same
   shape runBatch uses). Call the existing `installApp` with the build's
   artifact; failure → 409 `INSTALL_FAILED` with stderr.
3. `runBatch({ cases: suiteMembersWithPins, triggeredBy: 'build:#<n>',
   suiteId, buildId, udid }, req.user)` — members resolved exactly as the
   suite-play endpoint does (drift/deprecated/ghost-variant filtering with
   the same named skips; simplest: extract that member-resolution block
   into a helper both endpoints call, rather than duplicating ~40 lines).
4. Response: `{ runIds, batchId, count }`.

### T4 — default suite in registry UI
- ProjectsPage editor: one field — `default suite` select fed by
  `GET /api/suites` (admin UI already loads suites elsewhere; reuse).
- `PUT /api/projects/:id` accepts `defaultSuiteId` ('' clears) → store
  column. Projection includes it.

### T5 — builds page ▶ test…
- On passed rows with smoke=ok: a `▶ test` action in the row's actions
  area (currently the ▤ log glyph cell; add the button beside).
- Click → small modal: suite select (preselected = project default; lists
  all suites with their app-bundle match to this build's bundle id —
  mismatched ones disabled with the reason), device select (booted sims;
  default first booted), confirm → POST /test → on success navigate to the
  batch/runs surface (the response's batchId feeds the existing runs view).
- Suite verdict chip: builds row queries per-build suite outcomes — server
  side, `GET /api/builds` response gains `suite: { passed, failed,
  running, total } | null` per row (one GROUP BY over runs by build_id;
  runs with status queued/running count as running; pass = status
  'passed'). UI chip: `48/50` (green/ember per failed>0); hover lists
  failing case names (first 5).
- Run detail build chip: wherever runs render their suite/batch badges
  (runs page row/detail), a `build #N` chip when `run.build_id` — links to
  /builds. (Minimal: runs table row API already returns *; surface in the
  run detail header only, not the list.)

### T6 — tests
- runBatch/playback threading: a run created with buildId carries it (fake
  playback seam, existing test file pattern: playback-seams.test.ts).
- /test endpoint: guards (not-passed, smoke!=ok, missing artifact,
  unspecified suite, empty suite, bundle mismatch), install-first called
  before runBatch (spy), happy path returns runIds + runs carry build_id +
  triggeredBy 'build:#N'.
- builds list suite aggregation: counts correct for mixed pass/fail/running.
- projects PUT defaultSuiteId round-trip.

## Edge cases (handled in-stage)
- Build deleted after runs exist → runs.build_id SET NULL (schema) — run
  detail shows nothing (same as suite today).
- Suite modified between build and test-click → member resolution runs at
  click time; drift skips named in the response (same semantics as play).
- Device unboots between modal open and confirm → installApp fails →
  INSTALL_FAILED, honest, no partial run rows (install happens before
  runBatch).
- Smoke-skipped builds (probe couldn't run): NOT testable (smoke must be
  'ok') — the row keeps ● passed but no ▶ test; tooltip explains. (Design
  decision: unverified-launch apps shouldn't be silently suite-tested —
  matches "two verdicts" honesty.)

## Acceptance / verification

1. `pnpm --filter server typecheck && pnpm --filter server test` — all
   green, new tests included.
2. `cd web && pnpm typecheck && pnpm test` — green.
3. Live drill (real repo, real suite):
   - Ensure ≥1 recorded case exists against the intl bundle id; create a
     suite with it; set it as the project default (editor).
   - Build #21 (or reuse #20) → ▶ test → modal → confirm.
   - Assert: install ran (device has the new binary), runs created with
     build_id = the build, triggeredBy 'build:#20', chip renders N/M,
     run detail shows the build chip.
   - Mismatch drill: point the default suite at a different-bundle suite →
     ▶ test shows it disabled with the reason; force via API → 409
     BUNDLE_MISMATCH.
4. Commit (server+web together — one feature), push, PR comment.

## Rollout

Single PR on feat/project-registry (rides PR #20 like the rest of the CI
round). No data migration beyond additive columns (nullable, backfill
none — absence is the value).
