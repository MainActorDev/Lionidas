# Managed env values + screens-held login recipe — implementation plan

- Source brainstorm: `brainstorm/20260926T122856Z-managed-env-and-screens-login-recipe.md`
- Created: 2026-09-26T12:32:45Z
- Status: Ready (rev 2 — review findings F1–F8 applied 2026-09-26; see
  `reviews/20260926T122856Z-managed-env-and-screens-login-recipe-plan-review.md`)

## Decision log

| # | Decision | Provenance |
|---|---|---|
| D1 | Split selectors vs values: screens hold the login selector recipe, env holds values | Operator, 2026-09-26: "Okay split." |
| D2 | Env values must be a managed first-class surface | Operator, 2026-09-26: "But I want env values also managable." |
| D3 | Scope chain = **global + app + plan**; no per-suite scope for now | Operator, 2026-09-26: "global + app + plan is enough for now" |
| D4 | Secret handling = masked + write-only read-back (elaboration below was accepted as the working model; encryption NOT in scope) | Operator: "Elaborate in plain English" → explanation delivered; plan proceeds with masked write-only as specified, plaintext-at-rest accepted for dev drill creds |
| D5 | UI = a **dedicated /env page**, not Settings | Operator, 2026-09-26: "a dedicated 'env' page (not Settings)" |

### D4 in plain English (as delivered and applied)

