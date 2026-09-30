# Login recipe as steps — app-agnostic form controls

- Source prompt: "Don't you think the form controls is too rigid? Because different app can have different form. Or I can easily edit it via the YAML?" → assistant answered (yaml editable today, but the SCHEMA is phone-password-shaped; proposed recipe-as-steps) → operator: "Brainstorm properly" (invoked with /hms-brainstorm-rough-ideas)
- Created: 2026-09-30T04:45:50Z
- Status: Exploring

## Goal and context

The login recipe today is a fixed 5-slot shape — `entry / phone / password / submit / verify` — mirrored by the LoginFlowPanel form and enforced by `validateAppLogin` (phone+password+submit REQUIRED). The operator finds this too rigid: different apps have different login forms (email, username, OTP, multi-step). He asks whether yaml editing is the escape, and (per the assistant's framing he chose to brainstorm) whether the recipe itself should become flexible. Interpretation: goal = a login recipe that can express ANY app's login procedure without engine changes per app; the existing Lion Parcel app must keep working.

## Confirmed inputs and decisions

- User-confirmed: the rigidity concern ("different app can have different form"); interest in yaml as the editing surface.
- Verified (code, 2026-09-30):
  - `validateAppLogin` (shared/src/app-screens.ts:208+) requires entry + phone + password + submit + verify{screen,state} — an email/OTP app CANNOT be expressed, even hand-writing the yaml doc.
  - The stored recipe carries ONLY identifiers (no credentials); credentials live on the CASE step (`phone: ${env.DRILL_PHONE}`) and are env-expanded at playback (playback.ts:1289-1290).
  - The ensure-login executor consumes the 5-slot shape (`SelSource` :1247, walk below it) — a steps-form engine must replace this walk.
  - The case grammar already has the verbs a recipe needs: `tap`, `type {on, text}`, `expect`, plus `${env.X}` substitution (`substituteStep`/`expandEnvText`) — one proven mechanism, already test-covered.
  - Logout is NOT rigid (`button/confirm/stay/via` covers the near-universal sheet flow; all optional-but-two). This arc is login-only.
  - PR #11 (open): recipes already ride `screens.yaml` export; the login block there is the 5-slot yaml.

## Exploration

### Option A — keep 5 slots, add optional extras (e.g. `email` field key)
Smallest change; still a closed vocabulary. An OTP flow (fill code, tap verify, maybe re-fill) still won't fit. Rejected premise: patching slots forever.

### Option B — recipe-as-steps (PROPOSED)
The recipe becomes a mini-procedure in the case grammar:
```yaml
login:
  entry:
    navigate: [{ on: home_login_bar_login_button }]
  steps:
    - type: { on: auth_login_phone_field, text: "${env.LOGIN_ID}" }
    - type: { on: auth_login_password_field, text: "${env.LOGIN_SECRET}" }
    - tap: { on: auth_login_button }
  verify: { screen: auth, state: session_on }
```
- Any form shape is a step list: email, username, OTP two-step (type → tap → type → tap), terms-checkbox-then-submit.
- Credentials move INTO the recipe as env refs → the CASE shrinks to bare `ensure login: {}` (mirroring bare `ensure logout:`); per-case `phone:`/`password:` keys die.
- Playback: the walk becomes "play entry → play steps via the existing step engine → verify state" — REUSE, not a new executor. The 5-slot `SelSource` path collapses into steps + verify.
- Panel: the fixed form stops making sense; the panel becomes the yaml doc (+ maybe a thin field picker later). Honest: this is a procedure, not a form.
- Risks/costs: playback rework (the walk is the subtle part — focus/clear/type chain, keyboardDismiss after fills — all already exist as step behaviors); migration of the one stored recipe + the 2 logged-in cases; `screens.yaml` login block changes shape (import keeps validating); "already logged in" preflight still gates before any step runs (unchanged).

### Option C — recipes as full CASES (a `login: tpl_x` template reference)
Maximum reuse (a login flow is just a case), zero new grammar in recipes. But: cases live in templates/folders with tags/status semantics; coupling app-level facts to the case list muddies ownership, and export story splits (screens.yaml vs case zip). Rejected for scope, noted as a future collapse if cases grow app-level metadata.

### Open sub-questions within B
1. **Env names in recipes** — `${env.LOGIN_ID}`/`${env.LOGIN_SECRET}` become the convention (the app-level env table already exists). Old per-case `phone/password` env names die with the keys. Migration must map DRILL_PHONE/DRILL_PASSWORD → the new refs.
2. **Multi-step verify** — keep the single end-state verify (screen+state), or allow expects INSIDE steps (recipe can already use `expect` steps — natural, no extra work; end verify stays as the "login counted" gate).
3. **keep 5-slot import as legacy** — old `screens.yaml` files (and the current DB row) auto-convert to steps-form on import/read? Recommend: one-time guarded migration (5-slot → generated steps), validator accepts steps-form only going forward.

## Open questions

1. **B or C?** (B recommended: app-level procedure stays a registry fact; C is the bigger conceptual move)
2. **Env ref naming** — lock `LOGIN_ID`/`LOGIN_SECRET` or let each app pick (recipe is per-app anyway)?
3. **Panel scope this round** — doc-only (recommended first cut) or keep a generated form for the common phone+password shape?

## Decisions log

- 2026-09-30 user (chat), answering the three open questions:
  1. **"B"** — recipe-as-steps (app-level procedure stays a registry fact; NOT the case-reference shape).
  2. **"Per app"** — env ref names are chosen by each app's recipe author (no global LOGIN_ID/LOGIN_SECRET convention forced; the recipe is per-app, refs like ${env.DRILL_PHONE} may keep their names).
  3. **"do with your recommendation"** — panel: doc-only first cut (the fixed form is removed for login; the yaml doc becomes the editing surface; logout panel unchanged).

## Next step

Answer the three questions → plan (grammar+validator, playback rework, migration, panel, screens.yaml shape, drill on the real app + a synthetic OTP app) → review → build.
