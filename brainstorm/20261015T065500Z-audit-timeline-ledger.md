# Audit page rebuild — timeline ledger direction

- Source prompt: "While we at it, I think it's best if we going to different direction for the 'audit' page. explore different layout/composition" → sketch round 037 → "Timeline ledger looks good to me. Ensure log list padding correct" → "go" (brainstorm→plan→review→implement chain)
- Created: 2026-10-15T06:55:00Z
- Status: Direction selected

## Goal and context

Rebuild `/audit` (Phase 2 pilot page, currently a shadcn Table layout) into the
**timeline ledger** composition from sketch round 037 variant A — the
user-approved direction. The page keeps its identity (dense inspection log,
supervisor+ RBAC, `/api/audit` contract unchanged) but gains day grouping,
a facet rail, search-first filtering, and detail-on-demand.

Confirmed direction: variant A with the hybrid noted in the sketch README
(detail-on-click as a Sheet, not a persistent pane). Phase 2 Task 5 sign-off
on the current table layout is superseded by this round.

## Confirmed inputs and decisions

- User: "Timeline ledger looks good to me" (variant A, 2026-10-15).
- User: "Ensure log list padding correct" — 12px horizontal inset on ledger
  rows/day headers, full-bleed hover; measured fixed in sketch (textInset
  12/12, no overflow).
- Locked system context: Factory theme (round 036), shadcn-vue foundation
  (Phase 2 Tasks 1–4 done: Table/Badge/Select/Button/Input/Sheet generated,
  theme.css dual-theme, axe 0 violations).
- Server contract `/api/audit?actor=&event=&before=&limit=` returns
  `{events:[{id,at,email,user_id,event,detail}],hasMore}` — cursor pagination.
  (server/src routes; unchanged by this round.)
- RBAC: supervisor+ server-side; nav hides entry below supervisor (App.vue
  visibleGroups) — unchanged.
- User workflow rule (standing, 2026-10-14): Phase 2+ changes run
  brainstorm → plan → review → implement. This chain satisfies it.

## Exploration

Gaps with real effect:

1. **Facet counts & search are new server capabilities?** The sketch facets
   show counts (auth 41, runs 36…) and a free-text search box. Current API
   filters only by actor-contains and exact event. Options:
   a. Client-side counts/search over loaded rows only (no API change) —
      honest scope, but "search" only covers the loaded window.
   b. Extend `/api/audit` with `q=` param + a `/api/audit/facets` counts
      endpoint — full fidelity, touches server + tests.
   → Recommend (b) for search (`q` matches detail/email/event LIKE) and (a)
   for facet counts (computed from loaded rows, labeled "in view") in this
   round; counts endpoint deferred. Search without server support lies.
2. **Day grouping + cursor pagination**: rows arrive newest-first pages of
   50; grouping client-side by calendar day of loaded rows is trivial and
   stable under "load more" (append groups). "continuous" toggle = flat list.
3. **Detail Sheet**: click row → Sheet (right side) with full record fields
   (at, actor email, user_id, event, detail, class) + raw JSON block. Uses
   the already-generated Sheet family. Mobile: Sheet covers width.
4. **shadcn fit**: rows become custom ledger markup (not Table) — a grid
   with role="table"/"row"/"cell"? Or a plain list? Recommendation: semantic
   `<table>` kept for a11y (screen-reader row/cell semantics) but styled as
   ledger rows with day group rows; OR use list+articles. Table semantics
   with `<tbody>` per day keeps SR navigation by row AND allows sticky day
   headers as separate divs. → Keep Table components but restructure:
   actually simplest honest path: hand-rolled ledger list (role="list") with
   sticky day headers, since columns are fixed-width grids. Axe-clean either
   way; keyboard: rows focusable (tabindex 0) + Enter opens Sheet.
5. **Facet rail on mobile**: ≤900px rail hides (sketch) — filters collapse
   into the toolbar as a Select (event class) — acceptable; or a Sheet.
   → Toolbar Select (already have the component).

## Open questions

1. Server `q=` search param — approve touching `server/` in this round?
   (Changes `/api/audit` handler + adds tests. If no: client-window search
   only, clearly labeled.)
2. Facet counts: client-side "in view" counts OK vs. server facets endpoint?
   (Recommend client-side now.)
3. Keep "load more" cursor pagination as-is (no infinite scroll)?

## Next step

Answer the three questions → write the plan (hms-plan-from-brainstorm) →
review (hms-review-detailed-plan) → implement.
