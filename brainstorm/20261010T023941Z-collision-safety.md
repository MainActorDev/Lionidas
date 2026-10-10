# Multi-user collision safety: device exclusivity + edit conflict detection

- Source prompt: "What would happen if 2 users logged in and doing what they're
  doing. Will there be a collision or something?" → live 2-user drill found
  real gaps → operator: "Brainstorm it"
- Created: 2026-10-10T02:39:41Z
- Updated: 2026-10-10 — operator decision: NO take-over (strict C), plus
  GLOBAL presence visibility ("who did/drives what" on every surface that
  fits)
- Status: Direction locked — strict exclusivity + presence everywhere

## Goal and context

Two live-proven collisions, from the actual drill on the real server:

1. **Device co-driving**: two operators took control of the same booted
   iPhone simultaneously — both got sessions (`ms_a9ed8564` +
   `ms_31c44871`), both taps dispatched (`ok:true` × 2), no refusal, no
   warning. Screen = last-writer-wins; each recording looks solo.
2. **Case edit clobber**: two PATCHes to the same template both 200;
   user 2's description silently overwrote user 1's. `updated_by` + audit
   record the last writer; the first edit is just gone.

Operator's framing: this is the deferred interaction slice (c)
(handoff & locking) from `brainstorm/20261009T102032Z-rbac-role-boundaries.md`.

## Confirmed inputs and decisions

- Scope = collision safety for the two proven classes (user: "Brainstorm it"
  after seeing the drill evidence; no other shape discussed).
- **TAKE-OVER: NOBODY takes** (user, 2026-10-10: "Nobody takes."). Option C
  collapses to strict: a held device is simply unavailable until the holder
  releases or the idle watchdog frees it. No supervisor override.
- **PRESENCE EVERYWHERE** (user: "I want other users can see who currently
  running or driving it... This applies for everything else in Lionidas
  that fits the criteria. Such as, I want user to see who booted this
  device and so on."). Attribution becomes a first-class UI concern, not
  just audit rows.
- Out of scope (unchanged): comments/mentions, teams, per-team isolation.

## Verified facts (source + live drill, 2026-10-10)

- `startManualSession` checks run-vs-session (QUEUE_ACTIVE 409,
  session.ts:141-144) but NOT session-vs-session — nothing refuses a second
  live session on the same udid.
- The stream proxy is per-session; two co-driving sessions interleave
  physical input silently.
- Idle watchdog finishes sessions idle >5min (crash safety) — a stale
  holder self-clears eventually, but 5 minutes of co-driving is invisible.
- `manual.session.open` bus event carries `{sessionId, udid, operator}` —
  the cockpit could already know a holder exists; nothing renders it.
- Template PATCH is a blind full-row write (`UPDATE ... WHERE id = ?`,
  templates.ts:926) — no version check, no expected_updated_at contract.
- `templates.updated_at` exists and is bumped on write (last writer wins).
- Safe classes (verified earlier, unchanged): DB serialization, run-vs-run
  queueing, role gates per request, per-user activity scoping.

## Locked direction + presence inventory

### Device exclusivity (strict — nobody takes)

Second take-control on a held device → 409 `DEVICE_HELD` naming the holder
+ session start time. No override path for anyone. The cockpit shows
"driven by <name> · Xm" (already half-built: `lease_display` resolves the
manual-session operator server-side, devices.ts:86) and the take-control
button explains who holds it. The idle watchdog (5 min) remains the only
automatic release.

### Presence: who did/drives what — surface inventory (verified in source)

Already attributed (needs UI surfacing only):
| Surface | Data exists | UI today |
|---|---|---|
| Manual drive holder | `lease_display` (devices list, server-joined) | not rendered |
| Who ran a case | `runs.triggered_by` (+FK from RBAC round) | runs list shows raw name |
| Who created a case | `templates.created_by` (+FK) | not rendered |
| Audit log | auth_log (login/run_play/abort/take_control/uninstall/...) | Audit page (done) |

Attribution gaps (needs a WRITE added, then UI):
| Action | Today | Fix |
|---|---|---|
| Boot/shutdown/restart | no audit, no stamp (devices.ts:128 power route) | auditWrite('device_action') + devices.last_power_by TEXT |
| Build trigger | no audit on the route | auditWrite('build_trigger') |
| Case edit | updated_by string (no audit row class) | auditWrite('case_edit') — covers the edit-conflict story too |
| App install/uninstall | uninstall audited; install NOT | auditWrite on install |
| Take control | audited (done) | + live holder chip |

UI surfaces (the "see it" half):
- Device WALL row + cockpit sidebar: holder chip "● driven by <name> Xm"
  (live, from lease_display), "booted by <name>" from last_power_by.
- Runs rows + run detail: operator chip (initials + name).
- Case cards: "by <creator>" + "you're editing" indicator.
- Audit page already covers the retrospective view.

### Case-edit collision (unchanged from Option C's edit half)

Optimistic concurrency: PATCH/PUT yaml require `expectedUpdatedAt`;
mismatch → 409 `EDIT_CONFLICT` naming the other editor. No lock UI.

## Open questions

None — the operator decision closed both (nobody takes; visibility
everywhere). Displaced-operator UX is moot: nobody can be displaced.

## Next step

Plan Ready: `plans/20261010T023941Z-collision-safety-plan.md`.
