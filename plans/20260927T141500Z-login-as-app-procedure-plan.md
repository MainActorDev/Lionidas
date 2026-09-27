# Login as an app-level procedure — implementation plan

- Source brainstorm: `brainstorm/20260927T140000Z-login-as-app-procedure.md`
- Created: 2026-09-27T14:15:00Z
- Status: Ready (rev 2 — review F1–F4 applied 2026-09-27; see
  `reviews/20260927T141500Z-login-as-app-procedure-plan-review.md`)

## Decision log

| # | Decision | Provenance |
|---|---|---|
| D1 | Login is an app-level PROCEDURE — no screen owns it | Operator 2026-09-27: "No screen should 'own' the login form in this context." |
| D2 | Screens REFERENCE it as steps (precondition), they never store it | Operator: "Only any screen might referencing it as their steps." |
| D3 | Nothing destructive — unchecking/editing a screen can never delete the login definition | Operator: "When I uncheck the box, it's gone forever. And there is nothing I can do." |
| D4 | Editing surface: app-scoped, on the screens page | Brainstorm follow-on, matches the `+ app` app-scoped pattern |

## Model

New table `app_login(bundle_id PK, login_json NOT NULL, updated_at, revision)` — one
procedure per app. Shape (v3, final):

```json
{ "entry": { "navigate": [{ "on": "home_login_bar_login_button" }] },
  "phone": "auth_login_phone_field", "password": "auth_login_password_field",
  "submit": "auth_login_button",
  "verify": { "screen": "auth", "state": "session_on" } }
```

- `entry` — a full entry object (tab/deepLink/navigate) reusing the existing entry
  grammar + validator; the procedure knows how to get to the form
- `phone`/`password`/`submit` — the form's controls
- `verify` — a (screen, state) REFERENCE; states remain screen facts, referenced not
  copied. Cross-validated at save: screen must exist, state must be one of its states.

## Stage 1 — storage + grammar

**Case grammar (review F2):** the screenless form becomes VALID —
`ensure login: {phone: '${env…}', password: '${env…}'}` resolves the app's procedure
(the validator currently REJECTS it; parse rules change to: screenless OR screen: OR
legacy-inline, exactly one). `screen:` keeps parsing with a deprecation note. The
screen-precondition reference (D2's "screens reference it as their steps") is a FUTURE
CARD with its own brainstorm — after this change the only reference form is the case's
`ensure login`.

- Guarded CREATE of `app_login` (idempotent, schema.ts convention). **Concurrency
  (review F4):** the panel save follows the registry pattern — read revision, PUT with
  revision, 409 on drift. Deleting a screen the procedure `verify` references does NOT
  cascade; validation happens at procedure save, playback errors named-ly if the state
  is missing at play time.
- `validateAppLogin(login, screensOfApp)` in shared/src/app-screens.ts: entry valid
  (reuse validateScreen's entry branch), 3 controls non-empty, verify references a real
  screen+state. Named errors per gap.
- Screens' own `login:` blocks: NO LONGER in the screen validator's allowed keys
  (removed with this change — the dual-shape era ends here; migration below covers data)

## Stage 2 — playback

- `ensure login` handler resolution order: `app_login` row for the template's bundle →
  procedure → env refs from the step as today. `screen:` argument accepted but ignored
  (deprecation note in the step reason).
- **Entry playback (review F1 — the current code does NOT play multi-step entries):** the
  handler gains a real entry player. `navigate` lists play PER-STEP through the same
  resolver the screen-runner's navigate branch uses (poll + unique-match fallback,
  battle-tested in run_32a8ff19) — the join('>') single-selector hack is deleted;
  `tab`/`deepLink` keep the single-selector path. Fixture test: a 2-step navigate entry
  asserts TWO distinct tap dispatches; live drill proves a multi-hop procedure reaches
  the form. NO defaults, NO seed constants — every selector comes from the stored
  procedure.
- Legacy screen-level block fallback: if no `app_login` row exists AND a screen block
  exists (old data), resolve from it (read-only path, no rewrites). This is the
  non-destructive bridge (D3): nothing is deleted, ever.
- Verify = poll `states[verify.state]` of `states[verify.screen]` (sessionHolds reused).

## Stage 3 — editing surface (D4)

Screens page, per-app header gains `login flow` action (beside `+ screen`/`yaml`):
- Opens a dedicated panel (LoginFlowPanel.vue, ScreenDocPanel's anatomy minus identity):
  form (entry kind + steps, 3 controls, verify screen+state selects fed from the app's
  registry) left, yaml document right (same CodeMirror, same sync contract).
- Save: PUT /api/apps/:bundle/login (new route, operator-gated) → validateAppLogin.
- App without a procedure shows the action too — creating it is always reachable,
  deleting it is a `remove` inside the panel (explicit, confirm-gated, on the login
  surface itself — never a side effect of screen editing).
- **Same-change de-scope (review F3):** Stage 1's validator rejects screen-level `login:`
  on NEW data, so the emitter and ScreenDocPanel (formToDoc/docToForm/login section/
  showLoginSection/appHasLogin) drop screen-login in THIS change — otherwise every screen
  save after a stale-doc edit 422s. Legacy rows still READ via the Stage-2 fallback.
  Sweep test: save each existing screen through the panel → no 422.
- ScreensPage row rendering: ALL login chrome removed (chip, expanded block, loginDraft
  in-place editor, hasLogin/appHasLogin). The screens table returns to pure screen facts.
  The `used by` concept for the procedure lives in the login panel (which cases reference
  `ensure login`).

## Stage 4 — migration + tests + drill

- Seed: none required (auth's v2 block works via the Stage-2 legacy fallback); a natural
  moment to copy screen-block → app_login is the first login-flow panel save.
- Tests: validateAppLogin (entry/controls/verify-reference gaps); playback resolution
  (app row wins; legacy fallback; verify via state); route auth (operator gate); screens
  validator now REJECTS login on a screen (the era ends loudly for new data).
- Drill: seed app_login via the new panel UI; run the twin (VPN-independent proof:
  entry resolve + fill + state-poll attempt); unchecked/un-editable concern is void —
  no screen surface can touch the procedure.

## Out of scope

- Screen-level `{login: true}` precondition reference (D2's grammar follow-up — separate
  change once the procedure model is proven in use)
- ensure logout migration (unchanged)
