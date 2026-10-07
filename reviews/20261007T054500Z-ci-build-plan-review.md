# Review — CI build plan

- Plan: plans/20261007T054500Z-ci-build-plan.md
- Verdict: **Ready for implementation** (4 findings folded in)

## Findings

- **[H1|High] Generic xcodebuild will fight the intl repo's Scipio cache rules.**
  Its AGENTS.md mandates `-clonedSourcePackagesDirPath/-packageCachePath/-derivedDataPath` + `-disableAutomaticPackageResolution -onlyUsePackageVersionsFromResolvedFile`. The generic path should adopt these CONVENTIONS when present (they're plain env-agnostic flags) — cheap: always pass cache-dir flags pointing inside the clone (`.spm-clones/.spm-cache/.derived-data`) and the resolved-file pins. Not repo-specific; they're safe defaults for any SPM repo. Folded into builds.ts.
- **[M1|Medium] Version extraction for the artifact filename**: read the built .app's Info.plist (plutil, existing readBundleIdentity) — name `<project>-<version>-<number>.ipa`. If version unreadable, `<project>-<number>.ipa`; never block success on naming.
- **[M2|Medium] The repo-lane transport for fastlane needs a bundle check** — `bundle exec` may not exist (no Gemfile in other repos). Detection: only choose fastlane transport when BOTH Fastfile-with-build_sim AND Gemfile exist; scripts/build-sim.sh remains the primary transport.
- **[L1|Low] Log polling**: 2s interval with `log_offset` query param beats re-sending the whole log; page keeps last N lines in DOM. Fold into route design (GET log supports `?from=<bytes>`).

## Verified

- `project.yml` + xcodegen at `~/.local/bin/xcodegen` (in PATH check).
- Fastfile lane syntax (`lane :build_sim do`) grep-able; scripts/ dir exists in repo.
- No process manager in server today — spawn + in-memory queue + DB rows is the right scale (matches how the app runs playback lanes).
- `server/artifacts/` exists as writable scratch (builds get their own subdir).

## Residual

First real build duration (SPM resolve) — mitigated by serial per-project queue + poll UI; if the live drill exceeds session budget, fixture-repo drill + honest note (plan's fallback).
