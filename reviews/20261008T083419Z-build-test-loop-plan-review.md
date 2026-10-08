# Review — build→test loop plan

- Plan: plans/20261008T083419Z-build-test-loop-plan.md
- Verdict: **Ready for implementation** (4 findings folded in)

## Findings

- **[R1|High] Member-resolution duplication.** Plan says extract the
  suite-play endpoint's ~40-line member filter into a helper. Verified the
  block (routes/manual.ts:985-1016): it closes over `db` + suite row only —
  cleanly extractable. Fold in: new `resolveSuiteMembers(db, suiteRow)` in
  routes/manual.ts (not a new file — the endpoint and the helper share the
  reply-code semantics), both callers use it. Watch: the ghost-pin mutation
  of `m.variantIds` is intentional (partial survivors) — preserve.
- **[R2|High] installApp contract.** Plan calls `installApp` with the
  artifact path — verified signature (manual/app-install.ts:19): it takes
  `appPath` (an .app path, not .ipa) + identity. The smoke gate installs
  the .ipa via raw `simctl install`; app-install.ts is the RECORDED-artifact
  installer with in-flight dedupe + catalog rows. For build artifacts use
  `simctl install` directly (like smoke) BUT record into app_catalog via
  installApp's catalog write, or simpler: reuse `installApp` after staging
  the .app out of the ipa? **Decision: use raw simctl install (ipa installs
  fine) + a catalog insert mirroring installApp's — do NOT route through
  installApp (it expects .app). Keep the dedupe guard: if an install of the
  same path is in flight, 409.**
- **[R3|Med] runs list API surface.** T5's run-detail build chip needs
  `build_id` in whatever the runs page reads. Verify which route serves run
  detail rows (likely /api/runs or /api/manual/:id) and add the column to
  its projection during T5 — not just playback's INSERT.
- **[R4|Low] triggeredBy format.** 'build:#20' embeds the number —
  derivable from build_id, so it's display sugar only; fine, but document
  in the plan that the SOURCE OF TRUTH is runs.build_id, triggeredBy is
  human-readable provenance (never parsed).
- **[R5|Med] Suite aggregation counts 'queued' too.** runs.status values
  include 'queued' (pool pre-start). The GROUP BY must count
  queued+running as running. Folded into T5 spec.

## Verdict

All foldable in-stage; structure sound. The Q2 (manual-only) scope cut
removes the scheduler risk entirely. Proceed T1→T6.
