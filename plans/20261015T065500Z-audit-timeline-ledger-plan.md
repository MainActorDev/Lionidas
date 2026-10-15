# Audit timeline ledger — Implementation Plan

> **For Hermes:** implement task-by-task with build/test verification between each. Accessibility acceptance is part of "done".

**Goal:** Rebuild `/audit` as the round-037 variant-A **timeline ledger** (user-approved): day-grouped dense rows, facet rail, server-side search, numbered pagination, detail-on-click Sheet. Server contract gains `q=` search and page-based pagination.

**Source brainstorm:** `brainstorm/20261015T065500Z-audit-timeline-ledger.md` (status: Direction selected; user answered all three gates 2026-10-15).

**Decision log (user, 2026-10-15, verbatim-faithful):**
1. Server-side search — "Yes — add q= to /api/audit"
2. Facet counts — "Client-side, from loaded rows, labeled 'in view'"
3. Pagination — "Add numbering pagination instead of load more."

**Architecture:** The page keeps its RBAC identity and supervisor+ gating. Rows render as a custom ledger (hand-rolled grid, `role="list"`), NOT the shadcn Table — columns are fixed-width grids with sticky day headers, which tables handle poorly. Facet rail = shadcn Button/Badge building blocks; detail = the generated Sheet. Server: `auditList` swaps cursor (`before`) for offset pagination (`page`) and gains `q` (LIKE over email/event/detail). Web is the only `/api/audit` consumer (verified: no other fetch sites; server tests assert only RBAC status codes at `server/test/rbac-boundaries.test.ts:184-186`).

---

## Task 1 — Server: q= search + numbered pagination

**Files:** `server/src/auth/audit.ts`, `server/src/routes/runs.ts` (handler at :113), `server/test/audit-api.test.ts` (new).

1. `auditList(db, { actor?, event?, q?, page?, limit? })`:
   - `q`: `WHERE (email LIKE ? OR event LIKE ? OR detail LIKE ?)` with `%q%` ×3.
   - `page`: `SELECT … ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`; `page` is 1-based, default 1; `limit` clamped 1–200 (default 50) as today.
   - Response: `{ events, total, page, pageCount }` where `total` = `COUNT(*)` under the same WHERE; `pageCount = ceil(total/limit)`.
   - Remove `before` (only consumer is the web page being rebuilt in Task 2).
   - NO `events` list param (review H1: not operator-approved; class filtering stays client-side).
2. Route schema in `runs.ts:113`: add `q`, `page` querystring params (string, optional) alongside existing.
3. Tests (new file, sqlite in-memory like siblings): q matches email/event/detail; combined actor+event+q; page 2 offset correctness; pageCount math; empty result → `total:0, pageCount:0`; limit clamp. RBAC tests at rbac-boundaries.test.ts:184-186 must stay green untouched.
4. Verify: `pnpm --filter server test -- audit` green; no regressions in rbac-boundaries.

## Task 2 — Web: ledger rebuild

**Files:** `web/src/pages/AuditPage.vue` (template+styles rebuilt; script adapted for page-based fetch), `web/src/components/ui/sheet/*` (generated, reused).

1. **Layout** (matches the approved sketch, incl. the 12px padding fix):
   - Facet rail left (sticky; hidden ≤900px → replaced by event-class Select in toolbar).
   - Toolbar: search Input (bound to `q`, Enter applies) + day/continuous toggle (Segmented behavior via two Buttons or a small custom seg).
   - Ledger: sticky day headers (weekday, d MMM + per-day count) + dense rows `64px | 200px | 150px | 1fr` (time | actor | event | detail), 12px horizontal inset, full-bleed hover, hairline row borders.
   - Event class shown as mono text + 5px status dot (ash=auth, green=runs, orange=rbac) — text is the non-color redundancy.
   - Footer: numbered pagination (prev/next + page numbers with ellipsis for large counts, mono) fed by `pageCount`.
2. **Facets** = client-side counts from loaded rows, labeled "in view". Facet click filters the loaded window client-side (same fidelity as the counts — they are a pair; review H1 removed the `events` server param as unapproved). Server filters stay: `q`, `actor`, `event`, `page`.
3. **Detail Sheet**: row focusable (`tabindex=0`, Enter/click) → Sheet (right on desktop, bottom/full on mobile) with full record (at full precision, email, user_id, event, detail, class) + raw JSON block. Esc closes (reka). Focus returns to row on close.
4. **States**: loading (row-height skeleton strip ×8), error (role-aware 403 text, as today), empty (per current filters), pagination boundary (page 1 clamp).
5. **Script**: `fetchPage(page)` replaces `load(reset)`; URLSearchParams gains `q`, `page`; cursor `before` removed. Keep 403 → "supervisor role required" mapping.

