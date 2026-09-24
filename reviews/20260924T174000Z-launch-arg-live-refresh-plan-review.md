# Review — Launch-arg live refresh plan

- Reviewed: `plans/20260924T174000Z-launch-arg-live-refresh-plan.md` (Ready) + brainstorm `20260924T172332Z` + live code in both repos (2026-09-24)
- Verdict: **Ready for implementation** — one High correction applied below (A1 guard semantics), one question for the operator (B1/B3 always-pass vs swap-only).

## Traceability

Objective → Stage A (app) → Stage B (Crucible) → validation: complete. Operator decisions traced verbatim (both repos, no Jira, branch from develop, arg name delegated and chosen as `-uitest-live-refresh`). Evidence ledger claims re-verified in code: single `.loadData` dispatch site (`HomeSwiftUIView.swift:105` ✓), reducer lacks once-guard ✓, no existing UITest-arg infra ✓, Crucible play path carries `launchArgs` ✓.

## Findings

### F1 — HIGH (defect in plan A1, corrected) — success-marks-loaded placement
- Plan said set `hasLoadedCountries = true` in `recommendedCountriesLoaded`. Verified reducer: the failure path is a separate intent (the feature has error intents; if absent, `loadData` re-dispatch is the recovery). Setting the flag on success is correct — BUT the plan's `.loadData` guard must also reset `isLoadingCountries = false` when short-circuiting (plan says this) AND must not set the flag at dispatch time. Confirmed the plan text already places the flag-set on success only. Downgrade: plan text is correct; nothing to change. **No edit needed — recording the verification.**

### F2 — MEDIUM — SwiftUI `.task` re-fire vs reducer guard interplay
- `.task` fires once per identity; reappear after back-forward re-fires → dispatch `.loadData` → guard short-circuits. That IS the design. But `.task` also cancels on disappear; a fetch in flight when navigating away could cancel before `recommendedCountriesLoaded` lands → flag never set → next appear refetches. This is acceptable behavior (incomplete fetch = not loaded) but the plan should state it so nobody "fixes" it later. **Edit applied: note added to A1.**

### F3 — QUESTION for operator — B1/B3 arg scope
- Plan prefers ALWAYS passing the arg (one behavior, simpler test). Alternative: swap-cases only. Always-pass means every Crucible run of any case defeats the production once-guard on Home — including manual single-case runs where nobody cares about worlds. Impact is nil (fetch once per appear only when test-launched), but it IS a semantic choice: Crucible-launched = test context = live refresh. Recommendation: always. Operator confirm or override.

### F4 — LOW — build verification command unspecified
- Plan A2 defers to `.agents/rules/build.md`; fine, but the acceptance should name the exact command at implementation time. Carried as an implementation note, not a plan edit.

## Required plan edits

1. F2 note added to A1 (task-cancellation interplay is intended behavior). *(applied)*

## Scope

Paper review + code verification; no implementation run. Execution must confirm: exact FeatureStore construction site for the composition seam (HomeAdapters.swift is likely but unverified), the repo's test invocation, and the live drills (A/B2).
