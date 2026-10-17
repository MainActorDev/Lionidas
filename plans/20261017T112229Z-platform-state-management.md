# Platform State Management — Phase A (app states registry + `ensureState`)

- Plan status: **Ready** (pending-gate passed — all brainstorm questions decided)
- Source brainstorm: `brainstorm/20261016T090442Z-platform-state-management.md` (read in full, 2026-10-17)
- Decision log (all operator decisions, chat 2026-10-16, recorded verbatim-faithful in the brainstorm's *Decisions* section):
  - **Q1 — "Yes use the harness-level actuator."** Recipes may reference device/harness actuators (uninstall/reinstall, privacy grants). Blast radius contained by serialization, not refusal.
  - **Q2 — "mid-step is allowed."** `ensureState` valid in `setup:` AND mid-`steps:`.
  - **Q3 — "I'd say rebuild."** `ensureLogin`/`ensureLogout` re-expressed onto the new registry; one state system.
  - **Deep links — "we don't want to register deeplink for every screens."** Deep links are optional accelerators; the walk is the universal arrival; registration is lazy.
- Operator approved planning: "Run the planning" (2026-10-16), after the brainstorm reached *Direction selected* on Option A (grammar-first `ensure*` generalization).

## Objective and completion conditions

Make an app's preconditions **first-class platform data** so any case can declare its required state and the engine converges to it idempotently. Phase A is done when, verified live:

1. A case declaring `ensureState: fresh_install` (recipe = uninstall/reinstall) passes **twice consecutively against a dirty install** of the drill app — order-independent, no manual wipe.
2. A case declaring an arrival state (`on_<screen>`, recipe = walk) converges via the walk, and the **second consecutive play probe-hits** — step audit shows `path: "probe-hit"` (the walk was skipped).
3. A **legacy `ensureLogin` case, YAML untouched, is green** after migration onto the registry (login suite regression).
4. A **mid-steps** `ensureState` case (log out → log back in shape) runs green in one case body.
5. Full gates green: `pnpm typecheck` + `pnpm lint` + `pnpm vitest run --maxWorkers=2` (server, Node v24); `npx vue-tsc --noEmit` + `npx vite build` (web); `pnpm --filter web test:e2e` visual/a11y harness with regenerated baselines in the same commit.

## Scope

**In (Phase A):** `app_states` registry (table + history + API); `ensureState` grammar verb (setup + mid-steps); engine convergence executor (probe → recipe → verify, honest failures); actuator primitives — walk/steps, entry (tab/deepLink/navigate), relaunch-with-launchArgs, runtime signal, uninstall/reinstall, privacy grant; migration of `ensureLogin`/`ensureLogout` onto the registry (legacy YAML keeps parsing); app-states editing surface on the web UI; agent **read** tools + breakdown vocabulary; live drills.

**Out (explicitly deferred / rejected — do not build):** batch grouping by precondition and run-level provenance UI (Phase B); AI **write** proposals for state entries (AI seat behind hard stop, like build-config's pending gap); one-click "promote recorded flow to arrival recipe" button (paste/copy suffices in A); state graphs/planners; auto-inference of preconditions from `wait:` steps; conditional branching inside cases; multi-app state choreography; per-screen deep-link registration (rejected by operator).

## Constraints (authoritative project law — crucible skill + repo)

- All code lands via **feature branch + PR**, never direct to main. Planning artifacts (this file) get their own docs-only commit.
- `migrateM1` DDL placement: NEW TABLES go in the `db.exec` CREATE block; the guarded-ALTER loop is column-adds only (lesson f).
- `substituteStep` (template-env.ts) does **not** spread unknown fields — every new step field needs explicit additions there and in the step type (lesson c).
- New `@crucible/shared` modules are unimportable until added to `shared/package.json` `exports` (lesson i).
- Every mutating route needs the busy guard, and the guard's runs query **excludes `kind='manual'`** (self-deadlock lesson h).
- Attribution sweeps every row-creator: `created_by`/`updated_by` stamp from `req.user`; body-supplied identity ignored.
- Runs are immutable; status is always computed; manual runs never roll up to AC status.
- UI: plain-English labels (naming law); codenames only in code/routes. Engine names never appear in repo source (signature scan incl. comments/regex).
- Web UI changes pass the visual/a11y harness (`--update-snapshots` + disclose) and a vision check before "done".
- Node v24 for all server commands (`ls ~/.nvm/versions/node/` to confirm; PATH-prefix).

## Architecture / method

One registry, one convergence loop, three sources of truth unchanged:

```
app_states (per bundle_id, append-only history, revision++)
   state_id · label · probe_json · recipe_json · verify_json · provenance
        │
        ▼
ensureState step (case grammar, setup + mid-steps)
        │  resolve (bundle_id, state_id) → miss = explicit step failure
        ▼
probe (expect-shaped, short settle) ── hit ──► pass, audit {path:"probe-hit"}
        │ miss
        ▼
recipe (ordered): entry (tab/deepLink/navigate) → actuator (relaunch+launchArgs |
        signal | uninstallReinstall | privacyGrant) → steps (walk, grammar steps)
        ▼
verify (expect-shaped + via) ── fail ─► step fail, named reason
```

This is the existing `ensureLogin` loop (playback.ts:1400+) lifted from the login domain: idempotent, narrated, honest failures. `ensureLogin`/`ensureLogout` become registry entries `logged_in`/`logged_out`; the old verbs translate internally — legacy YAML untouched.

### Data shapes (v1)

`app_states` row:

| column | shape |
|---|---|
| `id` | `st_<rand>` |
| `bundle_id` | FK-ish to app catalog (follow `app_screens` pattern) |
| `state_id` | slug, per-bundle unique (e.g. `fresh_install`, `onboarded`, `logged_in`, `on_home`) |
| `label` | plain-English UI name |
| `probe_json` | expect-shaped: `{identifier \| label \| labelContains \| screen}` — REQUIRED (idempotence depends on detection) |
| `recipe_json` | `{entry?: {tab\|deepLink\|navigate}, actuator?: 'relaunch'\|'signal'\|'uninstallReinstall'\|'privacyGrant', launchArgs?: string[], signal?: string, permission?: string, steps?: [grammar steps]}` — at least one arm |
| `verify_json` | expect-shaped + optional `via` (tap-then-poll, from the login domain) — REQUIRED |
| `provenance` | `user` \| `ai+user` \| `import` (stamped, never model-asserted) |
| `revision`, `created_by`, `updated_at`, timestamps | house pattern |

`app_states_history` — append-only snapshot per edit (forensics: which revision a run executed, via step audit JSON).

Recipe steps reuse the case-grammar step shapes verbatim (same parser, same autocomplete vocabulary). Env refs `${env.X}` resolve at play time through the existing `expandEnvText` seam — this is what keeps credentials out of the registry (values live in env fields, as today).

### Interfaces

- **API**: `GET /api/apps/:bundle/states`, `GET/PUT /api/states/:id` (revision++, history append, provenance + attribution stamps), `POST /api/apps/:bundle/states` (create). PUT validates probe/recipe/verify against the grammar before writing.
- **Grammar**: `ensureState: <state_id>` step in `case-yaml.ts` (ACTIONS set, schema, emitter round-trip, `yaml-completions.ts` vocabulary); action added to the `StepAction` unions in `playback.ts:87` and `template-env.ts:39`, with explicit field carry-through in `substituteStep`.
- **Agent (read-only)**: MCP tools `states.list` / `states.get` + one system-prompt vocabulary line so breakdown/authoring proposes `ensureState` preconditions instead of implicit waits. Write tools deferred (disclosed gap, mirrors build-config).
- **UI**: states section on the **screens page** (the ensureLogin error text already directs users there — one home for "what the platform knows about this app"). Recipe `steps` edited with the existing YAML editor component; probe/verify as selector fields shaped like `expect`. Regenerate baselines same commit.

## Implementation stages (ordered, each with its own verification)

**S0 — Planning artifact commit** (docs-only, direct-to-main exception per repo law): this file.

**S1 — Grammar: `ensureState` verb.** `case-yaml.ts` (parse, validate, emit round-trip), `yaml-completions.ts`, `substituteStep` explicit field, playback `StepAction` union. *Verify:* grammar unit tests (round-trip incl. scalar quoting, unknown-state-id format errors, completions fixture) — engine execution stubbed fail-loud ("not yet executed by the engine") so S1 is shippable alone.

**S2 — Registry: table + API.** `app_states` + `app_states_history` in the migrateM1 CREATE block (fresh-DB + guarded-ALTER both proven by test); routes with busy guard, attribution, provenance stamps, shape validation. *Verify:* route-contract suite via `buildApp` (`CRUCIBLE_REQUIRE_AUTH:'0'`), FK/unique violations honest, migration idempotent on re-run.

**S3 — Engine: convergence executor.** playback `ensureState`: resolve (missing/incomplete → explicit failure naming the state, ensureLogin precedent); probe (launch-settle budget, short timeout) → hit = narrated no-op pass; miss → recipe (entry player reused from login; walk steps played like `recipeSteps` with overlay taps + `recordTap`; relaunch via `alloy_apps` close/open **always keeping `-uitest-live-refresh`**; signal via the refresh seam); verify (+`via`). Audit JSON `{stateId, revision, path, probeMs, stepsPlayed}` on the step row — this is Phase-B provenance for free. *Verify:* executor unit tests for every branch (probe-hit, probe-miss+walk+verify-pass, recipe step fail mid-walk, verify fail, missing entry, wrong-bundle entry); harness seeds a state row + fake-alloy.

**S4 — Device-scoped actuators.** `uninstallReinstall` (uninstall via the install seam, reinstall from the run's artifact, relaunch) and `privacyGrant` (booted-sim `simctl privacy`). **Wire-contract probes first** (lesson l): before writing either wrapper, live-probe the exact commands on a booted sim (privacy grant + revoke round-trip; uninstall + reinstall cycle; the app-terminate verb in the alloy app-control seam — exact verb verified, not assumed) and pin the observed flags/shapes in the task notes. **Serialization rule:** a device-scoped actuator asserts the current run exclusively owns the udid — busy-guard query excluding `kind='manual'` **and excluding self** (the run itself is active; the S3 self-deadlock lesson in a new costume); violation = honest named failure, never forced eviction. **Relaunch continuity is an explicit verification item**: a mid-run terminate+relaunch must keep the run's stream, evidence recording, overlay dims, and any Forge scenario pins alive (one drill under a pinned scenario proves it — see edge row 17). **Drill precondition:** `uninstallReinstall` needs a resolvable artifact (existing package or a build) — the drill task resolves this before running. *Verify:* guard unit tests (self excluded, parallel lane counted, manual session counted); wire-probe outputs committed with the task; relaunch-continuity drill green.

**S5 — Migration: rebuild `ensureLogin`/`ensureLogout`.** Data migration app_login/app_logout → `app_states` (`logged_in`/`logged_out`, steps-form recipes, entry objects, verify+via, `${env.PHONE}/${env.PASSWORD}`); playback translates legacy verbs to registry convergence internally **with the full legacy resolution order preserved**: app_states entry → app_login row (frozen, pre-migration data only) → **inline selectors on the case (oldest cases keep working untouched)** — the registry becomes the new first source, nothing that resolves today stops resolving. app_login/app_logout become read-only legacy (deprecated in place, like `projects.build_scheme`); screens-page login editor points at the states section. *Verify:* login-suite regression green unchanged; translation parity test per resolution source (registry-sourced, legacy-row-sourced, inline-sourced — three cases, same audit fields); precedence preserved.

**S6 — Web UI: states section.** Screens-page section per app: state list, editor (YAML editor for recipe steps; selector fields for probe/verify), provenance + revision display, plain-English labels. *Verify:* `vue-tsc` + `vite build`; `pnpm --filter web test:e2e` with regenerated baselines in the same commit; axe 0 serious; vision check both themes (defect checklist) — if vision tooling errors, say so; never substitute DOM metrics.

**S7 — Agent read tools + vocabulary.** `states.list`/`states.get` MCP tools; system-prompt line teaching `ensureState` at breakdown/authoring. *Verify:* tool contract test; authoring drill — agent drafts a case with `ensureState` precondition from registry vocabulary.

**S8 — Live drills + close-out.** On Foodiary (zero app-side changes required): (a) `on_<screen>` arrival state from a pasted recorded walk — case green, second play audit `probe-hit`; (b) `fresh_install` via uninstall/reinstall — dirty install, case green twice consecutively; (c) mid-steps logout→login shape green; (d) on an app with an existing `ensureLogin` case, legacy green. Full gates (see objective #5). Drill hygiene: end every drill with routing disabled + `scutil --proxy` clean if anything Forge-related was touched.

## Edge-case table (walk every row before review)

| # | Edge | Handling |
|---|---|---|
| 1 | Probe false-positive (probe hits, state actually dirty) | Probe must assert *identity* (specific identifier/screen), not mere presence. Probe-hit skips recipe+verify by design; a lying probe surfaces as the case's own step failure, and the audit names the probe that lied. Documented authoring rule on the editor. |
| 2 | Recipe fails mid-walk | Named step failure (`recipe step k failed: …`); state may be partial — the next `ensureState` probe decides; no silent retry, no partial-state masking. |
| 3 | Registry entry missing/incomplete | Explicit failure: `state '<id>' is not registered for <bundle> — create it on the app states page` (ensureLogin precedent; never silent skip). |
| 4 | Device-scoped actuator while another lane/manual session holds the udid | Guard violation → honest named failure (no eviction, no wait-forever). Sequential-lane contract makes intra-batch reuse safe. |
| 5 | Relaunch during a Forge-scenario run | Forge proxy state is device-global; relaunch must re-open with the run's pinned args and the scenario stays active — drill (a/b) run under a pinned scenario once to prove pins survive relaunch. |
| 6 | App crash mid-walk | Normal step failure; next convergence re-walks from probe. |
| 7 | State referenced for wrong bundle / typo'd id | Resolution failure names both bundle and state id. |
| 8 | N cases in a lane with the same arrival state | Lane contract serializes; first pays the walk, rest probe-hit — audit makes the amortization visible (Phase B formalizes grouping; A must not regress lane semantics). |
| 9 | `substituteStep` drops `ensureState` field | Explicit field additions in substituteStep + StepAction unions (lesson c); covered by a round-trip test through the env-substitution path. |
| 10 | DDL placement on fresh vs migrated DBs | CREATE-block for both tables; test runs migrate on empty AND pre-existing DB (lessons f, h). |
| 11 | New shared module unimportable | If any module lands in `@crucible/shared`, the exports-map edit is a listed step (lesson i). |
| 12 | Which recipe version ran a case? | Step audit carries `{stateId, revision}`; history table answers "what was revision N". |
| 13 | Probe during cold start (app not settled) | Probe uses the expect launch-settle budget; timeout is bounded and named in the failure. |
| 14 | YAML emitter quoting of state ids | Scalar-quoting rules tested in round-trip (wait-step precedent). |
| 15 | Legacy `ensureLogin` divergence after rebuild | Full resolution order preserved (app_states entry → frozen app_login row → inline selectors); parity test per SOURCE, not one aggregate; full login-suite regression. |
| 16 | Credentials leaking into registry | Registry stores refs (`${env.X}`) only; validation rejects literal credential-looking fields; env resolution at play time (existing seam). |
| 17 | Mid-run terminate+relaunch breaks run continuity (stream, evidence recording, overlay dims, Forge pins) | Relaunch continuity is an S4 verification drill, run once under a pinned Forge scenario; if any continuity seam breaks, the fix lands BEFORE the actuator ships, not after. |

## Validation and acceptance

Per stage as listed; final acceptance = the five objective conditions, each demonstrated by a cited run id / command output in the PR description. Self-review (hms-review-detailed-plan + crucible plan-self-review checklist a–r) before the human gate; the operator audits diffs; merge is human-only.

## Rollout / handoff

Feature branch `feat/app-states`, one PR, stage-per-commit (S1…S8), planning artifact committed first and separately. After merge: screens-page states section is the authoring home; `ensureLogin`/`ensureLogout` deprecated-but-parsed; Phase B (batch grouping, run-level provenance UI) and the AI write-proposal seat are follow-up brainstorms — recorded in DEFERRED.md at close-out so they don't rot silently.
