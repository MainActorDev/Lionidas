# CI in-project: build the simulator .ipa from the workspace clone

- Source prompt: "Brainstorm first" — for the CI round (produce the simulator .ipa/.apk from registered projects; the packages + registry + clone work all led here)
- Created: 2026-10-07T05:23:03Z
- Status: Exploring — questions open

## Goal and context

Close the loop: a registered project's clone (already at
`server/repos/<name>`) gets built into a **simulator** `.ipa` that lands in
`server/packages/` with the project claim attached — then it appears in the
install picker, installable and runnable (the SIM_PACKAGE_REQUIRED guard
already enforces simulator builds). "CI" here means Lionidas-driven builds on
this machine (an in-project pipeline), not GitHub-Actions-hosted runners.

## Confirmed inputs and decisions (verified in the repos)

- The intl repo is cloned at `server/repos/ios-consumer-intl` (develop@912846d).
- It ALREADY has the machinery (verified by reading `fastlane/Fastfile`):
  - `lane :build` — full pipeline: xcodegen project generation (SPM fallback
    when XCFrameworks absent), Scipio-aware cache paths, badge, build-number,
    Match signing, gym → `<repo>/build/<config>.ipa`.
  - `generate_project`, `ensure_cached_package_resolution`, simulator device
    resolution lanes; workflows `feature-system-lint.yml`, `ios-tests-macos.yml`
    exist (GH-hosted CI).
  - Scheme `LionParcelLogisticsINTL`; project generated from `project.yml`
    (xcodegen present at `~/.local/bin/xcodegen`).
- Standing decision (registry Q5): **pipelines live in the repo** — Lionidas
  runs what the repo declares; it does not own build config.
- Standing constraint: packages must be `-sdk iphonesimulator` builds
  (SIM_PACKAGE_REQUIRED guard) — the fastlane `build` lane today produces a
  SIGNED DEVICE .ipa via gym + Match. A device ipa is exactly what the guard
  rejects.
- Packages dir + claims + picker all shipped (PR #19/#20 lineage).

## Exploration

**The core mismatch:** the repo's existing `fastlane build` makes
device/store ipas (Match-signed, gym export). Simulator ipas are differently
produced: `xcodebuild -sdk iphonesimulator -configuration Debug build` →
zip `Payload/` around the `.app`. So Lionidas cannot just call `lane :build`.

**Options for the build definition (where "in the repo" gets concrete):**

- **Option A — new fastlane lane in the app repo** (`lane :build_sim`):
  reuses generate_project + cache lanes, skips Match/keychain entirely,
  builds the sim slice, zips `Payload/`. Lionidas runs
  `bundle exec fastlane build_sim` in the clone. Most "pipelines live in the
  repo"; needs a PR to the app repo (branch naming hook demands `-lioclaw`
  suffix; signing untouched).
- **Option B — Lionidas-side build script per project** (server runs
  xcodegen + xcodebuild + zip itself, honoring the repo's cache-path
  conventions from AGENTS.md): zero app-repo changes; but Lionidas now OWNS
  build config — drifts from the Q5 decision, and every project needs
  Lionidas-side config (scheme name discovery).
- **Option C — hybrid**: Lionidas checks for `fastlane build_sim` (or a
  marker like `scripts/build-sim.sh`) in the clone and runs it; if absent,
  falls back to a generic `xcodebuild -scheme <auto> -sdk iphonesimulator`
  best-effort path. Repo-declared when available, works before the app repo
  PR lands.

**Recommendation: C.** A is the end state but blocks on an app-repo PR;
B contradicts Q5; C starts useful today (generic path) and converges to A
the moment `build_sim` exists — Lionidas prefers the repo's own lane.

**Where it runs (execution model):**

- Build is long (first SPM resolve can be 10+ min). Options: (1) synchronous
  route with a long timeout (bad — HTTP timeouts); (2) **job model**: POST
  starts a job (row + status), UI polls/streams progress, artifact lands in
  packages with claim attached. The job model fits the existing patterns
  (runs have exactly this shape) and supports later queueing.
- Pull-before-build toggle (clone exists → `pull` first).

**Attribution:** on success, write the ipa to
`packages/<project>-<version>-<build>.ipa` and auto-claim it to the project
(claimPackage). Picker then shows it under the project group.

**Scope boundary:** Android/.apk stays out (APK_UNSUPPORTED already honest).
Trigger for v1: a **build** button on the projects page row (admin), not a
scheduler.

## Decisions

- **Q2 (user, 2026-10-07)**: scheme/configuration **auto-discovered** via
  `xcodebuild -list` (no per-project build fields; override can come later if
  discovery ever picks wrong).
- **Q3 (user, 2026-10-07)**: builds surface on a **new page**, sketch round
  first; **"follow Jenkins style if it is not a big ask"** — Jenkins
  conventions: job list with status ball (● success / ✕ fail / spinner
  running), build number column, duration, last-run-per-job view, console
  log. Fits the house style (status pills already speak this language).
- **Q1 (user, 2026-10-07)**: **C** — prefer the repo-declared build lane
  (`fastlane build_sim` or `scripts/build-sim.sh`) when present in the clone;
  otherwise the generic Lionidas fallback (xcodegen if project.yml,
  auto-discovered scheme, `xcodebuild -sdk iphonesimulator`, zip Payload/).
  The `build_sim` lane in the app repo is a follow-up, not a blocker.

## Open questions

None — all three answered. Ready for plan → sketch (Jenkins-style builds
page) → build.

## Next step

Answers to 1–3 → plan → build on `feat/project-registry` (or its own branch
post-merge) → live drill: build the actual intl repo → simulator ipa in
packages, claimed, installable on a booted sim through the picker.