The database still stores the secret's real text, same as today's traffic logs — anyone who can
read the sqlite file can read it. What changes is the **API and UI behavior**: a value marked
`secret` is never sent back to the browser after it is saved. The list view shows `•••••` and a
"set" badge; editing means typing a replacement (you can't view the old one). This stops the
casual leak path — the web UI, API responses, screen shares — without adding encryption
machinery. Stronger at-rest protection (OS keychain, field encryption) stays out of scope.

## Objective and completion conditions

Logged-in test cases stop carrying their own selector sets and credential values; env values
become settable, inspectable (metadata), and deletable from a dedicated UI page; playback
resolves everything centrally. Done when:

1. `ensure login: { screen: auth, phone: '${env.DRILL_PHONE}', password: '${env.DRILL_PASSWORD}' }`
   parses, emits, round-trips, and **plays green on the drill sim** against the twins
   (post-VPN).
2. A value set once on the /env page (scope app) suffices for `POST /api/templates/:id/play`
   with an **empty body env**; unsetting it makes the same play fail with `missing env: DRILL_PHONE`
   (asserted in a clean state — no same-key GLOBAL var shadowing, review F8). The same
   empty-body outcome must hold **via a PLAN play** (gates the planId threading, review F4).
3. Secrets are masked in every GET response; the value column never returns.
4. `pnpm run check` green; existing 984 tests unbroken.

## Out of scope

- Per-suite env scope (D3), encryption at rest, OS keychain (brainstorm option C)
- Template-editor env hints (deferred; /env page first)
- ios-consumer-intl app changes (none needed)

## Stage 1 — schema + storage

**1.1 `env_vars` table** (guarded, idempotent — follow schema.ts `has()` convention at :485):

```sql
CREATE TABLE IF NOT EXISTS env_vars(
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK(scope IN ('global','app','plan')),
  app_bundle_id TEXT,          -- NULL unless scope='app'
  plan_id TEXT REFERENCES plans(id) ON DELETE CASCADE,  -- NULL unless scope='plan'
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  secret INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

Uniqueness is enforced by the COALESCE expression index below (SQLite UNIQUE treats NULLs
as distinct, so a table-level constraint can't do it) — scope-column correctness (app scope
⇒ bundle set, plan scope ⇒ plan set, global ⇒ both NULL) is route-layer validation:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_env_vars_key
ON env_vars(scope, COALESCE(app_bundle_id,''), COALESCE(plan_id,''), key);
```

**1.2 `app_screens.login_json`** — guarded ALTER (`ALTER TABLE app_screens ADD COLUMN
login_json TEXT`), nullable. Shape: `{entry, phoneField, passwordField, submit, session}` —
all strings, matching today's inline `ensureLogin` selector fields exactly.

Deliverable: migration runs on server boot; existing DBs upgrade in place; fresh DBs get both.

## Stage 2 — env resolution chain in playback

**2.1 New resolver** `server/src/manual/env-store.ts`: `resolveEnv(db, {appBundleId, planId,
requestEnv})` → merges `global` → `app:<bundle>` → `plan:<id>` → request-body env (each later
scope wins per key). **Plan-id threading path (review F4):** `runBatch` receives `planId`,
threads it into each lane's opts, `runOne` forwards it into the `runTemplatePlayback` opts
(`playback.ts:274` — opts gain `planId?: string`); the resolver reads it there. Note plan
plays already pass `env: p.env` into `runBatch` (`routes/manual.ts:835`) — that stays as the
plan's request-body contribution; the `plan:` scope is the persisted twin.

**2.2 Wire into playback.ts:641** — `let activeEnv = resolveEnv(db, {...})` replacing the raw
`mergeVariantEnv(opts.variant ?? null, opts.env ?? {})` start point. Chain (operator-confirmed
2026-09-26, preserves today's pinned variant-wins precedence — `mergeVariantEnv` spreads
variant env OVER invocation env, `yaml-variants.ts:131`, "variant > invocation … tested in
phase B T1" at `playback.ts:761`):

**global < app < plan < request body < variant** — variant stays narrowest, no behavior
change for existing runs.

**2.2b Swap steps must re-merge over the resolver base — NOT bare `opts.env`.** Today the
swap handler does `activeEnv = mergeVariantEnv(w, opts.env ?? {})` (`playback.ts:1139`),
which rebuilds from the request body only. If `activeEnv` is seeded with managed scopes but
the swap resets to request-body-only, every global/app/plan value silently vanishes mid-run.
Fix: keep the Stage-2.1 resolver output in a `resolvedBase` const; the swap assignment
becomes `activeEnv = mergeVariantEnv(w, resolvedBase)`.

**2.3 Audit log** — run `note` gains `env sources: global(2) app(1) request(2)` — counts
only, never values.

Deliverable: unit tests pinning the chain — (a) override order across all five scopes,
(b) **a `swap:` step case asserting managed values survive the swap with variant overrides
applied** (non-overlapping managed keys must persist post-swap), (c) missing-ref failure
unchanged.

## Stage 3 — routes

**3.1 CRUD `/api/env-vars`** (routes/env-vars.ts):
- `GET` → list grouped by scope; secret values replaced by `null` + `secret: true` + `status:
  'set'`; non-secrets return values.
- `PUT /:id` → upsert by (scope, app?, plan?, key); **empty-secret sentinel is scoped
  (review F2)**: empty value on a row that exists with `secret=1` → "leave unchanged"
  (enables note edits without re-typing); empty value on CREATE, or on a non-secret row →
  `422` named error. Clearing a secret = DELETE (documented in the /env page).
- `DELETE /:id`.
- **Role gating (review F3):** `PUT`/`DELETE` behind `requireRole('operator')` (house
  precedent: baselines approve/reject); `GET` for any signed-in user (secrets masked
  regardless). Bot sessions pass operator-tier per `roles.ts`.
- Validation: key matches `^[A-Z][A-Z0-9_]*$`; scope/app/plan consistency (app scope requires
  bundle, plan scope requires plan id, global requires both NULL).

**3.2 Screens routes gain login recipe I/O** — `PUT /api/app-screens/:bundle/:screen/login`
(body = the 5 selectors) + included in GETs. The Screens UI login-recipe form is **deferred
to a follow-up** (review F7); Stage 6.1 seeds via the API route regardless.

Deliverable: route tests — masking, empty-secret-keeps-value, scope validation, cascade on
plan delete.

## Stage 4 — grammar + playback: `ensure login: screen:` form

**4.1 case-yaml.ts** — `ensureLogin` gains optional `screen?: string`. Parse: block and flow
forms accept `screen:`; **validation rule**: `screen` XOR at-least-the-5-selectors (a step
with both → error "screen: and inline selectors are mutually exclusive"; neither → existing
error). Emit: `screen:` form emits compactly:
```yaml
  - ensure login:
      screen: auth
      phone: '${env.DRILL_PHONE}'
      password: '${env.DRILL_PASSWORD}'
```
Inline form emits as today (block, per-field).

**4.2 playback.ts handler** — when `screen` present: read `login_json` from `app_screens` for
`(template app bundle, screen)`; missing screen row / missing `login_json` / partial recipe →
explicit step failures (`ensure login: screen "auth" has no login recipe`). Inline fields
still resolved per current code when no `screen:`. Env refs (`phone`/`password`) resolve via
`activeEnv` exactly as now — no change to `expandEnvText`.

**4.3 Back-compat** — stored twins keep working unchanged (inline form still parses/plays).
No data migration; re-authoring the twins to the `screen:` form is Stage 6.

Deliverable: parse/emit/round-trip tests for both forms + mutual-exclusion error; playback
handler test with a fixture `app_screens` row.

## Stage 5 — /env page (dedicated)

**5.0 Sketches first (gate: no Vue code until a variant is picked).** Per house rule
(sketches before UI code), produce 2–3 throwaway HTML variants under `sketches/NNN-*/`
following the `sketch` skill: single self-contained files, inline styles, realistic fake
content (real key names — `DRILL_PHONE`, `DRILL_PASSWORD`, `FORGE_TLS_PIN` — actual scope
names, real-looking notes), interactive (add/edit/delete feints, secret toggle showing
`•••••`, scope switch). Variants must pull apart on a real axis, e.g.:

- **Table-dense** — one flat table, scope as a column, filters; power-QA scan speed.
- **Grouped-cards** — Global / per-app / Plans sections as cards, add-form inline per group;
  quieter, matches ScreensPage feel.
- **Split-pane** — scope tree left, key/value editor right; scales to many apps.

Each variant gets a `README.md` (stance, trade-offs). Present the head-to-head comparison
table with a recommendation; operator picks (or hybrid). Only the picked stance becomes the
Vue page. Axiom terminal tokens for the real page; sketches approximate them (shared
`sketches/themes/tokens.css` if useful).

**5.1 Route + page** — `web/src/pages/EnvPage.vue`, router `/env` (`{ name: 'env', meta:
{ title: 'env' } }`), nav item. Axiom terminal minimal UI per house style (match
ForgePage/ScreensPage patterns: page header, grouped sections), built to the PICKED sketch
stance.

**5.2 Layout** — per the picked variant; baseline content contract: three scope groupings
(Global, per-app, Plans), each row = KEY, value (or `•••••` + set badge for secrets), note,
updated-by/at, edit/delete actions, add-variable form per grouping (key, value, secret
checkbox, note).

**5.3 Edit behavior** — secrets: value field starts empty with placeholder "leave blank to
keep"; non-secrets show current value. Save = `PUT`.

Deliverable: page renders from real API; masked secrets; add/edit/delete round-trip works
manually against the running server. Sketches + head-to-head + operator pick archived under
`sketches/` (disposable; not shipped).

## Stage 6 — migrate the twins + drill

**6.1** Seed a NEW full `auth` screen row for `com.lioparcel.services.consumer.int-dev`
(operator decision, review F5: "New" — cleaner registry than hanging the recipe on `home`).
`app_screens` requires NOT NULL `entry_json` + `states_json`, so the row is authored
complete: entry = tap the login bar (`home_login_bar_login_button`), states = the session
states the runner already knows (logged_in via `account_logout_button` / logged_out via the
login bar), plus `login_json` = the selectors as verified live this session (entry
`home_login_bar_login_button`, phoneField `auth_login_phone_field`, passwordField
`auth_login_password_field`, submit `auth_login_button`, session `account_logout_button`).

**6.2** Set env vars via the new API: scope app → `DRILL_PHONE`, `DRILL_PASSWORD` (secret) —
values from the operator in chat, never written into template bodies.

**6.3** Re-author `tpl_pp_li` / `tpl_tnc_li` setup to the `screen:` form (through the
validator round-trip, per house rule).

**6.4** Drill: `POST /api/templates/tpl_pp_li/play` with **empty env** on A2102153 — the
completion-condition run. Requires VPN up (operator-stated 403 cause). Expect: login lands,
Account tab → privacy row → doc screen — 4/4 steps pass.

## Failure cases and edges

- **Missing screen recipe** → named step failure (not silent skip).
- **Secret with empty-value PUT** → keeps stored value (allows note edits).
- **Plan deleted** → its env rows cascade away.
- **Key collisions across scopes** → resolved by chain order; /env page shows effective value
  per app section ("overridden by app scope" hint on global rows) — defer the hint if time
  boxes it; core chain must work.
- **Template YAML with both `screen:` and inline selectors** → validator error, not
  last-wins.

## Validation and acceptance

1. `pnpm run check` green (schema, resolver, routes, grammar tests all inside).
2. Round-trip probe (parse → emit → parse deep-equal) for the `screen:` form — same harness
   as the block-form change.
3. Masking: `GET /api/env-vars` response contains no secret plaintext (assert in route test).
4. Live drill per 6.4 — the honest end-to-end gate (blocked on VPN; everything up to and
   including 6.3 verifiable now).

## Rollout / handoff

Single PR-shaped branch on `feat/screen-state-runner` continuation (or fresh branch off it),
commits staged per Stage. No breaking route or grammar changes; old YAML and old play bodies
behave identically. After 6.4, offer the login-seam commit split: Crucible side (verbs +
env + screens recipe) and ios-consumer-intl side (identifiers + automationIdentifier
passthrough) — per house rule the app PR lands with its own drill evidence.
