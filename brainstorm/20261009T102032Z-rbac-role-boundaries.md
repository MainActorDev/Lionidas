# RBAC round: ADMIN / SUPERVISOR / OPERATOR / VIEWER with clear boundaries

- Source prompt: "High-level operations must be related to the users DB. I also
  want to update the user's role to have ADMIN, SUPERVISOR, OPERATOR, and
  VIEWER. ADMIN is the highest authority which can do everything and VIEWER is
  the lowest authority. Each of these roles, must have a clear boundary of
  what they can see and do in the project. Next to be developed feature must
  also think about the relationships to the user DB."
- Created: 2026-10-09T10:20:32Z
- Updated: 2026-10-09T10:41Z (operator answered Q1–Q3; added multi-user
  interaction as a fourth scope area)
- Updated: 2026-10-09T10:52Z (operator: "go with the recommendation" —
  interaction scope = (a)+(b)+(c-partial); Q2 resolves via assignment link)
- Status: Direction selected — all material questions closed; plan Ready
  (plans/20261009T102032Z-rbac-role-boundaries-plan.md)

## Goal and context

Introduce a proper 4-tier human role model (ADMIN > SUPERVISOR > OPERATOR >
VIEWER) where each role has a **defined, enforced boundary** of what it can
see and do — both server-side (routes) and client-side (navigation, UI
surfaces). Every future feature must declare its user-DB relationships from
the start (owner/actor attribution on entities, role gates on surfaces).

User's direct statements:
- Four roles: ADMIN, SUPERVISOR, OPERATOR, VIEWER; ADMIN highest, VIEWER lowest.
- Each role: clear boundary of see/do in the project.
- High-level operations must relate to the users DB.
- Future features must think about user-DB relationships.

Interpretation (mine, not confirmed): "high-level operations related to the
users DB" = who performed what (runs, manual sessions, case edits, evidence)
should be attributed to user rows, and administrative operations (user
management, role changes) operate on the users DB.

## Confirmed inputs and decisions

- Role set: ADMIN, SUPERVISOR, OPERATOR, VIEWER (user, 2026-10-09).
- ADMIN = highest (everything); VIEWER = lowest.
- **SUPERVISOR = QA lead / manager** (user, 2026-10-09: "Supervisor is like
  the QA lead or manager. Operator is the QA."). Shape confirmed: people +
  oversight powers.
- **VIEWER = read everything EXCEPT sensitive info** (user: "sees everything
  read-only without sensitive information access"). Sensitive = env var
  values, secrets status, user management, tokens, device enrollment
  internals — exact list drafted in the matrix below.
- **Audit log surface is IN scope** (user: "Include it").
- **Multi-user interaction is a scope area** (user: "we also need to think
  further how users interaction to each other. Because the project will
  absolutely be many users.").

## Current state (verified in source 2026-10-09)

- `Role = 'viewer' | 'operator' | 'admin' | 'bot'` (auth/users.ts:9). Viewer
  exists as a type but the enforcement story is thin.
- Enforcement is **write-gate only**: 30 route sites `requireRole('operator')`
  + 9 sites `requireRole('admin')` (users mgmt, overlay-offset, setup, one
  manual route, runs admin op). Reads: `requireUser()` — **any signed-in user
  can READ everything** (hard read gate at index.ts:98 only requires a
  session). Bots pass as operators.
- Admin implicit-allow: `requireRole` lets `admin` through any gate
  (roles.ts:113) — an existing total-ordering precedent for ADMIN=everything.
- users DB: 7 rows (2 admin, 2 operator, 2 bot, 1 viewer). No per-entity
  ownership; `triggered_by` on runs is a free-text operator name, NOT an FK.
- Web: no route guards by role; pages self-check (`isAdmin` on UsersPage).
  Sidebar shows everything to everyone.

## Exploration

### Proposed permission matrix (SETTLED — operator-confirmed 2026-10-09)

| Surface | VIEWER | OPERATOR (QA) | SUPERVISOR (QA lead) | ADMIN |
|---|---|---|---|---|
| See runs / evidence / cases / suites / devices / builds | ✅ | ✅ | ✅ | ✅ |
| Run cases & suites (play, matrix) | ❌ | ✅ | ✅ | ✅ |
| Manual drive (take control, input verbs) | ❌ | ✅ | ✅ | ✅ |
| Device actions (boot/restart/shutdown/uninstall/install) | ❌ | ✅ | ✅ | ✅ |
| Author/edit cases, folders, screens, env scenarios | ❌ | ✅ | ✅ | ✅ |
| Env var VALUES (create/edit/READ values) | ❌ masked | ✅ | ✅ | ✅ |
| Builds: trigger, connect repo | ❌ | ✅ | ✅ | ✅ |
| Forge scenarios / baselines governance | ❌ | ✅ | ✅ | ✅ |
| Abort runs | ❌ | own | **any** | ✅ |
| Delete/purge runs & evidence history | ❌ | ❌ | **own-area** (runs they supervise) | ✅ |
| Users DB: view directory | ❌ | ❌ | ✅ | ✅ |
| Users DB: create / reset password / deactivate | ❌ | ❌ | ✅ | ✅ |
| Users DB: change roles, approve, delete | ❌ | ❌ | ❌ | ✅ |
| Audit log (who did what) | ❌ | ❌ | ✅ | ✅ |
| Settings: secrets status, setup, config | ❌ | ❌ | ❌ | ✅ |
| Notifications / activity feed | ✅ | ✅ | ✅ | ✅ |

VIEWER's sensitive-mask (server-enforced): env var values redacted,
`/api/users*` 403, secrets/config status 403, device enrollment internals
403. Everything else readable.

### Multi-user interaction (NEW scope area — exploration)

The project will have many users; interactions to consider (DRAFT options,
none chosen):

a) **Attribution + visibility**: every entity shows WHO created/ran it
   (avatar chips on runs, cases, evidence). Cheapest; builds on the FK work.
b) **Assignment**: cases/runs/suites assignable to a user (QA picks up work,
   supervisor sees team workload). Adds `assigned_to` columns + UI filters.
c) **Handoff & locking**: manual-drive lease shows the holder; case editing
   gets soft locks (edit-conflict warning). Prevents two QAs clobbering.