## Task 3 — Accessibility + verification drill

1. axe-core (already a devDep) on /audit: dark 375+1440, sheet open, light — 0 critical/serious. Ledger rows keyboard-navigable; sticky day headers not focus traps.
2. Contrast: ledger reuses theme vars only (no new hexes except sketch's rgba row borders — verify ≥3:1 non-text or drop to var(--border)).
3. Browser drill: search applies server-side (stubbed q echo), facet click refetches, pagination navigates, detail Sheet opens/closes with focus return, day grouping correct across page boundary (day group may repeat at page seam — merge identical adjacent day headers).
4. Screenshot diff vs the approved sketch composition (spot-check, not pixel gate — this IS a redesign).
5. Gates: `pnpm --filter web build` + `lint` 0 + tests; `pnpm --filter server test -- audit`; update `plans/…phase2…plan.md` Task-5 gate note (layout superseded by round 037).

## Task 4 — Docs + handoff

Update sketch README (037) with "A implemented" note; this plan's Results section; report for user sign-off (Task 5 gate).

---

## Acceptance criteria

- `/api/audit` supports `q`, `page`, returns `{events,total,page,pageCount}`; RBAC tests green; new audit-api tests green. ✓ (9/9 + 22/22)
- Ledger matches approved sketch: day groups, 12px inset, full-bleed hover, facet rail, "in view" counts, numbered pagination, detail Sheet. ✓ (drill: 47 day groups / 0 dup seams, facet filters, pager cur=2, sheet open/close/focus-return)
- Both themes; axe 0 violations on dark/light × 375/1440 + sheet open. ✓
- No other page touched; no API consumer broken. ✓
- Web: build ✓ lint 0 ✓ tests 104/104 ✓; `pnpm run check` green ✓.

## Results (2026-10-15)

- **Task 1** ✓ — `auditList`: `q` LIKE(email/event/detail), page/offset, `{events,total,page,pageCount}`; route query typed; `server/test/audit-api.test.ts` (9 tests). `before` cursor removed.
- **Task 2** ✓ — AuditPage rebuilt as ledger: sticky day headers w/ per-day counts (adjacent-merged, seam-safe), 64/200/150/1fr grid rows, 12px inset + full-bleed hover, facet rail (client "in view" counts, themed dots), search+actor+event toolbar, day/continuous toggle, numbered pagination w/ ellipsis + clamp, detail Sheet (right; kv fields + raw JSON), skeleton loader, 403 mapping kept. Rows are native `<button>`s — Enter/Space open natively, Esc returns focus to the row (the div+keydown.enter version raced reka's dismissable layer: open→instant close; caught via MutationObserver).
- **Task 2 (rev 2, user-caught)** — first cut diverged from the approved sketch: toolbar carried search+actor+event-select (wrapped to 111px, two rows) and the rail had only event classes. Rebuilt to sketch parity: rail = event class + ACTORS sections (actors click → server `actor` filter, top-6 by loaded count, clear buttons), toolbar = search + day/continuous toggle only (61px vs sketch 63px, single row). Measured side-by-side parity: grid 64/200/150/1fr, row pad 7px 12px, text inset 12, day pad 10/12/6, rail 2 sections @ 22px gap. Event Select removed (fEvent state + query param dropped — event filtering now = class facet, per sketch).
- **Task 3** ✓ — axe 0 violations across dark/light × 375/1440 + sheet-open (fixes en route: `<section>` for ledger col — App owns `<main>`; legacy `--color-ash` re-pointed to themed muted-foreground, killing 7 light-mode sidebar/badge contrast failures with zero dark delta (#b8b3b0 = dark muted-fg); rail-note opacity removed). Server q/facet/pagination drills pass against stubbed API. Screenshots: `~/.hermes/cache/scratch/lionidas-visual-drill/037/impl-final-*`.
- **Task 4** ✓ — sketch README annotated; this Results block.

**Disclosed:** rows dropping `role="listitem"` (buttons can't carry it — axe `aria-allowed-role`); list semantics traded for correct button semantics + accessible names.

## Risks

- Page seam day-header duplication — handled by adjacent-merge in the group-by (Task 2.5).
- Offset pagination on a growing log: page drift if new rows arrive between page fetches — accepted for an audit UI (timestamped, not transactional); note in code comment.
- Class facet filters only the loaded window (with "in view" counts) — full-log class filtering is a follow-up decision if needed (review H1).
