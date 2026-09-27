# Login recipe → login dependency, modeled properly

- Source prompt: "'Login recipe' on edit screen still doesn't make sense to me. Please come up with better execution for dependencies. It has to be production-grade."
- Created: 2026-09-27T12:04:43Z
- Status: Direction selected (awaiting operator confirmation of the shape)

## Goal and context

The login-recipe UI has survived four rounds of presentation fixes (column → chip → dashed
row → gated checkbox → footer removal) and STILL doesn't make sense. The user's verdict
forces the structural question: the model is wrong, not the rendering. Redesign the login
capability as a first-class dependency concept, production-grade.

## Diagnosis (why every UI treatment failed)

The five "recipe" fields are not one thing. Decomposed by what they actually describe:

| field | what it really is | natural owner |
|---|---|---|
| `entry` | how to REACH the login form | the auth screen's own `entry` (already stored there — the recipe DUPLICATES it) |
| `phoneField`, `passwordField`, `submit` | the login FORM's controls | the auth screen (a form is a screen; its controls are its identifiers) |
| `session` | how to KNOW login succeeded | the Account screen's logged-in state (`account_logout_button` is `auth.states.logged_in`'s identifier — ALREADY stored there too!) |

The recipe is thus ~100% derived or duplicated data: 2 of 5 fields duplicate the auth
screen's own entry/states, the other 3 are new facts about the auth screen's form. There is
no fifth-thing that needs a separate concept bolted onto screens. The concept that DOES
exist and is missing: **a dependency edge** — "cases that need a logged-in session depend on
the auth screen's login capability."

## Proposed direction — "login = a capability of the screen that owns the form"

1. **The auth screen declares its form controls as screen facts**, not a recipe:
   ```yaml
   - id: auth
     entry: { navigate: [{on: home_login_bar_login_button}] }
     states:
       logged_in:  { all: [{identifier: account_logout_button}] }
       logged_out: { all: [{identifier: home_login_bar_login_button}] }
     login:                       # capability: the form IS this screen
       phone: auth_login_phone_field
       password: auth_login_password_field
       submit: auth_login_button
   ```
   - `entry` duplication GONE (the capability uses the screen's own entry)
   - `session` duplication GONE (the screen's own `states.logged_in` IS the session check)
   - what remains is exactly the three fields that were missing from the screen model
2. **`ensure login` grammar simplifies**: `ensure login: {screen: auth, phone: '${env…}',
   password: '${env…}'}` resolves entry + session from the screen's OWN entry/states; the
   capability block supplies the form controls. Nothing duplicated, one source per fact.
3. **UI consequence — and why it finally makes sense**: there is no "login recipe" section.
   The auth screen's document shows a `login:` block among its other facts (entry, states)
   — three fields that describe its form, shown once, on the only screen it belongs to.
   Other screens never see it (already gated). The "ensure login (screen: auth)" consumer
   relationship stays visible via the chip.
4. **Dependencies, generalized**: this establishes the pattern for future preconditions
   (`ensure logout` needs the same treatment: it already reads button/confirm selectors
   from the case — those are the Account screen's facts). A dependency is: screen facts +
   a named capability + consuming cases. No side tables.

## Migration (production-grade requirement)

- Grammar accepts the NEW 3-field `login:` block; storage normalizes both old 5-field and
  new 3-field shapes at write time (entry/session dropped — they were derived).
- Playback `ensure login`: resolve entry = screen.entry; session check = screen.states
  (prefer an explicit `logged_in` state; error naming the state if absent); controls from
  the login block. Old stored shapes keep working (read-time fallback to legacy fields).
- The twins' YAML unchanged (still `screen: auth` + env refs).

## Risks / open questions

1. Session detection depends on a screen state existing — which state name? Convention
   `logged_in` (auth already has it). Operator confirm.
2. `ensure logout`'s selectors should migrate the same way in a follow-up (not in this
   change) — flag only.

## Next step

Operator confirms the shape (or amends), then: plan rev for the grammar/playback/migration
(small — the UI part DELETES more than it adds), review, build, drill the twins.
