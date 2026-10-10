# Plan — Collision safety + presence: strict device exclusivity, who-did-what everywhere

- Source brainstorm: `brainstorm/20261010T023941Z-collision-safety.md` (direction locked, no open questions)
- Review: `reviews/20261010T023941Z-collision-safety-plan-review.md`
  (F1-F5 applied 2026-10-10; F6 disclosed, nonblocking)
- Status: Ready (revised - review findings applied)
- Created: 2026-10-10

## Decision log

| Decision | Source |
|---|---|
| Take-over: NOBODY takes — held device is unavailable, no override | User: "Nobody takes." |
| Presence: other users see who's running/driving — applied to everything that fits ("who booted this device and so on") | User: same message, 2026-10-10 |
| Case-edit collision: optimistic locking (from the brainstorm's option C edit-half, unchallenged) | Brainstorm, operator-reviewed |
| Out of scope: comments/mentions, teams, per-team isolation | Standing from RBAC round |

## Verified facts (source + live drill, 2026-10-09/10)

1. Two simultaneous take-controls both succeed today (`startManualSession`
   checks run-vs-session only, session.ts:141-144; live drill: two sessions,
   both taps dispatched).
2. `lease_holder` is written `manual:<sessionId>` at session start
   (session.ts:171) and resolved to the operator's NAME server-side as
   `lease_display` (devices.ts:86); WallPage already renders it as an ember
   name when held (WallPage.vue:250).
3. Power route (boot/shutdown/restart) writes NO audit row and NO who-stamp
   (devices.ts:128-150); guarded against runs/sessions but attributionless.
4. Install route audits nothing (manual.ts:625+); uninstall DOES write an
   auth_log row (manual.ts:688, live DB shows 7 `app_uninstalled` rows).
5. Audit classes wired today: manual_take_control, run_play, run_abort +
   the account events + app_uninstalled + rbac_denied. NOT wired:
   device_action (power), build_trigger, case_edit, install.
6. RunsPage already renders `triggered_by` (RunsPage.vue:257); templates
   have created_by/updated_by strings + user FKs (RBAC round).
7. Template PATCH is a blind full-row write (templates.ts:926) — no version
   check; live drill: concurrent edits, silent clobber.
8. `templates.updated_at` is ms-precision and bumped on write — usable as a
   version token without schema change.
9. Idle watchdog finishes sessions idle >5min (session.ts:498) — the only
   automatic release; stays.

## Objective

No two users ever co-drive a device silently; every "who did this" question
has a visible answer on the surface where it matters, backed by audit rows.

Measurable completion:
- Second take-control on a held device → 409 `DEVICE_HELD` naming holder +
  session age; co-driving is impossible (proved by live 2-user drill).
- Device wall + cockpit show the live holder chip; devices show who booted
  them last.
- Runs show operator chips; case cards show creator; audit page shows
  power/build/case-edit/install events.
- Concurrent case edits: second write → 409 `EDIT_CONFLICT` naming the
  other editor; UI reloads with a toast; no silent clobber (live 2-user
  drill).
- Suites green + boundary/drill tests for each behavior.

## Scope

IN: session-vs-session 409; presence UI (holder chip, booted-by, operator
chips, creator); audit coverage for power/build/case-edit/install; edit
optimistic locking; tests + live drills.
OUT: take-over paths (any role), comments, teams, device isolation,
locking UI (leases/timers beyond the existing idle watchdog).

## Architecture

**Server**
- `startManualSession`: before creating a session, check
  `SELECT id, operator, started_at FROM manual_sessions WHERE udid = ? AND
  finished_at IS NULL` → throw `ManualSessionError('DEVICE_HELD',
  'driven by <operator> · <Xm> — nobody takes over (release or wait,
  auto-releases after 5 min idle)')`. Same guard class as QUEUE_ACTIVE;
  route maps to 409.
- Screens-registry probe path (review F2): `/api/.../screens/probe` must
  NOT 409 when the device is held — it reuses the device's EXISTING live
  session (read-only tree capture; any operator's session is fine) and
  only starts a fresh one when none exists. Probe stays available during
  a drive.
- T1 REWRITES the function's leading comment (session.ts:136-138 —
  "a second session on a free device replaces cleanly" documents the
  reversed 2026-10-04 contract; leaving it invites a revert-as-bug)
  (review F3).
- FIRST (review F5): extend audit.ts's `AuditEvent` union with
  device_action, build_trigger, case_edit, app_installed (uninstall's raw
  insert may migrate to auditWrite for one shape - optional).
- Power route: `requireRoleAtLeast('operator')` preHandler (review F4 -
  NO gate exists today; a viewer can boot/shutdown right now, same class
  as the drill-caught uninstall hole) + `auditWrite(db, req,
  'device_action', '<action> <udid>')` + `devices.last_power_by TEXT`
  (nullable, stamped `req.user.name`, guarded ALTER) + included in the
  devices list response.
- Install route: `auditWrite('app_installed')` (mirror of uninstall's).
- Build trigger route (projects/routes.ts): `auditWrite('build_trigger',
  'project <id> build #<n>')`.
- Template PATCH + PUT yaml — conflict token scoped to CONTENT writes
  (review F1): required iff the body carries steps/setup/name (PATCH) or
  any yaml (PUT — yaml IS the content). Metadata flips (status/tags/
  folder/description-only) stay tokenless last-writer-wins by nature.
  Token present → `UPDATE ... WHERE id = ? AND updated_at = ?`; changes()
  === 0 with the row existing → 409 `EDIT_CONFLICT` carrying current
  updated_by/updated_at. Content body WITHOUT a token → 400 explaining
  the contract (honest refusal, no silent bypass).
- Case edit audit: `auditWrite('case_edit', 'case <id>')` on success.

**Web**
- WallPage: holder chip gains the live dot + "· Xm" age (poll already
  refreshes devices); `booted by <name>` subtitle when `last_power_by` set.
- Cockpit (StageBezel): when `lease_display` names another user and no
  local session → the take-control button tooltip + the runlock-style
  banner show "driven by <name> · Xm"; 409 DEVICE_HELD → toast with the
  same text (existing toast path).
- RunsPage: `triggered_by` name becomes an initials-chip + name (pure
  render, data already flows).
- TestCasesPage cards: "by <created_by>" footer line.
- Case editor save (content): send `expectedUpdatedAt` (loaded with the
  case); on 409 → toast "edited by <updated_by> — reloading", reload the
  case. Metadata surfaces (status toggle, tags) send no token — they stay
  simple partial PATCHes (review F1 scoping).

## Implementation stages

- **T1 — exclusivity**: session-vs-session guard + 409 mapping + tests
  (second start refused, named holder; release → next start succeeds).
- **T2 — attribution writes**: last_power_by column + power/install/build/
  case-edit audit writes + devices list field + tests (each write lands
  with the actor; boundary suite untouched classes still pass).
- **T3 — edit conflict**: expectedUpdatedAt contract on both write routes
  + repo callers + 409 shape + tests (stale token refused, fresh passes,
  delete-vs-patch stays honest 404).
- **T4 — presence UI**: holder chip + age, booted-by, operator chips,
  creator footer, editor conflict toast + reload. Web typecheck + suite.
- **T5 — gates + live drills**: full suites; LIVE 2-user drill #1 (both
  take-control → second gets named 409; holder releases → succeeds), #2
  (both edit a case → second gets conflict toast, no clobber); commit +
  PR `feat/collision-safety-presence`.

## Edge and failure cases

- Holder's tab dies without release → idle watchdog (5 min) frees; the 409
  text says so ("or auto-releases after 5 min idle").
- `build:#N` pseudo-users never collide with real names in chips (rendered
  as-is, as today).
- EDIT_CONFLICT vs delete race: row gone → plain 404 (already correct).
- Old clients without expectedUpdatedAt → 400 ONLY for content bodies
  (per F1 scoping); metadata patches are unaffected (honest, not silent).
- `last_power_by` null on pre-migration devices → chip hidden (no "unknown").
- Bots: take-control is already operator-gated; bots unaffected by the
  409 (they use runs, which queue).
- Probe foregrounding a DIFFERENT bundle than the driver's app can still
  disturb a drive (accepted risk, disclosed review F6): rare, visible,
  non-destructive.

## Validation and acceptance checks

1. `server/test/collision-safety.test.ts`: exclusivity + edit-conflict
   contracts (content-vs-metadata token scoping per F1: {status} no-token
   -> 200; {steps} no-token -> 400; stale-token steps -> 409), probe-reuse
   under a held device (F2), named-actor audit writes
   (power/install/build/case-edit), viewer power -> 403 (F4).
2. Live 2-user drill A (exclusivity, named holder, release-then-succeed)
   and B (edit conflict, toast, reload) — transcript under `reviews/`.
3. Boundary suite still 22/22; full server + web suites green; signature
   scan clean.
4. Wall/cockpit/runs/cases show the four presence surfaces in the drill
   screenshots.

## Rollout / handoff

PR `feat/collision-safety-presence` on Lionidas. No data migration beyond
nullable `last_power_by`. The strictness is a behavior change for anyone
who relied on co-driving (nobody — it was silent breakage); release notes
line it.