d) **Comments/mentions on runs & cases** (QA-to-QA communication in-app).
e) **Teams**: users grouped (team A sees team B's runs but drives only team
   A's devices) — heavier; only if cross-team isolation is real.

Recommendation (proposal, not accepted): this round ships (a) fully + (c)'s
drive-holder visibility (already half-true: manual sessions show the
operator) + assignment (b) as the QA-workflow backbone. Comments (d) and
teams (e) defer to a later round — they're products of their own.

### Users-DB relationships (the "next features must relate" rule)

Current attribution is name-strings (runs.triggered_by, manual_sessions.
operator, templates.created_by). Proposal: a migration adding user FK
attribution where missing (nullable user_id columns + backfill by name
match), and a convention that every new entity table carries `created_by
user_id` + every new route declares its role gate next to its registration.
The plan should include a "user-DB relationship" section template for future
plans (brainstorm/plan skill artifacts).

### Migration & rollout shape

- `Role` union + DB CHECK constraint widen (supervisor insert); existing rows
  map 1:1 (no renames needed — admin/operator/viewer already exist).
- requireRole grows hierarchy-aware overload (`requireRole.atLeast(...)`) so
  "operator-or-above" reads naturally; explicit-list form stays for oddballs.
- Web: `/users` nav visibility (supervisor+), route guard map, page-level
  capability flags from a `/api/me` capabilities endpoint (single source of
  truth — server computes, web renders).
- Tests: role-boundary test file enumerating the matrix (each cell = a
  request assertion), plus UI guard unit tests.

## Open questions

1. ~~Interaction scope~~ — CLOSED: operator accepted the recommendation
   (attribution + assignment + drive-holder visibility; comments/teams
   later).
2. ~~Supervisor "own-area" definition~~ — CLOSED by the same decision:
   "supervise" rides the assignment link (runs assigned to their team
   members / unassigned team runs), not a blanket "any operator run".
3. Bots: out of scope (default stands — pipeline-only, no visibility
   constraints this round).

## Next step

All questions closed → `hms-plan-from-brainstorm` for the RBAC round
(matrix + viewer mask + audit surface + attribution/assignment/holder).
