# Runs Page Revamp — Evidence-Based Direction

- Source prompt: "/design-evidence-based-ux — I want to revamp the 'runs' page. Give me the right direction"
- Created: 2026-09-23T09:17:46Z
- Status: Direction selected — grouped log (A), everything-on-load default (B); sketching next

## Decisions (user-confirmed)
1. **API work in scope** — `/api/runs` gains a `before` cursor + status filter.
2. **Default = B (everything)** — all runs on load; chips filter down to failed/blocked/aborted/running. Nothing hidden by default.

## Goal and context

The runs page is Crucible's history surface: 50 rows, poll + SSE refresh, click → run detail. The user wants a revamp with the *right direction*, grounded in evidence rather than a wish list.

**Interpretation (not user-confirmed):** the goal is a page that answers real questions faster — "did my latest run pass?", "why did it fail?", "where is that run from Tuesday?" — not visual restyling for its own sake.

## Confirmed inputs and decisions (verified against the live DB and code)

- **All 724 runs are `kind='manual'`** — the kind column is pure noise (verified: `GROUP BY kind` returns one row).
- **501 passed / 136 failed / 87 aborted** — 69% of the wall is green rows nobody reads.
- **Only 2 distinct ticket keys** (`-` and `MANUAL`) — the ticket column is dead weight today.
- **The failure signature is degenerate:** 3 of the top recent failures are the *same string* ("blocked by system dialog: Allow Lion Parcel to use your location?"). Failures repeat verbatim; nobody has grouped them.
- **Average run = 212s; max = 24,513s (6.8h!)** — the table never shows duration, so a hung run is invisible until you open it.
- **`evidence` averages 0.0 per run** (max 2) — rows are *thinner* than they look; the page cannot lean on evidence thumbnails.
- **The API ships `limit=50` with no filtering at all** — no status/kind/case/device/date filter, no pagination, no search. 39 runs match "maps" in note/id — none findable from the UI.
- Row content already carries: variant chip (`▸ sg`), revision breadcrumb (`r3 ⚠` stale chips), blocked diamond, abort button for running rows.
- Existing pages already own the aggregate views: **Overview** (verdict, attention) and **TestCases** (per-case trend). The runs page's unique job = *the log*.

## Exploration

### Option A — Grouped log ("day cards") ✅ PROPOSED

Collapse the flat 50 into day sections (`today · 40 runs · 22✓ 16✕ 2◆`), each a compact table.

- **Wins:** matches how people query history (by day); kills the dead columns (kind, ticket) at the same time; failure bursts (3× same dialog block) become one visual cluster instead of 3 identical rows; a day summary row is a natural home for duration anomalies (`max 6.8h ⚠`).
- **Costs:** needs a `before` cursor or date param on `/api/runs` (server work); "load earlier" pagination pattern.

### Option B — Filterable flat table

Keep the flat table; add chip filters (status/case/device) + search + duration column.

- **Wins:** cheapest to build; directly fixes findability (the 39 "maps" runs); duration column is pure win.
- **Costs:** doesn't fix the scan problem — 50 rows is still 50 rows; filters are invisible until used (evidence: nobody asked for the existing `?suite=` filter); the page stays a wall of green.

### Option C — Run cards with evidence previews

Rich cards (screenshot/video thumbnails, step sparkline).

- **Rejected (hypothesis, data-contradicted):** evidence per run averages **0.0** — the page has no material to build cards from. Would render as empty boxes.

### Shared moves (any option)

- Drop **kind** and **ticket** columns (dead per data); keep ticket link only when a real key exists.
- Add **duration** (missing, catches the 6.8h hung run).
- Keep live SSE behavior; day grouping composes fine with it.
- Failure *signature grouping* (N× same note) is a stretch goal — Overview's attention list already carries the triage role; don't duplicate it here.

## Open questions

1. **Scope of server changes** — Option A needs cursor/date params on `/api/runs`. OK to touch the API, or web-only this round? (Materially changes the shape of the work.)
2. **Should the default view filter to failed+blocked+running** with a one-click "all" toggle, or always show everything? (69% passed noise argues for filtering by default; hiding green by default can feel dishonest.)

## Next step

Pick A / B / hybrid (A's day sections + B's status chips), answer the two open questions, then **sketch 2–3 variants** per the house sketch-before-code rule before any implementation.
