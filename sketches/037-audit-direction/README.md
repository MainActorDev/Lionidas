# 037 — Audit page: three directions

Round 036's factory-sidebar is locked; this round explores a different
**layout/composition** for `/audit` only. All three use the same Factory
tokens (Geist, #101010 canvas, carbon surfaces, hairline ash, status-only
orange/green) and real fake data (~128 events, same shape as `/api/audit`).

> **2026-10-15: A (timeline ledger) approved and IMPLEMENTED** — plan
> `plans/20261015T065500Z-audit-timeline-ledger-plan.md`, review
> `reviews/20261015T065500Z-...-review.md`. Production: server `q=` +
> numbered pagination, web ledger page. This sketch dir is the reference.

## The three takes

| Dimension | A · Timeline ledger | B · Master-detail | C · Activity stream |
|---|---|---|---|
| **Core idea** | Dense flat ledger grouped by day, facet rail | Scrolling list + persistent detail pane | Vertical narrative timeline with summary bar |
| **Density** | High (table's spiritual successor) | Medium | Low |
| **Filtering** | Facet rail (class + actor) + search | Search + chips (class, range) | Summary-bar class counts (clickable) + search |
| **Time grouping** | Sticky day headers (toggleable to continuous) | None (relative time only) | Day separators inline |
| **Detail depth** | None — detail truncated inline | Full: actor, context, raw record JSON | Context chips per event |
| **Scan-ability** | Best — columns align, eyes compare | Good in list, best in pane | Medium — reads chronologically, not comparatively |
| **Mobile** | Columns collapse to 2-row stack; rail hides | Pane hides; list carries alone | Naturally single-column |
| **shadcn fit** | Table/Sheet/Badge directly | Sheet or custom split; Table for list | No table — Badge/Card-ish primitives, mostly custom |
| **Feels like** | Linear/GitHub audit log | Mail client / log viewer | Activity feed (Slack/Linear activity) |
| **axe (both widths)** | 0 violations | 0 violations | 0 violations |

## Trade-offs

**A — Timeline ledger.** Strongest for the actual supervisor workflow: scan
many rows fast, compare actor×event×time visually, filter then re-scan.
Weakest for "what exactly happened in this one event" — detail truncated to
one line. It's the current table, evolved: grouped, denser, facet-driven.
Fits shadcn best (Table, Badge, Sheet for facets on mobile).

**B — Master-detail.** Strongest per-event forensics: every record's actor,
IP, role, raw JSON always visible without a click. Weakest at scanning —
half the screen is one event you may not care about; list column narrows.
Most novel vs. current app (nothing else is split-pane yet); needs a mobile
answer (Sheet-as-detail would work).

**C — Activity stream.** Strongest narrative: "what's been happening" reads
like a feed; the summary bar doubles as filter + status (denials count in
orange). Weakest for audit proper — low density means 128 events is a lot
of scrolling; "live" implies a streaming API that doesn't exist. Best if
audit wants to feel like monitoring, less like a ledger.

## Recommendation

**A (timeline ledger)** as the base — it keeps the audit page's identity
(inspection, comparison, density) while fixing the current table's real
gaps: no time grouping, no search, event chips only color-coded. Steal one
thing from B: a lightweight row→detail Sheet (mobile + click) rather than a
persistent pane. C's summary-count bar could replace the plain count text,
but don't build the feed.

That hybrid = A's ledger + day grouping + facet rail + search, detail on
demand via Sheet. All within the Phase-2 shadcn primitive set.
