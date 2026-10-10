# Plan — RBAC round: 4-tier roles, viewer mask, audit surface, user attribution

- Source brainstorm: `brainstorm/20261009T102032Z-rbac-role-boundaries.md` (all questions closed)
- Review: `reviews/20261009T102032Z-rbac-role-boundaries-plan-review.md`
  (F1–F4 applied 2026-10-09; F5 disclosed, nonblocking)
- Status: Ready (revised — review findings applied)
- Created: 2026-10-09

## Decision log

| Decision | Source |
|---|---|
| Roles: ADMIN > SUPERVISOR (QA lead) > OPERATOR (QA) > VIEWER | User: "ADMIN, SUPERVISOR, OPERATOR, and VIEWER… ADMIN is the highest authority… VIEWER is the lowest" |
| Each role: clear see/do boundary | Same prompt |
| VIEWER: read-all minus sensitive (env values, users, secrets/config) | User: "sees everything read-only without sensitive information access" |
| Audit log surface in scope | User: "Include it" |
| Multi-user: attribution + assignment + drive-holder now; comments/teams later | User: "go with the recommendation" |
| Supervisor "own-area" delete rides the assignment link | Same decision (closes brainstorm Q2) |
| High-level ops relate to users DB (FK attribution) | Original prompt |
| Bots: pipeline-only, out of scope this round | Brainstorm default, unchallenged |

## Verified facts (source, 2026-10-09)

1. `Role = 'viewer' | 'operator' | 'admin' | 'bot'` (`auth/users.ts:9`); no supervisor.
2. `requireRole` grants admin implicitly (`roles.ts:113`), bots pass as operator (`:115`). 30 route sites gate `'operator'`, 9 gate `'admin'`.
3. Reads: only `requireUser()` — any authenticated user reads EVERYTHING (index.ts hard read gate = session-only).
4. `auth_log(at, email, user_id, event, detail)` exists with audit writes on admin credential mutations only (`auth.ts:182-211`); no read surface, no coverage of runs/builds/cases.
5. Role-change validation is a hard-coded list `['viewer','operator','admin']` (`auth.ts:186`) — must widen.
6. Attribution is strings: `runs.triggered_by TEXT NOT NULL` (schema.ts:16), `templates.created_by` (:93), `manual_sessions.operator`; no user FKs anywhere.
7. `/api/me` exists (auth.ts); `/api/me/activity` exists (:141).
8. Live DB: 7 users (2 admin, 2 operator, 2 bot, 1 viewer). `auth_log` in schema with rows.
9. Web: no router role-guards; UsersPage self-checks `isAdmin`; sidebar fully visible to all.

## Objective

Every route and every UI surface enforces the settled matrix; VIEWER's
sensitive mask is server-side; a supervisor-visible audit log records who did
what across auth, runs, builds, cases, and device actions; entities carry
user attribution; cases/runs support assignment; the drive holder is visible.

Measurable completion:
- Role-boundary test file asserts every matrix cell (request-level, each
  role × each surface class → allow/deny as per matrix).
- A viewer account cannot read env values / users / settings; an operator
  cannot abort another's run; a supervisor cannot change roles; admin can do
  everything.
- Audit page shows events from all covered surfaces with actor + time.
- Runs page shows avatars (triggered-by user), cases assignable, active
  drive holder shown on the cockpit stage.
- `pnpm run check` green; server+web suites green; live drill with 4
  role accounts passes the matrix spot-checks.

## Scope

IN: supervisor role + hierarchy enforcement; viewer sensitive mask; audit
read surface + broader audit writes; user-FK attribution (+backfill);
assignment on cases/runs; drive-holder visibility; web nav guards +
capabilities endpoint; role-boundary tests.
OUT: comments/mentions, teams, per-team device isolation, bot visibility
constraints, SSO.

## Architecture

**Server**
- `Role` adds `'supervisor'`. Hierarchy const: `viewer < operator <
  supervisor < admin` (bot separate). `requireRole(...roles)` stays (explicit
  lists); add `requireRoleAtLeast(role)` for the hierarchy form. Admin
  implicit-allow already exists.
- **Capabilities endpoint** `GET /api/me/capabilities` — server computes the
  caller's permission set (matrix rendered to booleans); web never hard-codes
  role logic. Single source of truth: a `capabilitiesFor(role)` fn shared by
  the endpoint AND used directly by route guards where convenient.
- **Viewer mask** (server, in the route layer): env-var value redaction
  (`value: '•••'` + `masked: true`), 403 on `/api/users*`, settings/secrets
  status, device enrollment internals. Reads stay open otherwise.
- **Manual-session reads are operator+** (review F1): `/api/manual/:id/record`
  carries RAW typed text — credentials typed during exploratory sessions
  land verbatim in recording_json (verified live). The session LIST is
  already operator-gated (manual.ts:452); the record/frame/thumb GETs are
  not — gate them operator+ (403 for viewer). Runs stay viewer-readable:
  run_steps.evaluated_json keeps UNRESOLVED `${env.X}` refs (37/37 live
  rows) — no resolved-value leak on the run side (verified live).
