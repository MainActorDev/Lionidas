# Review — Phase 4 Factory overview migration plan

- Plan reviewed: `plans/20261015T145321Z-phase4-overview-factory-migration-plan.md` (Ready draft, 2026-10-15)
- Evidence: updated brainstorm (pick A + 5-run cap); sketch `a-band-verdict` (drilled + vision-passed at 1440/375); `web/src/pages/OverviewPage.vue` source (read in full this session); e2e `routes.ts` (`/` already routed, `OVERVIEW` fixture ships 2 latestRuns); no existing OverviewPage tests (verified by search).
- Verdict: **Ready for implementation** after two corrections below (both applied during this review). One Medium finding disclosed.

## Traceability

- User pick **A** → band verdict grammar (Task 1 reuses `/status` band shapes for cross-page consistency). 5-run cap → `latestTop` slice + comment + fixture ≥6 runs so the cap is exercised. Shell/data/actions explicitly preserved; only template + scoped styles + the one slice constant change.
- Factory rules carried: mono numbers, hairlines, carbon hovers, status-only orange/green, no shadows, ≤500 weight — all present in the picked sketch and restated in Task 1.
- Verification matches the house gate: web check green, baselines regenerated in-commit, vision pass both themes, mobile drill.

## Findings

- **C1 · Corrected — fixture must exercise the cap.** The plan's first draft said "fixture must ship >5" but the current `OVERVIEW` fixture ships 2 runs; the corrected plan makes extending it to 6 part of Task 3, and the unit test pins the cap with a 7-run fixture. Verify: `routes.ts` fixture length ≥6 after implementation.
- **C2 · Corrected — `timeAgo` vs frozen clock.** Latest-runs rows render "2h ago" from `Date.now()`; the e2e already fixes time at ANCHOR, so regenerated baselines stay deterministic — but the NEW unit tests must not assert exact ago-strings (they'd rot); assert structure (row count, names, status classes) instead. Plan's test task now says so.
- **M1 · Medium, disclosed — verdict word color semantics.** A uses the dot as the state carrier with the word mostly bone; the current page colors the word itself (`running` → ember). Task 1 keeps the existing mapping (dot + word color for running) — a slight divergence from `/status`, which colors only the dot. Accepted for now: `/` is the front door and `running` deserves the louder word. Non-blocking; note in the PR.

## Limits

Sketch data is representative, not live. No production code has run; the plan's checks (unit tests, check green, reviewed baselines, vision pass) are the acceptance evidence. Full server suite untouched (no server change).
