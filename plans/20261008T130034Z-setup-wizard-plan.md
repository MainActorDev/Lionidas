# Plan — host-side first-run setup wizard (/setup)

- Source: brainstorm/20261008T130034Z-setup-wizard.md (all 3 open questions closed by "Go with your recommendation", 2026-10-08)
- Created: 2026-10-08T13:29:00Z
- Status: Ready for implementation
- Branch: `feat/setup-wizard` off `main`

## T0 — boot-time stamp backfill (upgrade path)

Existing installs (pre-wizard versions) have an admin password hash but no
`setup_completed_by` stamp. At boot (migrations phase), if any LOCAL user
(auth_source='local') has a password hash ⇒ write the stamp
(`setup_completed_by=<that user's email>`, `setup_backfilled=1`). Idempotent.
Effect: for EVERY existing install, /setup is inert from the first boot after
upgrade — no window, no behavior change.

## T1 — setup state model + public routes (server)

1. **`setup.ts` module** (`server/src/auth/setup.ts`):
   - `needsSetup(db)`: true iff `schema_meta` has no `setup_completed_by` stamp AND no local user has a password hash. (ADMIN_BOOTSTRAP_PASSWORD-minted hash ⇒ stamp auto-written at seed time.)
   - `completeSetup(db, email)`: writes `setup_completed_by=<email>` + `setup_completed_at=<ISO>`; idempotent.
   - `setupModeOff()`: `process.env.CRUCIBLE_SETUP_MODE === 'off'` ⇒ wizard disabled (headless env flow only).
   - Unit tests: fresh DB needsSetup true; stamp ⇒ false; existing password hash ⇒ false; mode off ⇒ disabled.
2. **Routes** (`server/src/routes/`, admin-free public only pre-setup):
   - `GET /api/setup/state` — public when needsSetup, 404 after stamp. Returns `{ needsSetup, reason?: 'no_admin_password' }`.
   - `POST /api/setup/admin` — public ONLY while needsSetup; after stamp ⇒ 404. Body: `{ email, name?, password }`. Validates email + password (existing policy min length). Creates/updates admin user with hash, **deactivates the `admin@lionparcel.com` seed row** if email differs (Q1 rec: deactivate), stamps setup complete. Returns `{ ok: true }`.
   - Rate-limit POST (reuse existing limiter, if any; else 10/min/IP simple in-memory) as a pre-setup window hardening.
3. **Seed interplay** (`server/src/auth/users.ts`): when ADMIN_BOOTSTRAP_PASSWORD set ⇒ mint hash AND write the setup stamp (headless completes setup automatically). The generated-password-print path stays as fallback when setup skipped via CRUCIBLE_SETUP_MODE=off (unchanged behavior there).
4. **Recovery (no reset CLI exists — verified 2026-10-08):** add `lionidas admin reset-password <email>` to the existing CLI (`server/src/cli/index.ts`). Operates directly on the DB file (server can be stopped): prints a one-time password, operator sets a new one on first login. Covers the sad path where the only admin's password is lost — without reopening the wizard.
5. **Safety guards (defense in depth, Jenkins-style):**
   - **Setup token**: on boot when needsSetup, generate a 128-bit random token, store in `schema_meta`, print to console (`[setup] claim token: XXXX-XXXX-XXXX-XXXX`). `POST /api/setup/admin` requires it. `GET /api/setup/state` NEVER returns it — only the machine console has it. Token is deleted on completion; re-printed (same token) on restart while setup remains open. Headless flow unaffected (`ADMIN_BOOTSTRAP_PASSWORD` bypasses the wizard entirely).
   - **Origin check**: POST accepts same-origin (or absent Origin for curl) only + JSON content type enforced — blocks cross-site/CSRF writes during the window.
   - **Single-winner transaction**: stamp check + user write + stamp write inside one `BEGIN IMMEDIATE` — two racing tabs produce one admin, one 404.
   - **Rate limit on BOTH token guesses and POSTs** (10/min/IP, module-level Map).
   - **Audit**: completion stamp records email + ISO timestamp (already); console logs the claim event.

## T2 — readiness probes (server, authed)

`GET /api/setup/readiness` (admin session; after setup it lives under settings):
- rows: github token set (env), jira token set (env), repos dir writable, packages dir writable, xcodebuild -version probe (one-shot, cached 5 min in module memory), xcbuddy on PATH (`which` incl. `~/.local/bin`), CRUCIBLE_SMOKE state (explicit). Each row: `{ key, label, state: 'ok'|'fail'|'skip', detail }`.
- `state:'skip'` used when the probe cannot apply (e.g. no simulators booted for smoke check) — honest, not green.
- Unit tests with fake PATH manipulation for xcbuddy probe; xcodebuild probe mocked via seam env `CRUCIBLE_FAKE_XCODEBUILD` (used by tests) — or skip probe in test env (`NODE_ENV=test` ⇒ skip xcodebuild/xcbuddy, rows return 'skip').

## T3 — web: /setup route + wizard page + login link

1. **Router** (`web/src/router.ts`): add `/setup` route (public). Guard: fetch `/api/setup/state`; if `needsSetup=false` ⇒ redirect `/login` with notice. If `CRUCIBLE_SETUP_MODE=off` (state 404s) ⇒ redirect `/login`.
2. **SetupPage.vue** (new, env-page anatomy, single card, 2 steps):
   - Step 1: welcome copy ("Create the administrator account for this Lionidas instance."), fields email/name/password/confirm, submit POST `/api/setup/admin`. Client-side validation + server errors surfaced.
   - Step 2: success → auto-redirect to `/login` with toast "setup complete — sign in".
   - Skipped/env-off path: informational message + link to login.
   - Style: existing design tokens (a2-list / PageHeader), no new CSS system.
3. **LoginPage.vue**: when `/api/setup/state` reports needsSetup, show link "first run? set up this instance → /setup" (replaces the current "first time? ask an admin" copy in that state only).
4. **SettingsPage.vue**: new "environment readiness" section — fetch `/api/setup/readiness`, render ✓/✗/skip rows with details; "re-check" button. (Q3 rec: Settings section, `/setup` redirects to `/settings` when done.)

## T4 — tests + drills

1. Server tests: setup state machine (fresh/stamped/bootstrap-hash), POST admin (validation, deactivation of seed row, 404 after stamp), readiness rows (ok/fail/skip), login works with wizard-created admin.
2. Web tests: router guard (needsSetup true/false), SetupPage renders + submits, LoginPage link state-dependent, SettingsPage readiness section renders.
3. Live drill (mandatory): fresh temp DB via `CRUCIBLE_DB` env → server boots → `GET /api/setup/state` needsSetup=true → `/setup` renders → create admin `setup-drill@local` → stamp written → POST admin now 404 → login as wizard-created admin → settings readiness rows honest (both tokens ✗ on clean env) → screenshots for PR.
4. Gates: `pnpm typecheck` + `pnpm test` (server+web) + live drill + vision pass.

## Out of scope

- Agent pairing (container phase), config writing beyond admin account, user invitations, any Docker work.