- **Audit**: keep `auth_log`; add coverage writes on run play/abort, build
  trigger, case create/edit/delete, manual take-control/release, device
  actions, role-gated denials (403 with actor — FLOOD-CONTROLLED: at most
  one denial row per (actor, route) per minute, review F4; a looping client
  must not grow the log unboundedly). Read route `GET /api/audit`
  (supervisor+), paged, filter by actor/event/target.
- **Attribution FKs**: migration adds `triggered_by_user TEXT REFERENCES
  users(id)` (nullable) to runs; `created_by_user` to templates (nullable);
  backfill by joining `users.name` on the existing string columns where
  unambiguous (ambiguous/unmatched stay NULL — honest, no guessing). Writers
  stamp `req.user.id` going forward.
- **Assignment**: `templates.assigned_to TEXT REFERENCES users(id)` nullable
  + `runs.assigned_to_user` (copied from the case at play time). Routes:
  PATCH `/api/templates/:id/assign`, run-list filter `?assignee=` (a FILTER,
  never the boundary). Abort/delete boundary is the matrix's plain rule
  (review F3): supervisor+ may abort/delete ANY run; operator only their own;
  viewer never. Ownership predicate: `triggered_by` string match against
  `req.user.name` at first (T2, columns don't exist yet), upgraded to the FK
  with string fallback for legacy rows in T4 (review F2).

**Web**
- `/api/me/capabilities` drives: sidebar sections (users/audit/settings
  hidden per matrix), action buttons (run/drive/edit hidden for viewer),
  role-badge on the shell. Router guard: capability map fetched pre-nav;
  unauthorized → redirect + flash (not a blank page).
- Attribution UI: avatar chip (initials) + name on run rows, case cards,
  evidence sheet; assignment control on case editor (supervisor+assignable,
  operator self-assign); cockpit stage shows "driven by <name>" while a
  manual session is live.
- Users page: role picker gains supervisor; directory visible to supervisor
  (read-only role column), account ops for supervisor, role/approve/delete
  admin-only.

## Implementation stages

- **T1 — role core**: Role union + hierarchy + `requireRoleAtLeast` +
  `capabilitiesFor`; widen role validation in auth routes; seed-tests.
- **T2 — matrix enforcement sweep**: convert the 39 `requireRole` sites to
  the matrix's intent (operator sites stay; abort/delete get ownership
  checks — STRING match `triggered_by = req.user.name` for now, FK lands in
  T4 (review F2); ungated abort route today is a live hole — runs.ts:192 has
  no preHandler, a viewer-role user can abort right now); users routes split
  supervisor/admin tiers; viewer mask routes INCLUDING the manual-session
  read class: `/api/manual/:id/record|frame|thumb` → operator+ (review F1).
- **T3 — audit surface**: coverage writes (runs/builds/cases/drive/device/
  denials) + `GET /api/audit` + supervisor gate. Retention: none this round
  (auth_log unbounded already).
- **T4 — attribution + assignment migration**: nullable FK columns +
  name-match backfill + writers stamp ids + assign routes/filters +
  ownership predicate upgraded: FK match first, string fallback for legacy
  rows where backfill left NULL (review F2).
- **T5 — web capabilities**: endpoint consumption, sidebar/router guards,
  hidden actions, role badge, assignment control, avatar chips, drive-holder
  banner.
- **T6 — role-boundary tests**: matrix-asserting suite (4 roles × surface
  CLASSES — not sites; classes include the manual-session read class, F1),
  mask tests (viewer env value redaction), ownership tests (abort/delete,
  string path then FK path), audit gate tests; full suites + typecheck.
- **T7 — live drill**: 4 role accounts (viewer/op/supervisor/admin) against
  the real server: spot-check each boundary incl. viewer mask + supervisor
  audit view + assignment flow; commit + PR `feat/rbac-roles`.

## Edge and failure cases

- Session created before a role change keeps old capabilities until
  `/api/me/capabilities` refetch — acceptable (web refetches on nav; server
  gates are per-request and always fresh).
- Backfill ambiguity: two users with the same name → NULL (never guess);
  UI falls back to the raw string chip.
- Deleting a user with attribution/assignments: FK columns nullable, no
  cascade — rows keep `assigned_to` dangling → reads coalesce to "(deleted
  user)"; user delete stays admin-only and rare.
- Bot role: excluded from hierarchy checks entirely (bot passes only where
  explicitly allowed today — unchanged).
- The last admin cannot demote/deactivate themselves (guard on the route;
  classic lockout).

## Validation and acceptance checks

1. `server/test/rbac-boundaries.test.ts` — every matrix cell asserted.
2. Viewer mask: env values redacted in API + UI; users/settings 403/hidden.
3. Ownership: operator aborts own run 200, other's 403; supervisor both 200;
  viewer 403.
4. Audit: play/abort/build/case-edit/take-control rows appear with actor;
  supervisor reads; operator 403.
5. Migration: backfill leaves ambiguous NULLs; fresh writes stamp ids.
6. `pnpm run check` green; full server + web suites green.
7. Live drill with four role accounts against the real DB passes.

## Rollout / handoff

PR `feat/rbac-roles` on Lionidas. Existing rows map 1:1 (no data migration
beyond nullable FKs + backfill). Users page documents the new tier to the
team. Future features: the plan template gains a "user-DB relationship"
requirement (FK attribution + role gates + capabilities entry) — recorded in
the brainstorm as the standing convention.
