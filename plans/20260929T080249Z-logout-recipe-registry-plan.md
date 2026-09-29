# Logout recipe registry + settle login duality (plan)

- Source brainstorm: `brainstorm/20260929T080249Z-logout-recipe-registry.md` (+ Decisions log — all four questions answered 2026-09-29)
- Status: Ready (rev 2 — review F1-F6 applied; review `reviews/20260929T080249Z-logout-recipe-registry-plan-review.md` verdict: Needs revision → corrected)
- Created: 2026-09-29

## Decision log (provenance)

| # | Decision | Source |
|---|---|---|
| 1 | **B** — app-level `app_logout` table (one recipe per bundle), not a per-screen column | operator, 2026-09-29 |
| 2 | **Settle the login duality now** — one canonical store for login recipes | operator, 2026-09-29 |
| 3 | **Migrate the 2 inline cases** (`tnc` tpl_5ad494cb, `privacy policy` tpl_bad9845a) to the bare registry form | operator, 2026-09-29 |
| 4 | **Ship the UI panel** — LogoutFlowPanel beside the login one | operator, 2026-09-29 |
| 5 | Bare-verb semantics: `ensure logout: {}` resolves the app recipe; save-time error if none; **inline recipe still valid and WINS over the registry** (case-level override) | brainstorm proposal, operator took the package ("B/…/yes/yes") — flagged agent-default |
| 6 | `back:` stays case-owned (genuinely per-case: where the case's first step starts) | verified distinct concern in brainstorm; uncontested |

## Objective and completion conditions

Logout joins login as an app-level registry procedure: one editable recipe per app, cases referencing it with a bare verb, discoverable UI. The login recipe duality (two stores) collapses to one. Done when:

1. `app_login` is the ONLY login recipe source at playback; `app_screens.login_json` is gone from schema code paths (column dropped, guarded) with existing data migrated.
2. `app_logout` table exists; `/api/apps/:bundle/logout` CRUD works; LogoutFlowPanel edits it (form ↔ yaml doc, mirroring LoginFlowPanel).
3. `ensure logout: {}` (bare) parses, validates (save-time error when the app has no recipe and no inline override), round-trips; inline form unchanged and still passing.
4. The 2 cases migrated; tnc runs green on 30B28173 via the registry recipe (both preflight paths: already-logged-out AND real logout).
5. Full suite green; web build clean; signature scan clean.

## In / Out of scope

**In:** grammar bare form; `app_logout` table + routes; LogoutFlowPanel; playback resolution (registry default, inline override); login settlement (drop `app_screens.login_json`, migrate data, single read path); migration of 2 cases; docs note in `docs/features/`.
**Out:** per-screen logout columns; multi-logout apps (one recipe per bundle); editing recipes per-case in the case editor UI; changing `back:`/`via:` semantics; localization.

## Verified facts (code survey 2026-09-29)

- Login duality is REAL and code-level: `app_login` (per-bundle; what the panel edits via `/api/apps/:bundle/login`) is read at playback.ts:1251-1271 and WINS; `app_screens.login_json` (per-screen) is the read-only fallback at :1272-1290 when `screen:` is present. Both stores currently hold the same recipe for this app (DB check).
- `app_screens.login_json` is written only by the registry yaml import/export route (app-screens.ts:47-51); the screens-page editor never edits it; LoginFlowPanel writes only `app_login`.
- ensure-logout executor: playback.ts:1517+ (cfg = button/stay/confirm/via/back); `back:` added 2026-09-29 (commit e8d9b97).
- Inline ensure-logout recipes: exactly 2 templates, identical bodies (`account_logout_button` / `account_logout_stay_button` / `account_logout_confirm_button` / via `ic_tabbar_account_inactive`, tnc also has `back: Home`).
- LoginFlowPanel shape (LoginFlowPanel.vue): props `{bundle, screens}`, formToDoc/docToForm yaml sync, save → `PUT/POST /api/apps/:bundle/login`, delete → DELETE. `app_login` schema: bundle_id PK, login_json, updated_at, revision.
- ScreensPage bundle header (:446-452): mini-acts `login flow` / `+ screen` / `yaml`.
- Guarded-ALTER precedent: schema.ts:594 adds `app_screens.login_json` (ironically) — same pattern supports `CREATE TABLE IF NOT EXISTS app_logout` + dropping the column via table-rebuild (SQLite cannot DROP COLUMN pre-3.35; better-sqlite3 bundles ≥3.44 so `ALTER TABLE … DROP COLUMN` is available — verify at build time, else rebuild pattern).

## Architecture

**Canonical login recipe:** `app_login` (per-bundle) — already the winner at playback and the only thing the UI edits. Settlement = remove the `app_screens.login_json` fallback read (playback :1272-1290 collapses), remove the column from writes (import/export route), migrate any screen-level data into `app_login` where `app_login` is missing (guarded INSERT SELECT), drop the column (guarded; ignore failure on old SQLite).

`ensure login: screen: X` after settlement: `screen:` becomes the verify-screen only… NO — decision 5 semantics: `screen:` form was the OLD reference; with the app procedure canonical, `ensure login: screen: auth` resolves the APP recipe (same as today's precedence) and `screen:` is accepted-but-ignored for back-compat (the 2 logged-in cases keep running unchanged). Document in the grammar error text.

**Logout recipe (new):** `app_logout(bundle_id PK, logout_json, updated_at, revision)`; `logout_json = {button, stay, confirm, via}` (same keys the executor consumes; `back` never rides the recipe — case-owned). Routes: `GET/PUT/DELETE /api/apps/:bundle/logout` mirroring the login routes.

**Grammar:** `ensure logout:` with EMPTY body (or `{}`) → `ensureLogout: {recipe: 'app'}` marker (inline keys absent). Validation at save: bare form + app has no `app_logout` row AND case app unknown → error "register the app's logout flow on the screens page (or inline button/confirm)". Inline keys present → today's validation; bare + inline keys mixed → error (one form per step).

**Playback:** cfg resolution — if `cfg.recipe === 'app'`: read `app_logout` (fail-closed step error naming the fix if absent); else inline as today. `back:` reads from the step regardless of source. `via` may come from the recipe.

## Implementation stages (TDD)

### Stage 1 — grammar (shared/src/case-yaml.ts)
RED→GREEN: bare `ensure logout:` + `ensure logout: {}` parse to the recipe marker; emitter renders bare form for marker, inline form otherwise (round-trip); mixed bare+inline keys → error. Validation predicate threading (review F2): `parseCaseYaml(text, opts?: { hasLogoutRecipe?: (appBundleId: string | null | undefined) => boolean })` — takes NO opts today (case-yaml.ts:96). Thread it through ALL FOUR call sites: PUT yaml (templates.ts:865), validate endpoint (:805), import (:445), editor preview if separate. Default when opts absent = SKIP the bare-no-recipe error (back-compat for tests and other callers). Existing emitter byte-parity fixtures keep passing (inline forms untouched).

### Stage 2 — storage + settlement (server/src/db/schema.ts, routes/app-screens.ts, playback.ts)
1. `CREATE TABLE IF NOT EXISTS app_logout(...)` in the M1 block.
2. Login settlement — ATOMIC UNIT (reviews F1+F3; the settlement is already HALF-DONE in the wild: shared registry schema rejects `login` on screens, `app_login` already wins at playback — the work is the REMAINDER): (a) data migration `INSERT INTO app_login(bundle_id, login_json, updated_at, revision) SELECT app_bundle_id, login_json, 0, 1 FROM app_screens WHERE login_json IS NOT NULL AND app_bundle_id NOT IN (SELECT bundle_id FROM app_login)` (guarded, idempotent); (b) remove the playback `screen:` fallback branch (:1272-1290; `screen:` accepted, doc'd, ignored); (c) DELETE the per-screen login routes `/api/apps/:bundle/screens/:id/login` GET/PUT/DELETE (app-screens.ts:200-238 — dead-but-live writes to the doomed column; zero web consumers verified); (d) update the registry-replace snapshot block (:47-51): drop the login snapshot/restore entirely — app-level recipes no longer ride registry yaml, and the INSERT names login_json (un-edited + dropped column = every registry import 500s); (e) guarded `ALTER TABLE app_screens DROP COLUMN login_json`. (a)-(e) ship in ONE migration block + same commit — no server state exists where the column is dropped but the routes/snapshot still reference it. Acceptance: registry yaml import/export round-trip test passes POST-drop; DROP COLUMN confirmed safe on SQLite 3.49.2 (verified live; hedge try/catch stays but the ancient-SQLite caveat cannot fire — review F6).
3. `app_logout` CRUD routes beside the login ones (app-screens.ts, cloning the app-level login triple :239-278 incl. revision-guard 409 on stale PUT). NEW shared validator (review F4): `validateAppLogout` in shared/src/app-screens.ts beside `validateAppLogin` — button/confirm non-empty strings, stay/via optional strings, unknown keys rejected; PUT runs it (422 on errors).
4. Tests: settlement (screen-level row migrates once; app_login wins; column drop idempotent on re-migrate); logout routes CRUD + 404 GET when absent.

### Stage 3 — playback resolution (server/src/manual/playback.ts)
RED→GREEN (fake-alloy harness): bare `ensure logout` + seeded `app_logout` row → preflight uses recipe values (assert on dispatched press targets); no row → step fails naming the fix; inline step unaffected; `back:` from step works with recipe-sourced via. Both exit paths (already-out with back-tap; real logout) — reuse the tnc live-drill matrix.

### Stage 4 — UI (web/src: ScreensPage.vue, LogoutFlowPanel.vue new)
Clone-and-trim LoginFlowPanel: fields button/stay/confirm/via; form ↔ yaml doc (`logout:` mapping); save/delete via the new routes; no verify section (logout success = session gone, verified by the executor). PARITY (review F5): revision-guard behavior identical to login — load returns revision, save sends it, 409 stale → reload-and-retry message. ScreensPage header gains `logout flow` mini-act beside `login flow`. `pnpm run build` clean.

### Stage 5 — migrate cases + seed + docs + full gate
1. Seed `app_logout` for the int-dev bundle from the shared recipe body.
2. Migrate tnc + privacy policy to bare form (PUT yaml; keep `back: Home` on tnc).
3. `docs/features/` note: session preflights (ensure login/logout; recipes are per-app registry entries; inline override wins).
4. Full gate: vitest under nvm 24.12.0, web build, signature scan (doc wording care).
5. Live drill on 30B28173: tnc via registry recipe — already-logged-out path AND forced-logged-in path (run the logged-in case first, then tnc) → both green.

### Branch / PR
Fresh branch `feat/logout-recipe-registry` off synced main (PR #10 may still be open — base on main, not the narrate branch; `back:` from e8d9b97 is REQUIRED → if #10 unmerged at build time, base on its branch and note the dependency, or wait for merge. Ask operator if #10 is unmerged when starting.)

## Edge and failure cases

- Old DB (pre-settlement) → guarded migration; re-running migrate is idempotent (NOT IN guard; CREATE IF NOT EXISTS).
- `screen:` form of ensure login post-settlement → resolves app recipe; if `app_login` missing for the bundle → step fails "register the app's login flow" (today: falls back to screen column — after settlement the data moved, so the message is the honest successor).
- Bare logout + recipe deleted later → step fails naming the fix (fail-closed), never silent pass.
- Recipe edited mid-suite → next run reads fresh (resolution at run start, same as login).
- SQLite DROP COLUMN unsupported (ancient better-sqlite3) → catch + leave column orphaned (unused) + warning log; not a failure.

## Validation and acceptance

| Check | Pass condition |
|---|---|
| Grammar tests | bare/inline parse+emit round-trip; mixed → error; bare w/o recipe predicate → save-time error text |
| Settlement tests | screen→app migration once; app_login precedence kept; column dropped (or warned); re-migrate idempotent |
| Playback tests | recipe-driven preflight (press targets match recipe ids); absent recipe fail-closed; inline override wins |
| Routes | app_logout CRUD; login routes untouched |
| UI | panel saves/loads/deletes; build clean |
| Migration | 2 cases bare; tnc green both preflight paths live |
| Full gate | suite green (+N), build clean, scan clean |

## Rollout / handoff

Single PR; guarded migrations only (new table, one data move, one column drop); no env/config changes; operator merges. Docs updated in the same PR (session-preflight feature note) as a separate commit.
