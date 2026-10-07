# Green-but-dead builds: sim config, toolchain guards, and the smoke gate

- Source prompt: "I tried to run the app installed from the build artifact, the app is crashed. please do it right. think of everything" (after accepting the smoke-probe + PR #413 v2 proposal)
- Created: 2026-10-08T00:45:00Z
- Status: Direction selected (execute)

## Goal and context

Build #18 was green but the app crashes on launch. The user demands the
class of failure be eliminated, not just this instance: "think of
everything". Two deliverables: (1) app-repo PR #413 v2 that produces a
LIVE simulator build from a cold clone, (2) a Lionidas-side durable gate
that no dead app can ever read as "passed" again.

## Confirmed evidence (all reproduced/verified this session)

1. **Crash**: `simctl launch --console-pty` on the #18 artifact →
   `AppConfiguration.swift:10: Fatal error: API_BASE_URL is missing or
   malformed in Info.plist.` The app validates URL shape at first access;
   the stripped-config build ships `""`.
2. **The husk mechanism**: `project.yml` configFiles → secret `.xcconfig`
   never committed → prepare strips them → all env keys empty → fatalError.
3. **The fix already exists in the repo**: `App/Config/Environments/
   StagingAutomationConfig.xcconfig` (authored 2023 by the team, named for
   automation) — STAGING compilation conditions + real staging base URLs +
   client third-party keys. It is (a) gitignored by the blanket `*.xcconfig`
   rule added in commit 3c781196, (b) NOT referenced in project.yml, (c)
   present on this machine only. CI was never wired to it.
4. Client keys in a staging xcconfig are already shipped inside every
   distributed staging IPA (extractable from the binary) — they are not
   server secrets; committing an automation config is the team's own stated
   intent (the file's name).
5. Toolchain law (repo AGENTS.md): XCFrameworks are Xcode-version-bound;
   `xcode-select -p` must be checked and `make scipio` re-run when Xcode
   changes. prepare-sim.sh does neither.
6. `bootstrap.sh` installs mint/xcodegen; prepare assumes them (worked only
   because this machine was warm).
7. `CFBundleVersion` is a stale literal (20250515) — builds are
   indistinguishable to crash tooling (cosmetic; only if Info.plist uses
   $(CURRENT_PROJECT_VERSION) — verify, else defer).
8. Lionidas is already a sim orchestrator (installs apps, boots devices) —
   the smoke gate is native capability, not new surface.

## Exploration — the full gap inventory and the design

### App repo (PR #413 v2, branch lionidas-build-manifest-lioclaw)

- **Commit `App/Config/Environments/StagingAutomationConfig.xcconfig`** as
  the CI sim config (team-authored, staging-safe, keys already public-by-
  distribution; PR body states the rationale — reviewer veto is the gate).
- **prepare-sim.sh v2** — ordered, each step guarded, named failures:
  1. Prereq check: ruby, xcodegen, make, (mint for scipio) — missing →
     exit 2 with the exact bootstrap.sh pointer.
  2. Toolchain guard: hash `xcodebuild -version`; stamp file
     `.scipio-toolchain-stamp`; mismatch or missing XCFrameworks →
     `make scipio`; match + populated → skip (fast warm path).
  3. Config wiring: if `DevelopmentConfig.xcconfig` exists (dev machine)
     → leave spec untouched; else rewrite configFiles →
     StagingAutomationConfig (fallback: strip, as today, but PRINT that the
     build will be config-less).
  4. Spec surgery + xcodegen (as today).
  5. SPM resolve (as today).
- Idempotent, no fastlane/bundler, `sh`-portable.

### Lionidas (this repo)

- **Smoke gate** (the durable fix): after a passed simulator build —
  1. Find a booted sim; none → boot the first available iPhone sim.
  2. Install the artifact (`simctl install`), launch (`simctl launch`),
     wait 10s, verify the process is still alive.
  3. Dead → pull the crash report (DiagnosticReports), extract the fatal
     line into the build error + log; build marked `failed` with
     `SMOKE_CRASH` (a build whose app dies on launch is NOT a pass).
  4. Alive → `smoke=ok` on the row (glyph in UI); terminate the app.
  - Timeout-bounded (60s), never blocks >1 sim, failure of the probe
    itself (no sim available) → `smoke=skipped` + log line, build stays
    passed (probe infra failure ≠ app failure — honest distinction).
- builds table += `smoke TEXT` ('ok'|'crash'|'skipped'|null) + UI glyph.
- Env contract: engine exports `LIONIDAS_BUILD_NUMBER` to prepare/build
  steps (future stamping; documented now).

## Decisions (taken, rationale recorded)

- Commit the automation xcconfig (evidence #4; team's own intent; PR review
  is the veto gate).
- Crash on launch ⇒ build = failed (not "passed with warning") — the whole
  point of the gate.
- Probe-infra failure ⇒ skipped, build verdict unchanged (never fail the
  build because the probe couldn't run).
- Stamping deferred unless Info.plist already uses $(CURRENT_PROJECT_VERSION).

## Open questions

None blocking execution. (Staging-scheme LPClaim compile bug remains a
separate known issue, not in scope.)
