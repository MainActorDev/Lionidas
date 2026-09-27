# Managed env values + screens-held login recipe

- Source prompt: "Okay split. But I want env values also managable."
- Created: 2026-09-26T12:28:56Z
- Status: Direction selected (planned — see plans/20260926T122856Z-managed-env-and-screens-login-recipe-plan.md)

## Goal and context

Two coupled gaps came out of the login-seam work:

1. **Env values are invisible.** `${env.DRILL_PHONE}` / `${env.DRILL_PASSWORD}` refs parse and
   substitute at play time, but the *values* ride the play request body and vanish when the run
   ends. Nothing in Crucible stores or manages them; a human QA cannot set or inspect them
   without curl. The user wants env values to be a managed first-class thing.
2. **The login recipe is duplicated per template.** Each logged-in twin carries the full
   `ensure login` selector set (entry / phoneField / passwordField / submit / session) in its
   setup. Agreed direction ("Okay split"): selectors belong to the **screens registry**;
   templates should reference a screen's login recipe instead of re-declaring it.

Audience: QA operators using the Crucible UI; the templates/tests they author.

## Confirmed inputs and decisions

- User confirmed the split direction (screens hold the selector recipe) — accepted.
- User wants env values "also managable" — a management surface, not just request-body passing.
- Verified facts (this session):
  - `app_screens` schema: `(app_bundle_id, screen_id, entry_json, refresh_json, states_json, updated_at, revision)`.
  - `plans` has `env_json TEXT NOT NULL DEFAULT '{}'` and plan play forwards it into `runBatch`
    (`routes/manual.ts:835`).
  - `suites` has NO env column; `suites/:id/play` passes no env.
  - Template `variants_json[].env` persists and merges per lane (`playback.ts:1139`).
  - `expandEnvText` fails a step honestly on missing refs (`missing env: KEY`).
  - The screens listing route (`GET /api/app-screens`) serves everything to any logged-in client.

## Exploration

### Design axis 1 — where managed env values live

**Option A: `env_vars` keyset table + named scopes (recommended).**
New table `env_vars(scope, key, value, note, updated_at, updated_by)` with scope ∈ {global,
`app:<bundle>`, `plan:<id>`} resolved global → app → request-body override at play time
(`activeEnv` merge chain gains two earlier links). CRUD routes + a UI panel; secrets flagged
`secret: true` render masked and are write-only after creation. Fits every consumer (single
play, suite play, plan play) because resolution happens centrally in playback env merge.
Tradeoff: plaintext-in-sqlite remains for non-keyring values unless we add DPAPI-ish
encryption; new UI surface to build.

**Option B: extend `plans.env_json` only.** Zero new infra; plans already persist and forward
env. Tradeoff: env becomes plan-owned — a plain single-template play still can't see creds,
and "which plan holds DRILL_PASSWORD" is undiscoverable. Fails the "managable" ask outside
batch contexts.

**Option C: OS keyring (macOS Keychain) behind the server.** Strongest secrecy; no plaintext
at rest. Tradeoff: server becomes machine-bound (breaks the "any host runs Crucible against a
shared sqlite" property), keychain prompts can block CI, and backup/copy of the DB loses
values. Good later as a backing store for flagged secrets, not as the primary model.

### Design axis 2 — what the screens registry holds for login

**Chosen shape (user accepted the split):** `app_screens` grows a `login_json` column on the
relevant screen (e.g. screen `auth`): `{entry, phoneField, passwordField, submit, session}`.
Templates shrink to:

```yaml
setup:
  - ensure login:
      screen: auth
      phone: '${env.DRILL_PHONE}'
      password: '${env.DRILL_PASSWORD}'
```

Playback resolves `screen: auth` → looks up `login_json` for the template's app bundle.
Failure modes are explicit: unknown screen, screen without a login recipe, and (unchanged)
missing env refs. Back-compat: the full inline form keeps parsing (both block and old flow
form) — resolution prefers inline fields when present, so nothing breaks on save.

Rejected: putting creds in `app_screens` (screens are readable knowledge; secrets are
environment-scoped, not screen-scoped — and the listing route would leak them).

### Interaction between the two

With axis 1A + axis 2, a logged-in twin needs NO per-template values at all: selectors come
from the screen recipe, values from `env_vars(app:bundle)` at play time. The play request
body stays as an ephemeral override, which keeps drills from command-line simple.

## Open questions

1. **Scope granularity for env vars** — is `global → app → plan` the right chain, or do we
   need per-suite env too (suites currently have none)? Affects table shape and the UI panel.
2. **Secrets handling** — is plaintext-in-sqlite acceptable for dev drill creds (simplest),
   or should `secret:true` values be masked-in-UI + excluded from GET responses (write-only
   read-back shows only `set/unset`)? Affects routes and UI.
3. **UI placement for env management** — a Forge-page-style panel vs a tab on Settings vs
   inline on the template editor (contextual "this template uses DRILL_PHONE — unset").
   Affects build size of the UI slice.

## Next step

Pick answers to the three questions (or accept my defaults: chain = global+app+plan; masked
write-only secrets; a Settings-level env panel with template-editor hints). Then run
`$hms-plan-from-brainstorm` on this artifact to produce the implementation plan: schema
migration (guarded ALTERs), CRUD routes, playback merge-chain change, screens `login_json`
resolution + the template grammar change, then twin-template cleanup as the drill.
