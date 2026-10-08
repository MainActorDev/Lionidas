# Review — Phase 2 hygiene plan

- Plan: plans/20261008T103310Z-phase2-hygiene-plan.md
- Verdict: **Ready for implementation** (3 findings folded in)

## Findings

- **[R1|High] runCommand env threading scope.** The plan says pass env to
  prepare/xcbuddy/xcodebuild children — verify runCommand's current
  spawn call passes NO env (inherits) and that adding `env: { ...process.
  env, … }` does not drop PATH-dependent behavior in tests (fake shims
  rely on PATH). Fold: spread process.env FIRST, then the two vars —
  never a bare env object. Also thread through `smoke.ts`'s simctl calls?
  NOT needed (probe doesn't stamp) — leave smoke untouched.
- **[R2|Med] T1 boot-time GC ordering.** Boot GC before the server
  listens could delay startup on a big packages dir (file deletes are
  fast; fine) — but it must not run before migrations on a FRESH DB
  (tables missing → SQL error in boot path). Fold: run after
  migrateM1 + registerRoutes, wrapped in try/catch with a log line;
  failure never blocks boot.
- **[R3|Med] T3 Jira survey risk.** "Survey Jira token usage in
  implementation" is an open door for scope creep — if the Jira connector
  reads its token from a config/store today with no env fallback seam,
  wire ONLY the fallback where the read happens; if that read is spread
  across files, defer the Jira half to a named follow-up rather than
  refactoring auth plumbing in this PR. The env name reservation (status
  mirror shows it) ships regardless.
- **[R4|Low] Retention editor validation.** PUT accepts retention as
  number ≥ 0 or null; reject negatives with 422 (one line).

## Verdict

Three independent, well-bounded stages; scheduler removal honored (no
dead config). The stamping-via-prepare route avoids the app-repo coupling
except one additive commit to the already-open PR #413. Proceed T1→T3.
