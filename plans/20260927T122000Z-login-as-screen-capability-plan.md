# Login as a screen capability — implementation plan

- Source brainstorm: `brainstorm/20260927T120443Z-login-as-screen-capability.md`
- Created: 2026-09-27T12:20:00Z
- Status: Ready (rev 3 — review F1–F5 applied; see
  `reviews/20260927T122000Z-login-as-screen-capability-plan-review.md`)

## Decision log

| # | Decision | Provenance |
|---|---|---|
| D1 | Login modeled as a CAPABILITY of the screen owning the form — no separate "recipe" entity | Operator: "still doesn't make sense… better execution for dependencies. It has to be production-grade." (brainstorm direction selected) |
| D2 | `entry` duplication removed — the capability uses the screen's own `entry` | Necessary consequence of D1 (verified: both currently store `home_login_bar_login_button`) |
| D3 | `session` duplication removed — the screen's `states.logged_in` IS the session check | Same |

## Decision log (late addition)

| # | Decision | Provenance |
|---|---|---|
| D4 | Session detection ALWAYS requires the explicit `session:` state pointer inside the login block — no `logged_in` convention, no fallback | Operator 2026-09-27: "Always require the explicit pointer" |

Consequence: the login block is 4 fields — `phone`, `password`, `submit`, `session` — where
`session` names one of the screen's own states. A block without a valid `session` pointer is
a validator error ("login.session must name one of this screen's states"), never an
implicit guess. Fail-honest at save time beats convention at play time.

## Staged work (drafted, executes after the gate)

1. Grammar (`shared/src/app-screens.ts`): `login:` block becomes
   `{phone, password, submit, session}` — 4 fields. Validator: non-empty identifiers for
   phone/password/submit; `session` must be a non-empty string naming one of the SAME
   screen's `states` keys (cross-field validation — new); unknown keys named. Old 5-field
   shape still VALIDATES but storage normalizes to 4-field (legacy `entry` dropped;
   legacy `session` value becomes the `session` pointer verbatim).
2. Storage: **NO boot migration (review F1 — the boot rewrite could drop legacy `entry`
   while old code paths still read it, irreversibly).** Instead: read-time dual-shape
   support everywhere (playback handler, GET serializer, emitter import): 5-field honored
   as today; 4-field resolves entry from screen.entry and session via the pointer. Rows
   re-emit as 4-field only when the screen is next SAVED through the new validator. No
   deploy-order coupling, no dropped data.
3. Playback (`playback.ts` ensure-login handler): entry = the screen's `entry` (navigate/
   tab/deepLink — all resolvable by existing arrive machinery); session check = the
   screen's `states[login.session]` (the explicit pointer — resolved exactly, named error
   if the state vanished from the registry between save and play) via the screen-runner's
   stateHolds; controls from the capability block.
4. UI (review F4 — it's FOUR fields now): ScreensPage login-block renders phone /
   password / submit / **session state** (the pointer's value is a STATE NAME — labeled so,
   never an identifier placeholder); tooltip notes entry+session derive from the screen's
   own facts. ScreenDocPanel: `login:` section = the four fields (renamed `form controls`),
   gated as today; the session input's placeholder says `state name — logged_in`. Emitter
   + round-trip tests updated for the 4-field shape (review F5).
5. Tests: validator both shapes + the cross-field session rule (F3: runs only when
   `states` itself validated as a mapping; single named note otherwise); playback
   resolution (entry from screen, controls from block); **the session path pinned WITHOUT
   VPN (review F2): a screen-runner fixture where `states[login.session]` holds → the
   session poll short-circuits PASS with no fills; a pointer naming a state the screen
   lacks → the named error.** Twins re-run for entry resolution + fill as before.
6. Drill: `run` the arrive case (entry via screen.entry unchanged), then the twin (fill
   proven; login waits on VPN as before).

## Out of scope

- `ensure logout` selector migration (same pattern, follow-up)
- Any case-grammar change — twins' YAML untouched
