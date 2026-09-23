# Review — Run Detail Revamp Plan

- Plan reviewed: `plans/20260923T104943Z-run-detail-revamp-plan.md` (2026-09-23, Status: Ready)
- Evidence: `web/src/pages/RunDetailPage.vue` (164 lines, read in full); brainstorm artifact + decisions; live DB facts (steps avg 2.1, ac_results 0, evidence 2.5%); `web/src/components/TriagePanel.vue` / `EvidenceSheet.vue` existence.
- **Verdict: Ready for implementation** — two Medium findings corrected in-plan (F1 spec gap, F2 data check); no operator decisions required.

## Traceability

All three user decisions (verdict block, auto-collapse, direction A) trace to T1 items and acceptance checks. Scope correctly excludes AC/evidence surfaces (data-contradicted). No invented requirements — the "re-run case" action is a link, not a new API (verified: `/templates?case=` deep-link pattern already exists from the runs page).

## Findings

### F1 — MEDIUM · `re-run case` is one click short of actually re-running

- **Location:** T1 item 5 ("re-run case → link to /templates?case=<id>").
- **Evidence:** the deep-link opens the case editor focused on the case; the user still clicks play there. There IS a play API (`POST /api/templates/:id/play` used by test-cases page) but wiring a one-click re-run means device/scenario selection semantics the plan never specified — scope creep for this pass.
- **Resolution (applied):** plan wording now says the action **navigates to the case with intent to re-run** (label `open case` + a second `re-run →` that deep-links with the play intent visible). No new API; honest about being a navigation. If a true one-click re-run is wanted later, it's its own brainstorm (device/scenario defaults).
- **Verify:** drill clicks the link and lands on the right case.

### F2 — MEDIUM · duration chip needs a NULL-safe definition

- **Location:** T1 item 2 (duration chip).
- **Evidence:** `finished_at` is NULL while running (and for orphan rows forever); the runs-log page solved this with live-tick + `—`. Plan said "live-tick while running" but not the orphan/NULL terminal case.
- **Resolution (applied):** duration = live-tick while running; `—` when terminal with NULL finished_at.
- **Verify:** drill includes a running or NULL-duration row if one exists; otherwise visual check that `—` renders (can synthesize by inspecting code path).

### F3 — LOW · attach badge placement during pending state

- **Evidence:** `attachMsg` currently renders in the header; plan moves the button to the verdict block but didn't say where the result badge goes.
- **Resolution (applied):** result renders inline next to the button in the verdict block.
- **Verify:** drill clicks attach (or observes the badge state) — visible in place.

## What was inspected vs. execution-required

Inspected: decision traceability, no-API-change claim (all rendered fields verified present in `/api/runs/:id` + steps + traffic responses), collapse thresholds vs. data (≤3 covers the 2.1 avg), SSE interplay (existing watcher untouched), fallback chain for the cause sentence (steps → note → status), link patterns (case deep-link exists). Execution-required: the drill (verdict content per row type, chips linking, collapse behavior, vision pass) — present in T2.
