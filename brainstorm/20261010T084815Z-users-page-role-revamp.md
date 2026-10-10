# Users page revamp — organized by roles

- Source prompt: "I'd like to revamp the 'users' page based on their roles. Concept it. Then do the sketches and run the local server for the sketches as usual."
- Created: 2026-10-10T08:48:15Z
- Status: Direction selected (sketch round 031 running)

## Goal and context

The users page predates the RBAC round and has drifted from the truth:

- `web/src/pages/UsersPage.vue` is a flat admin-only table (user / role / source / status / last login / actions). Role is a bare `<select>` column.
- The role `<select>` (both per-row and the provision form) offers **viewer / operator / admin only — `supervisor` is missing** even though the role exists and the DB has one (real counts: 3 admin, 1 supervisor, 5 operator, 2 viewer, 2 bot = 13 accounts).
- The page gates the whole directory on `isAdmin`, but the RBAC matrix gives **supervisor `readUsers: true` + `manageAccounts: true`** (create / reset pw / deactivate) — supervisors currently fall through to the non-admin "your activity" self-view instead of the directory with reduced actions.
- Admin-only powers (role assignment, approve, delete, settings) are enforced at the route level (`auth.ts:162-187`) but the UI never shows the boundary.

Interpretation (not user-confirmed): "revamp based on their roles" = role becomes the organizing principle of the page — grouping, capability visibility, and per-role action rights — not just a re-skinned table.

## Confirmed inputs and decisions

- RBAC matrix is live (`server/src/auth/capabilities.ts`): viewer / operator / supervisor / admin / bot with capabilities incl. `manageAccounts` (supervisor+) and `adminOnly` (roles, approve, delete, settings).
- Route gates: GET/POST/PATCH `/api/users*` = supervisor+; role field on PATCH and admin-role creation = admin-only.
- Real DB role census (2026-10-10): admin 3 · bot 2 · operator 5 · supervisor 1 · viewer 2.
- Design system: Axiom tokens, grouped-list anatomy (one bordered table, one sticky thead, `.a2-group-head` in-flow rows), design previews mandatory (≥3 variants, real tokens, served + verified), sketches committed as the build spec.

## Exploration

**Gap with real effect**: the page must now serve two stances (admin = full, supervisor = directory minus role/approve/delete) and five roles whose meaning is invisible today.

**Variants (sketch round `031-users-roles`, axis = structure):**

| | Stance | Idea |
|---|---|---|
| **A — role-grouped directory** | house pattern | The settled grouped-list anatomy applied here: ONE `.a2-list` table, sticky thead, a collapsible `.a2-group-head` per role (count + capability digest), role column deleted from rows (the app-column rule). Stance switch admin ⇄ supervisor hides role selects / approve — the RBAC boundary made visible. |
| **B — roster × capability matrix** | permission center | Flat roster + a capability matrix (capabilities × roles, ● / –). Clicking a user highlights their role's column — pick a person, see their powers. Literal "based on roles" but introduces a second table pattern the four settled list pages don't have. |
| **C — flat table, role chips** | control | Today's flat table, minimal diff: role becomes a chip with hover capability summary, supervisor option added to the selects, supervisor stance disables admin-only controls. Isolates whether grouping is needed at all. |

**Recommendation (proposal, not accepted):** **A**. It composes the already-settled grouped-list anatomy (a fifth list page should converge, not invent a parallel structure), makes role the organizing principle exactly as asked, and encodes the supervisor stance natively. B's matrix is genuinely useful but belongs (if anywhere) as a legend surface, not the page's spine. C is the honest no-mechanism out but does not read as a revamp.

## Open questions

1. **Default stance for supervisors** — land on the grouped directory with admin-only actions hidden (recommended), or keep them on the self-view with a "directory" toggle? Changes the page's default render for 1 real user today.
2. **Capability matrix surface** — is the terse digest on each group head enough (recommended), or do you want B's full matrix as a collapsible legend section on the page?
3. **Bot accounts** — keep them in the directory as a collapsed-by-default group (recommended), or hide them entirely?

## Next step

Serve + verify the three variants (port 8791), present head-to-head with previews, user picks (or hybridizes). The picked variant becomes the build spec; implementation round branches + PRs as usual, sketch + brainstorm committed with it.
