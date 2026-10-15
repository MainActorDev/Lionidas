# Review — audit timeline ledger plan

- **Plan reviewed:** `plans/20261015T065500Z-audit-timeline-ledger-plan.md` (as written 2026-10-15)
- **Sources:** brainstorm `20261015T065500Z-audit-timeline-ledger.md` + decision log (3 user answers); sketch `sketches/037-audit-direction/a-timeline-ledger/` (approved, padding measured); server code `server/src/auth/audit.ts` (read in full), `server/src/routes/runs.ts:112-115`; RBAC tests `server/test/rbac-boundaries.test.ts:184-186`.
- **Verdict: Ready for implementation** — with one High correction applied to the plan before coding starts (see H1), two Medium disclosures.

## Traceability

Every decision-log answer maps to plan work + an acceptance check:
- q= search → Task 1.1 + audit-api tests (q matches email/event/detail).
- Client-side counts "in view" → Task 2.2 label + drill check.
- Numbered pagination → Task 1.1 page/total/pageCount + Task 2.1 footer + pagination-boundary state (2.4).

Verified facts: `/api/audit` handler exists as described (`runs.ts:113`, `auditList` in `auth/audit.ts:40-51`, cursor `before` today); web AuditPage is the only fetch site of `/api/audit` (rg over `web/src` — 1 hit); server tests touch only RBAC status codes for this route.

## Findings

**H1 — `events` list param invented without operator approval.** Plan Task 2.2 adds an `events` (comma-list) server param so a facet (event CLASS) can filter server-side. The user approved facet counts client-side and q= search — never an `events` param. Effect: unapproved API surface + extra server work; also unnecessary: each class maps to ≤6 concrete event names, and `q` can't express OR either — but the page can send the class's FIRST event… no. Honest options: (a) drop facet-click filtering to client-side over the loaded window (consistent with "in view" counts, zero server change), or (b) ask the user. → **Correction applied to plan:** facet click filters the loaded window client-side (same fidelity as the counts — they're a pair; "in view" filtering with "in view" counts is coherent). Server `q` remains substring-only. If full-log class filtering is wanted later, it's a follow-up with its own decision.

**M1 — Page-drift on a live log (disclosed in plan Risks; keep).** Offset pagination with new writes between fetches can shift rows across pages. Acceptable for audit UI; the plan already commits to a code comment. Verify: test asserts stable page slice under no-writes (deterministic), comment documents the live-log caveat.

**M2 — `total` COUNT query cost.** Each page view runs COUNT(*) under WHERE. auth_log grows unboundedly; no index exists on email/event/detail beyond whatever schema has. Verify during implementation: `EXPLAIN QUERY PLAN` — if a scan appears, add the same WHERE-limit… (not blocking: table is single-team audit volume, and COUNT runs only per page fetch).

**M3 — Day-seam duplicate headers.** Plan handles via adjacent-merge (Task 2.5 note inside 2.2). Test: two pages sharing a boundary day render ONE header (drill asserts).

**L1 — Sketch uses rgba(61,58,57,.4) row borders.** Plan Task 3.2 already gates this (≥3:1 non-text or swap to var(--border)). Keep.

## What stays open during implementation

- Exact pagination component look (numbers + ellipsis) — plan specifies behavior, not pixels; sketch is the reference but footer wasn't in it. Implementer may mirror the toolbar seg styling; keep mono, hairline, no new hexes.
- Skeleton strip for loading (Task 2.4) — first appearance of loading state on this page; keep to row-height neutral blocks, motion-safe.

## Required plan edits (before coding)

1. Remove `events` param from Task 1.1/2.2 and Risks; replace with client-side class filtering over the loaded window (H1).
2. Task 1 response shape: `{events,total,page,pageCount}` — unchanged; drop `events` from schema note.

Edits are mechanical; no re-review needed after them.
