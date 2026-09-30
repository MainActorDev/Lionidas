# Login recipe as steps (plan)

- Source brainstorm: `brainstorm/20260930T044550Z-login-recipe-as-steps.md` (+ Decisions log)
- Status: Ready (rev 2 — review F1-F6 applied; review `reviews/20260930T044550Z-login-recipe-as-steps-plan-review.md`)
- Created: 2026-09-30

## Decision log (provenance)

| # | Decision | Source |
|---|---|---|
| 1 | **B — recipe-as-steps**: the login recipe becomes a step list in the case grammar; the app-level registry fact stays (NOT a case reference) | operator, 2026-09-30 |
| 2 | **Env refs are per-app**: the recipe author picks the names (e.g. `${env.DRILL_PHONE}` keeps its name); no global LOGIN_ID/LOGIN_SECRET convention | operator, 2026-09-30 |
| 3 | **Panel: doc-only first cut** — the login panel's fixed form is removed; the yaml document becomes the editing surface (logout panel unchanged) | operator accepted assistant recommendation, 2026-09-30 |
| 4 | Credentials live in the recipe as env refs; the case step becomes bare `ensure login: {}` (mirrors bare ensure logout); per-case `phone:`/`password:` keys are removed | necessary consequence of 1+2 (flagged agent-derived) |
| 5 | End-verify stays `{screen, state}` as the "login counted" gate; `expect` steps inside the recipe are allowed (free — they're normal steps) | brainstorm open-sub-question resolved by decision 1's semantics (flagged agent-derived) |
| 6 | One-time guarded migration converts stored 5-slot recipes to steps-form; validator accepts steps-form going forward (legacy import auto-converts) | brainstorm recommendation, uncontested (flagged agent-derived) |

## Objective and completion conditions

Any app's login procedure — phone, email, username, OTP multi-step, terms-checkbox — is expressible as a recipe; cases say bare `ensure login: {}`; the engine plays the recipe with the existing step machinery. Done when:

1. The stored int-dev recipe runs as steps: `tnc (logged-in)` and `privacy policy (logged-in)` pass live on 30B28173 via the migrated recipe (fresh login path AND already-logged-in path).
2. A synthetic OTP-style recipe (type → tap → type → tap) passes a fake-engine playback test.
3. `validateAppLogin` accepts steps-form, rejects 5-slot-only (post-migration), with useful errors; `screens.yaml` export/import round-trips steps-form.
4. LoginFlowPanel is doc-only (form gone, doc + save/remove/revision stay); build clean.
5. Full suite green; signature scan clean.

## In / Out of scope

**In:** recipe schema + validator; playback rework (entry → steps → verify); bare `ensure login: {}` grammar; migration (recipe + 2 cases); panel doc-only; screens.yaml shape; docs update (session-preflights.md).
**Out:** logout recipe (stays button/confirm/stay/via — verified non-rigid); Option C case-references; per-step narrate inside recipes (free later if wanted — steps carry narrate already); editor form for common shapes; localization.

## Verified facts (code survey 2026-09-30)

- Executor: `ensureLogin` block at playback.ts:1231-1487 — entry player (`playEntryStep`, tab/deepLink/navigate), resilient-fill (`alloy_act fill` + typed-length verification via dots, live-hardened), submit press, session-state poll (`verify.screen/state` via `sessionHolds`), optional `verify.via`. All these behaviors must survive; the REWORK replaces the 5-slot walk (press-phone-field → fill → press-password → fill → press-submit) with step-list playback reusing the same primitives.
- Grammar: `ensure login` parses two forms today — screen-form (`screen: + phone/password env refs`, case-yaml.ts:460-480) and the app-procedure form (`selSource` from app_login). Both must converge to: bare `{}` (recipe from app_login) with optional back-compat screen-form mapping to the app recipe (as settled for logout).
- `validateAppLogin` (shared/app-screens.ts:208+): allowed = entry/phone/password/submit/verify; phone+password+submit REQUIRED — the rigidity.
- Credentials today: case step carries `phone: "${env.DRILL_PHONE}"` etc., env-expanded at playback (:1289-1290 via `expandEnvText`). Recipe stores identifiers only. Post-change: refs ride recipe steps' `text:` and expand via the same `substituteStep` machinery.
- Stored recipe (live DB): `{"entry":{"navigate":[{"on":"home_login_bar_login_button"}]},"phone":"auth_login_phone_field","password":"auth_login_password_field","submit":"auth_login_button","verify":{"screen":"auth","state":"session_on"}}`.
- The 2 logged-in cases' setup step: `{action: 'ensureLogin', ensureLogin: {…, phone: '${env.DRILL_PHONE}', password: '${env.DRILL_PASSWORD}', screen: 'auth'}}` + narrate `Given I am logged in`.
- Step engine already handles: focus+clear+type (`type` action), keyboardDismiss after fills, settle polls, watchdog, optional steps. A recipe step list can be played by the SAME loop that plays case steps — the recipe executor becomes a nested invocation of step playback.
- `screens.yaml` (PR #11): wrapper `screens:/login:/logout:`; login block is currently 5-slot; import validates via validateAppLogin.
- LoginFlowPanel.vue: 16 form fields + doc sync + revision-guarded save — the form layer is what decision 3 removes.

## Architecture

**Recipe shape (new):**
```yaml
login:
  entry: { tab: … | deepLink: … | navigate: […] }
  steps:
    - type: { on: <field-id>, text: "${env.<PER_APP_NAME>}" }
    - tap:  { on: <submit-id> }
  verify: { screen: <id>, state: <id>, via: <optional label-or-id> }
```
- `steps` uses the case step grammar subset that makes sense pre-login: tap/type/expect (validated subset); each step supports `optional:`/`when:` where meaningful.
- `verify` unchanged (single end-state gate; expects inside steps are ordinary steps) — INCLUDING the optional `via` key (a control tapped before state polling when the state lives on another screen; in live use today — playback.ts sessionVia). Validator keeps it; the recipe example shows it.
- Validator: `steps` non-empty list of validated steps (reuse the case-yaml step parser on the steps block — parse each step, map errors); unknown keys rejected; entry rules unchanged.

**Playback:** the ensureLogin executor becomes: resolve recipe (app_login) → already-logged-in preflight (unchanged, gate on verify state) → play entry (existing entry player) → play steps via a step-list player that reuses the dispatch primitives (resolve selector → press/fill + keyboardDismiss + settle; env-expand `text:` via the run's active env) → verify state holds (existing poll). The 5-slot `SelSource` walk is deleted. One nested player function shared by nothing else yet — keep it local, extracted only if a second consumer appears.

**Fill unification (review F1 — the two existing paths differ):** the login walk's `resilientFill` (playback.ts:1415+) retries and mask-parity-verifies (dots counting proves secure-field fills landed); the case `type` path (:930-960) is a plain fill with neither. Extract ONE shared helper `resilientFill(x, y, text, opts)` — retry once; mask-parity check fires only when the engine reports the fill unconfirmed AND the field masks (attempt-then-probe); plain fields skip the dots path. BOTH callers (recipe step player AND case `type` dispatch) route through it — the recipe steps must not silently lose the verification, and case steps gain it. Test: engine reports fill-not-confirmed on a masked field → retry fires → pass; plain field → no dots probe.

**Grammar:** `ensure login: {}` bare (recipe resolves; save-time error if app has no login recipe — predicate mirrors logout's `hasLogoutRecipe`); `screen:` form accepted → resolves app recipe (same as today's precedence), back-compat for existing cases until migrated. Inline selector form (`entry/phoneField/...`) → parse error pointing at the recipe (was already semi-legacy).

**Migration (one-time, guarded):** stored 5-slot recipes → steps-form: `phone` field + `${env…}`… wait — the OLD recipe has no credential refs (they lived on cases). Migration synthesizes steps with per-app env names derived from the case's existing refs where discoverable, else placeholders the author must fill: steps = `[type phone-field ${env.DRILL_PHONE}], [type password-field ${env.DRILL_PASSWORD}], [tap submit]`. Placeholder policy (review F6 — order-independent): the migration scans ALL cases referencing the recipe and derives env-ref names from the MOST-COMMON ref per slot across those cases (the two real cases carry identical refs — DRILL_PHONE/DRILL_PASSWORD — so output is stable); ties fall back to the lowest template id; apps with no referencing case → placeholder `${env.LOGIN_PHONE}`/`${env.LOGIN_PASSWORD}` + a doc note. Cases are then REWRITTEN to bare form.

## Implementation stages (TDD)

### Stage 1 — validator + shape (shared/src/app-screens.ts)
RED→GREEN: steps-form validation; 5-slot rejected post-migration with a pointing error; unknown keys rejected. Round-trip through screens.yaml export/import. REUSE SEAM (review F3): `parseStepList` is module-private — export a new `parseStepsFragment(steps: unknown[]): { steps: YamlStep[]; errors: YamlError[] }` wrapper from shared/case-yaml.ts (unit-tested) and the validator consumes it; recipe step errors carry step-indexed prefixes (`login step N: …`).

### Stage 2 — grammar (shared/src/case-yaml.ts)
RED→GREEN: bare `ensure login: {}` (+ optional narrate/back semantics mirroring logout's bare form); `screen:` accepted → app-recipe marker; inline selector form → clear error. Predicate threading: `hasLoginRecipe` alongside `hasLogoutRecipe` through all four call sites. Emitter: bare form renders `- ensure login: {}` (+ narrate sibling when present). Byte-parity fixtures for existing forms.

### Stage 3 — playback (server/src/manual/playback.ts)
RED→GREEN (stateful fake, mirroring logout-registry-playback harness):
1. bare ensure login + steps-recipe → entry played, steps executed (fill targets = recipe field ids, text = env-expanded per-app refs), verify state held, step recorded pass.
2. already-logged-in → preflight no-op pass.
3. OTP-shaped synthetic recipe (type→tap→type→tap) passes.
4. missing recipe → fail-closed naming the fix.
5. inline screen-form case (legacy, pre-migration shape) → resolves app recipe, passes (back-compat).
KeyboardDismiss after fills; the resilient-fill dots-verification behavior carries into the step player (it is a fill primitive, not a login-specific hack).

### Stage 4 — panel doc-only (web/src/components/LoginFlowPanel.vue)
Strip the 16-field form; keep doc (yaml) + revision-guarded save + remove. VALIDATION UX (review F5, decided): save-then-show-errors — the existing PUT runs the one server-side validator and 422s with the error list; NO client-side validator duplication, NO live doc squiggles this round (doc parity with LogoutFlowPanel). `pnpm run build` clean.

### Stage 5 — migration + docs + full gate + live drill
1. Guarded migration in schema.ts beside the app_logout block: 5-slot → steps-form (case-derived env names; placeholders + doc note otherwise).
2. Migrate the 2 logged-in cases to bare `ensure login: {}` (keep narrate `Given I am logged in`).
3. Update `docs/features/session-preflights.md` (steps-form recipe, per-app env refs, panel is the doc).
4. Full gate: vitest (nvm 24.12.0), web build, signature scan.
5. Live drill on 30B28173: logged-out state → `tnc (logged-in)` PASSES via fresh login through the steps recipe; second run PASSES via already-logged-in; `privacy policy (logged-in)` green.

### Branch / PR — dependency options (review F2; operator chose the stack)
PR #11 (`feat/logout-recipe-registry`, registry + yaml carry) was OPEN at plan time. Two options were listed: (a) fresh branch off main after #11 merges; (b) **stack on #11's branch**. Operator decision 2026-09-30: proceed in the SAME branch `feat/logout-recipe-registry` — the login-steps work rides #11's PR (one review surface; merge order is inherently correct).

## Edge and failure cases

- Fill lands but confirmation fails (custom fields) — the resilient-fill behavior must stay (dots verification); test covers it.
- Recipe env ref missing from the app's env table → honest step failure naming the ref (same as case env errors today).
- Recipe edited mid-suite → next run reads fresh (run-start resolution, same as logout).
- Steps referencing screens/`runFlow` (not meaningful pre-login) → validator rejects the subset outside tap/type/expect.
- `screen:`-form case post-migration (unmigrated hand-written yaml) → resolves app recipe; recipe missing → fail-closed message.
- Empty steps list → validator error (a recipe must do something).

## Validation and acceptance

| Check | Pass condition |
|---|---|
| Validator tests | steps-form accepted; 5-slot rejected with pointing error; subset rules; yaml round-trip |
| Grammar tests | bare/screen-form parse+emit; predicate error text; byte-parity fixtures |
| Playback tests | 5 scenarios incl. OTP + unified resilient-fill (masked retry fires; plain field skips dots) + fail-closed |
| Panel | doc-only saves/validates; build clean |
| Migration | recipe converted (env names from case refs); 2 cases bare; idempotent re-run |
| Live drill | both preflight paths green on real app; suite green |

## Rollout / handoff

Single PR; guarded migrations (recipe reshape, case rewrite); docs updated; operator merges. Follow-ups (NOT in scope): narrate rendering inside recipe steps at run time (free later), generated form for common shapes, Option C collapse.
