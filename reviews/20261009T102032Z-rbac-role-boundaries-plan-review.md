# Review — RBAC round plan

- Plan reviewed: `plans/20261009T102032Z-rbac-role-boundaries-plan.md` (Ready, 2026-10-09)
- Evidence: server routes read from source this review (auth.ts, runs.ts,
  manual.ts, env-vars.ts, setup.ts, roles.ts, schema.ts); live DB spot-queries;
  brainstorm + decision log.
- Verdict: **Needs revision** — one High finding (an uncovered sensitive
  surface that defeats the viewer mask) plus a sequencing fix. Everything
  else is sound; F3–F5 are disclosures.

## What was verified against source (this review, not the plan's claims)

- Matrix's current-state basis confirmed: reads are session-gated only
  (`/api/runs` list, `/api/manual/:id/record` carry no role preHandler).
- `evaluated_json` on run steps keeps **unresolved** `${env.X}` refs (37/37
  rows checked) — run outputs do NOT leak resolved env values. The viewer
  mask does not need to touch run rows. ✓
- Env-var GET already masks `secret` values for everyone (`env-vars.ts:59`)
  — the viewer mask's job is the NON-secret values. Plan wording consistent. ✓
- Abort route today is **completely ungated** beyond sign-in
  (`runs.ts:192`) — a viewer-role user can abort runs right now. The plan's
  T2 sweep fixes this; worth stating as motivation. ✓ (supports plan)
- `auth_log` exists with named-actor writes on account mutations
  (`auth.ts:182-211`); role-change validation list at `:186` needs the
  supervisor addition, as planned. ✓
- Attribution-as-strings confirmed (runs.triggered_by, templates.created_by,
  manual_sessions.operator). ✓

## Findings

### F1 — HIGH — manual-session recordings leak typed secrets past the viewer mask (plan §Viewer mask, §T2)

**Evidence**: `GET /api/manual/:id/record` (manual.ts:459) has no role gate —
any signed-in user. The recording's `recording_json` contains `type`/`paste`
steps with RAW TEXT (verified live: recordings carry typed fields; the paste
verb stores `text` verbatim). Operators type credentials during exploratory
sessions; a VIEWER who can read a live session's recording reads those
credentials. The plan's viewer mask covers env-var values, users, settings —
not this route.

**Consequence**: the mask's promise ("read-only without sensitive
information access") is broken by a route the matrix never classified; the
boundary test suite would pass while the leak stays.

**Correction**: classify manual-session surfaces in the matrix: recordings
(including thumbs/frames of credential screens, arguably) = operator+; the
session list already is (`manual.ts:452`). Add `/api/manual/:id/record`,
`/api/manual-frame`, `/api/manual-thumb` to the viewer mask's 403 list (or
gate operator+ outright), and add the recording route to the boundary suite.

**Verify**: viewer account GETs `/api/manual/:id/record` → 403; operator → 200.

### F2 — MEDIUM — T2 ownership checks depend on T4's FK columns (plan §Implementation stages)

**Evidence**: T2 converts abort/delete to ownership checks; the ownership
predicate (`triggered_by_user = actor`) lands with T4's migration.

**Consequence**: T2 as ordered either builds on not-yet-existing columns or
silently uses string matching; tests in T6 would be the first to notice.

**Correction**: T2's ownership check uses the existing `triggered_by` STRING
match against `req.user.name` (works today); T4 upgrades the predicate to
the FK (and keeps the string as fallback for legacy rows where the FK is
NULL after backfill). One sentence in each stage fixes the dependency.

**Verify**: abort-own run test passes between T2 and T4 (string path), and
still passes after T4 (FK path).

### F3 — LOW — "isSupervised" team reading is convoluted (plan §Architecture)

**Evidence**: "assigned to the supervisor OR to any operator (all
non-supervisor humans are the team)" — since every run is triggered by an
operator/supervisor/admin/bot, the second clause ≈ "any run", matching the
matrix's simpler "abort/delete: any".
**Correction**: keep the matrix's plain rule (supervisor: any; operator:
own) and note assignment as a FILTER, not the boundary. No behavior change;
removes a confusing predicate.

### F4 — LOW — audit-denial rows can flood (plan §T3)

403-denial audit writes are spam-prone (one per blocked request; a looping
client writes unbounded rows). Correction: audit denials at most once per
(actor, route) per minute, or drop denial-auditing to a counter. Disclose
the choice in the plan.

### F5 — LOW — capabilities freshness (plan §Edge cases)

Plan says web refetches capabilities "on nav" — a long-lived single-page
session after a role change mid-session still shows stale buttons until
nav; server gates are per-request so this is cosmetic only. Acceptable —
already disclosed in the plan's edge cases; no change required.

## Coverage / traceability

Every brainstorm decision maps to a stage and an acceptance check (matrix →
T1/T2/T6; viewer mask → T2 + tests; audit → T3 + tests; attribution/assignment
→ T4 + drill; web → T5 + drill; user-DB convention → rollout section). The
one unclassified surface class (manual-session reads) is F1. Supervisor
shape, viewer lens, audit inclusion, and interaction scope all trace to the
operator's answers in the decision log.

## What this review could not certify on paper

Real-world enforcement completeness (the 39-site sweep can miss routes —
the boundary suite enumerating SURFACE CLASSES, not sites, is the right
defense; it must include the manual-session class per F1), migration
behavior on the live 78MB DB, and UI guard UX. All are execution properties
covered by T6/T7.

## Required plan edits before implementation

1. F1: add manual-session read routes to the viewer mask (403/operator+)
   and to the boundary suite's surface list.
2. F2: specify the string-match ownership predicate in T2, FK upgrade in T4.
3. F3: simplify the supervisor boundary rule to matrix wording.
4. F4: pick and disclose the denial-audit flood control.

**APPLIED to the plan 2026-10-09** — all four edits are in
`plans/20261009T102032Z-rbac-role-boundaries-plan.md`: viewer-mask section
now names the manual-session read class (record/frame/thumb → operator+,
with the live verification note); T2 carries the string-match ownership
predicate + the ungated-abort motivation; T4 upgrades to FK-with-fallback;
assignment is a filter, boundary is the matrix rule; denial audit is
flood-controlled (1 row per actor+route per minute); T6 asserts surface
CLASSES including the manual-session class. With F1–F4 resolved, no open
findings block implementation; verdict for the revised plan: **Ready for
implementation**.

## Questions for the operator

None blocking — the edits follow from verified source. Confirm and I'll
apply them, then implementation can start at T1.
