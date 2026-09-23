# Review — Runs Page Revamp Plan (017-C)

- Plan reviewed: `plans/20260923T091746Z-runs-page-revamp-plan.md` (2026-09-23, Status: Ready)
- Evidence: `server/src/routes/runs.ts:71-137` (read 2026-09-23); runs schema CHECK constraint (observed live: `status IN ('queued','running','passed','failed','aborted')`); `web/src/pages/RunsPage.vue` (current); brainstorm artifact + sketch C.
- **Verdict: Needs revision** — one confirmed High defect (blocked chip is impossible as specified); one Medium spec ambiguity. Both have mechanical corrections; applying them makes the plan Ready. No operator decisions required beyond accepting the corrections.

## Traceability summary

Decisions 1-5 (C variant, everything-default, API in scope, status-filter-exists, data facts) all trace to plan stages and acceptance checks. T2 covers sketch C faithfully; T3 covers gate/drill/vision. Coverage is good — the defect below is a spec error, not a gap.

## Findings

### F1 — HIGH · `blocked` chip cannot work as specified

- **Location:** Plan T2 ("status chips… `?status=` on click"), acceptance "chips set `?status=` and the server filters".
- **Evidence:** `blocked` is a **column** (`runs.blocked = 1`), not a status value. The schema CHECK constraint forbids `status='blocked'` (statuses: queued/running/passed/failed/aborted — confirmed by the live constraint error earlier this session). `?status=blocked` would match zero rows forever. The current page renders `◆ blocked` by checking `r.blocked === 1` *over* the status (RunsPage.vue:106-108).
- **Consequence:** The blocked chip silently shows an empty list; acceptance check would fail at drill time, or worse, get "fixed" client-side with a dishonest count.
- **Correction (mechanical):** T1 adds a `blocked` **pseudo-status** to the existing pseudo mechanism (`status === 'active'` already exists at runs.ts:82-88): `else if (q.status === 'blocked') where.push('blocked = 1')`. Add test: seeded failed+blocked row matches, unblocked failed row doesn't; composes with `before`.
- **Verify:** new vitest case + live drill clicking the blocked chip against the real 3 blocked runs.

### F2 — MEDIUM · `running` chip excludes queued runs

- **Location:** Plan T2 chip list (`… aborted · running`).
- **Evidence:** `running` is an exact status; runs waiting in queue have `status='queued'` and would appear under no chip except `all`. The API already has the `active` pseudo (`running OR queued`, runs.ts:84) built for exactly this.
- **Correction:** Map the running chip to `?status=active` (label can stay `running`, or `active` for honesty). One-line spec change.
- **Verify:** drill with a queued run present (see F4).

### F3 — LOW · drill step understates its prerequisites

- **Location:** Plan T3 ("abort visible on an active run (create via queued play if none)").
- **Evidence:** Creating a real active run needs a booted sim + engine + case — heavy drill machinery for a button check.
- **Correction:** Permit the drill alternative: insert a `running` row directly into the DB (drill residue, cleaned after), or verify abort visibility against any queued row.
- **Verify:** drill notes which path was used.

### F4 — LOW · chip counts shift as history loads (disclose, don't fix)

- **Location:** Plan T2 ("chip counts computed from the loaded window").
- **Consequence:** Counts grow when `load earlier` appends — intentional (honest about what's on screen) but will look like a bug if undocumented.
- **Correction:** Add one sentence to T2 marking this as intended behavior. No code change.

## What was inspected vs. what needs execution

Inspected on paper: requirement traceability, API contract vs. code, data-contract fit (columns the plan renders exist in `SELECT *`), cursor semantics incl. NULL ordering (SQLite DESC puts NULL `started_at` last; cursor excludes them — plan states this), SSE/poll interplay, guards (double-fetch, empty-day, filter+cursor composability). Requires execution: the drill itself (chip filtering, cursor walk, live tick), build/test gate, vision pass — all present in T3.

## Required plan edits before implementation

1. F1: add `blocked` pseudo-status to T1 (+1 test), update T2 chip spec and acceptance check.
2. F2: running chip → `?status=active`.
3. F3/F4: two sentence-level additions (drill fallback; counts-shift disclosure).

Apply these and the plan is Ready for implementation.
