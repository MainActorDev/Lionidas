# Users page role revamp — build plan (round 031)

- Branch: `feat/users-page-roles` (from main `ef07124`)
- Spec: `sketches/031-users-roles/a2-head-refined/` (picked + refined) · brainstorm `20261010T084815Z`
- Status: implementing

## Decisions encoded (user, 2026-10-10)
1. Page organized BY ROLE: grouped directory (house grouped-list anatomy), not a flat table.
2. Supervisor = admin on the users domain EXCEPT: cannot assign the admin role (cap: highest it assigns is supervisor) and cannot re-role admin accounts (locked rows).
3. Create form hidden until the `create user` header button (supervisor+ only, `readUsers` capability).
4. Group head: aligned grid (caret | role 90px | capability digest 1fr wraps | health marks | count); bot group collapsed by default.

## T1 — server (auth.ts)
- **Widen PATCH**: role + approved changes allowed for any `manageAccounts` actor (supervisor+) with the cap:
  - `b.role === 'admin'` and actor not admin → 403 (existing POST rule, mirrored).
  - target row `role === 'admin'` and actor not admin → 403 (admin accounts are out of supervisor reach — demote included).
- **Add DELETE `/api/users/:id`** (depicted in the picked sketch; no route exists):
  - supervisor+; supervisor cannot delete admin rows (same cap); cannot delete self; cannot delete the bootstrap admin (`usr_admin01`).
  - Cascade: `sessions`, `device_pins` for the user. Audit row `user_deleted` before removal.
- Tests (extend roles suite): supervisor promote op→sup 200 · promote →admin 403 · re-role admin row 403 · approve 200 · create non-admin 200 / admin 403 (existing) · delete non-admin 200, admin-row delete 403 at supervisor, self-delete 400, cascade verified.

## T2 — web UsersPage.vue (wholesale replace per full-page-redesign rule)
- Directory mode (`me.role` supervisor+): PageHeader (`users` · badge me.role · `create user` btn reveals provision form), ONE `.a2-list` table: sticky thead (user/role/source/status/last login/actions), per-role `.a2-group-head` grid rows, users grouped admin→supervisor→operator→viewer→bot, bot collapsed default.
- Role cell: bot = text; admin rows locked text for non-admin viewers; else select (options viewer/operator/supervisor + admin only when me=admin).
- Actions: approve (pending only) · reset pw · deactivate/reactivate · delete. Status cell: pending ember / active / deactivated; inactive rows dimmed; `you` marker.
- Self mode (below supervisor): port existing self-view + API tokens + CLI approval unchanged (replacement rule — port or name the drop). Tokens section stays for ALL roles (account-level).
- Old flat directory + always-on provision card deleted.

## T3 — gates
- `tsc` 0 server+web; server roles/users suites green; web 40/40.

## T4 — live drill (real server 9230, admin `drill@local` + supervisor `rbacsup@rbac.test`)
- API: supervisor create tmp user 200 · promote to admin 403 · promote op2→supervisor then revert · approve 200 · re-role admin row 403 · delete tmp 200. Admin delete leftovers 200.
- UI: login as supervisor → grouped page renders, selects capped (no admin option), admin rows locked; login as admin → full selects. Vision/DOM pass vs sketch structure.

## T5 — PR
- Commit docs (plan) + server + web separately; PR to main; live-verified notes in description.
