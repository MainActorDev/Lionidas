# Run Detail Page Revamp — Verdict-First Report

- Source brainstorm: `brainstorm/20260923T104943Z-run-detail-revamp.md` (+ Decisions section)
- Created: 2026-09-23
- Status: **Ready** (post-review F1-F3 applied — see `reviews/20260923T104943Z-run-detail-revamp-plan-review.md`)

## Decision log (provenance)

| # | Decision | Source |
|---|---|---|
| 1 | Direction: **verdict-first report** (brainstorm Option A) | Brainstorm, accepted by user follow-ups |
| 2 | Failure cause = **hero sentence in a verdict block** at top | User: "verdict block if that make sense" (2026-09-23) |
| 3 | **Auto-collapse** trivial sections (steps ≤3, no network traffic) with counts on toggle | User: "yes" (2026-09-23) |
| 4 | Verified page/code facts: current 164-line `RunDetailPage.vue` structure; steps avg 2.1/run (max 9, kind='step' only); ac_results empty; evidence ~2.5% of runs; `note` doubles as case label (`template:<id> <name>`); TriagePanel + EvidenceSheet components exist; SSE live-append exists | code read + live DB queries (2026-09-23) |

## Objective

`/runs/:id` answers "did the app break or the environment, and what do I do next" in ~3 seconds: verdict block first, context as chips, deep detail one click down. Done = all acceptance checks below pass against the real DB, gate green.

## In / out of scope

**In:** RunDetailPage.vue body reorganization (verdict block, context chips, case link, duration, collapsible steps/network); no API changes (all fields already ship); TriagePanel/EvidenceSheet kept as-is; SSE behavior kept.

**Out:** AC surface (0 rows in DB — nothing to render); evidence redesign (2.5% coverage); runs-log page changes; API/Jira changes.

## Stage T1 — page restructure (single web task)

Replace the meta card + blocked callout + always-open tables with:

1. **Verdict block** (hero): status symbol + word (passed/failed/aborted/blocked/running — `blocked` from the column like everywhere else), then the cause sentence:
   - failed/aborted: first failed/aborted step's `reason`, falling back to `run.note` when steps carry nothing (the blocked-by-dialog case).
   - blocked: dashed ember card content (existing copy) promoted into the block.
   - passed: case name line instead of a cause.
   - running: live "step N running…" from SSE.
2. **Context chips row** under the verdict: case name → link `/templates?case=<template_id>` (name from `note` parse — same helper as runs log); device (8-char); build; duration (finished−started; live-tick while running; `—` when terminal with NULL finished_at — review F2); by; started time. Ticket link only when a real key exists (`-`/`MANUAL` suppressed).
3. **Steps disclosure** `steps · N` — collapsed when N ≤ 3, expanded otherwise; same table inside (evaluated sub-lines kept).
4. **Network disclosure** `network · N` — collapsed when 0 rows (with the existing proxy-wasn't-running teach-line inside), expanded when traffic exists.
5. **Next-actions row** in the verdict block (contextual): `open case →` (when template_id; navigates to the case — re-running happens there), `attach → jira` (moved here from header; result badge renders inline next to the button — review F3), `back to log →` (`/runs`).
   *Review F1: no one-click re-run in this pass — play semantics (device/scenario) are their own future brainstorm.*
6. Header keeps title `run.id` + status; desc drops ticket/kind (now chips) and gains nothing (duration is a chip).
7. Dead scaffolding removed: meta card rows (device/build/artifact/freshness/launch args) collapse into chips; artifact hash + freshness + launch args move into a small `raw` disclosure at the bottom (diagnostic, rarely read — kept, not deleted).

## Stage T2 — verify + ship

1. Gate: `pnpm run check` + `pnpm run build` green (no new server tests — no API change; web has no unit harness, live drill is the check).
2. Live drill on real DB rows: a blocked-by-dialog run (verdict block shows the sentence, dashed ember), a passed intl-drill run (case name hero, chips link to case), a run with traffic (network expanded), steps ≤3 collapsed with count, `open case`/`attach` present, no horizontal scroll 1280–1920.
3. Vision pass on a screenshot of the two contrasting rows.
4. Single commit; servers stay up (user's standing request).

## Edge cases

- Steps empty entirely (orphan run) → steps disclosure hidden, verdict falls back to note.
- `note` absent → cause line falls back through: step reason → note → status word alone.
- Running run → verdict live-updates via SSE (existing watcher); duration chip ticks.
- template-less manual run → no case chip, no open-case action.
- Very long reason → clamp to 2 lines with ellipsis + title tooltip.

## Acceptance checks

- [ ] Verdict block renders cause sentence for failed/blocked/aborted; case name for passed; live step indicator for running.
- [ ] Context chips: case (linked), device, build, duration, by, started; ticket suppressed for `-`/`MANUAL`.
- [ ] Steps section collapsed (with count) when ≤3 rows; network collapsed when 0 rows with teach-line inside.
- [ ] open case / attach → jira / re-run actions present and wired.
- [ ] raw disclosure carries artifact hash, freshness, launch args.
- [ ] Gate green; live drill + vision pass; committed.
