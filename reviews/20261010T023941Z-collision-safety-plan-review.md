# Review — Collision safety + presence plan

- Plan reviewed: `plans/20261010T023941Z-collision-safety-plan.md` (Ready, 2026-10-10)
- Evidence: session.ts/routes (exclusivity paths, probe path manual.ts:380-388,
  replace-cleanly comment :136-138), TestCasesPage PATCH callers (:279 patchTemplate,
  :536 setStatus PARTIAL body), CaseEditorPanel PUT yaml (:178), devices.ts power
  route (no preHandler today), audit.ts event union vs the raw uninstall INSERT.
- Verdict: **Needs revision** — one Critical (partial-patch callers break under a
  required token), one High (probe path collides with exclusivity). F3–F5 are
  scoped corrections; F6 disclosure.

## Findings

### F1 — CRITICAL — required `expectedUpdatedAt` breaks partial PATCHes (plan §Architecture, T3)

**Evidence**: PATCH /api/templates/:id is used for PARTIAL bodies: the
lifecycle toggle sends only `{status}` (TestCasesPage :536-541), tags send
`{tags}` (:288). The plan makes the token REQUIRED on every PATCH.
**Consequence**: status flips and tag edits 400 (or, if made optional
server-side, silently bypass the conflict check — worse). The editor save
is NOT the only caller.
**Correction**: scope the conflict contract to CONTENT writes — require the
token only when the body carries `steps`/`setup`/`name`/`yaml` (the fields
where lost work happens). Metadata flips (status/tags/folder) are
last-writer-wins by nature and stay tokenless. Server: token required iff
content fields present; 400 only then.
**Verify**: unit test — `{status:'deprecated'}` without token → 200;
`{steps:[...]}` without token → 400; stale token + steps → 409.

### F2 — HIGH — screens-registry probe path starts sessions and would 409 (plan §T1)

**Evidence**: `/api/.../screens/probe` (manual.ts:380-388) calls
`startManualSession` when its own session expired — under strict
exclusivity, probing while ANY user drives the device 409s. The probe is a
registry workflow (Screens page), not driving; blocking it on presence is
overreach and would break screens work mid-drive.
**Correction**: the guard lives in `startManualSession` with an options
arg `{ allowWhenHeld?: boolean }` — route `/api/manual/start` passes
nothing (strict), the probe passes `allowWhenHeld` (it foregrounds the app
on the SAME device — hmm, see F6): SIMPLEST honest fix: the probe reuses
the device's EXISTING live session when one is held (any operator's —
it's read-only tree capture) and only starts fresh when none exists.
**Verify**: test — user B probes while user A drives → 200 via A's
session, tree returned, A's session untouched.

### F3 — MEDIUM — session.ts comment documents the OPPOSITE contract (plan §T1)

**Evidence**: the function's leading comment says "a second session on a
free device replaces cleanly" (session.ts:136-138) — an operator decision
from 2026-10-04 that this plan reverses per the new directive.
**Correction**: T1 must REWRITE that comment (and the QUEUE_ACTIVE note) to
the new contract, or the next reader reverts the guard as a bug.
**Verify**: comment updated in the same commit as the guard.

### F4 — MEDIUM — power route also needs its role gate (plan §T2)

**Evidence**: `/api/devices/:udid/power` has NO preHandler today
(devices.ts:128) — a viewer can already boot/shutdown. The plan adds audit
+ last_power_by but not the gate; the matrix says device actions are
operator+.
**Correction**: add `requireRoleAtLeast('operator')` in T2 alongside the
audit write (it's the same class as the drill-caught uninstall hole).
**Verify**: boundary test — viewer power action → 403.

### F5 — MEDIUM — `device_action` event name collides with the typed union (plan §T2)

**Evidence**: uninstall writes via a RAW insert (manual.ts:688) with the
event string inline; auditWrite's `AuditEvent` union must gain the new
names (device_action, build_trigger, case_edit, app_installed) or tsc
fails mid-T2.
**Correction**: extend the union first in T2; optionally migrate the
uninstall raw insert to auditWrite for one shape.
**Verify**: tsc green after T2; audit page event-class groups updated
(auth/accounts/runs/cases/devices/rbac already grouped — add none).

### F6 — LOW — probe foregrounding a held device (disclosure)

The probe path foregrounds the target app — while a user drives, a
registry probe could still disturb their screen. With F2's fix the probe
reuses the held session (already on that device); foregrounding a
DIFFERENT bundle than the driver's app remains possible. Accepted risk:
rare, visible, non-destructive; disclose in the plan's edge cases.

## Coverage / traceability

Both decision-log rows trace to work + checks: exclusivity → T1 (+F2/F3
corrections) + drill A; presence → T2/T4 + drill screenshots; edit
conflict → T3 (rescoped by F1) + drill B. No extra commitments found. The
plan's verified facts match source on every claim I re-checked (lease
write path, WallPage rendering, install/uninstall asymmetry, blind PATCH).

## What this review could not certify on paper

Whether strict exclusivity regresses any单人 workflow that legitimately
relies on a second session (none found in-repo; the replace-cleanly
comment suggests it was a convenience, not a dependency). Live drills
cover the rest.

## Required plan edits before implementation

1. F1: scope the edit-conflict token to content fields; partial metadata
   patches stay tokenless (test matrix above).
2. F2: probe reuses a held session instead of starting one; guard gains
   the reuse path.
3. F3: T1 rewrites the reversed-contract comment.
4. F4: T2 adds the power route's operator gate.
5. F5: T2 extends the AuditEvent union first.

**APPLIED to the plan 2026-10-10** — all five edits are in
`plans/20261010T023941Z-collision-safety-plan.md`: token scoped to
content writes with the 400/409/200 test matrix spelled out; probe-reuse
path specified in the server section + acceptance checks; the
reversed-contract comment rewrite is a named T1 deliverable; the power
route gate + AuditEvent-union-first ordering live in the attribution
stage; F6 disclosed in edge cases. With F1–F5 resolved, no open findings
block implementation; verdict for the revised plan: **Ready for
implementation**.

## Questions for the operator

None blocking — all corrections follow from verified source.
