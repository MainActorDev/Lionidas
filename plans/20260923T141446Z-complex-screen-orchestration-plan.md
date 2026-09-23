# Complex-Screen Orchestration — R2 Screen-State Runner

- Source brainstorm: `brainstorm/20260923T141446Z-complex-screen-orchestration.md` (+ its Decisions section: R2 accepted "production-grade by any means necessary"; app-level registry lean; scripted responses accepted)
- Created: 2026-09-23
- Status: **Ready** (post-review F1-F5 applied — see `reviews/20260923T141446Z-complex-screen-orchestration-plan-review.md`)

## Decision log (provenance)

| # | Decision | Source |
|---|---|---|
| 1 | R2 screen-state model accepted; production-grade bar | User: "R2 … By any means necessary" (2026-09-23) |
| 2 | Screen registry = **app-level shared** (one map per app; cases reference) | User accepted the plain-English elaboration endorsing app-level (2026-09-23) |
| 3 | Scripted responses accepted into scope | User: "Why not" (2026-09-23) |
| 4 | **Verified correction to the brainstorm**: scripted responses (`seq_json` per preset: `[{status, bodyPath, delayMs}]` sequence, per-active-run `seqIndex`, plus `failure: reset|malformed`, `throttle_kbps`, matcher `guards`) **already exist** in forge (`proxy.ts:97-110`, `matcher.ts`, presets schema). The brainstorm's class-8 gap is overstated: only *UI authoring* of seq is missing, not the engine. | code read 2026-09-23 |
| 5 | Verification guards for warm swaps (request-verification load-bearing, swap-window bound, black-display check) baked into B1-world design | brainstorm round-2 research (tapsmith #174/#178 precedents) |
| 6 | Runner facts: `YamlStep` actions today = tap\|scroll\|type\|runFlow\|expect\|alert\|location; linear arrays; `optional`/`when` guards; variants `{id, networkScenario, env}`; scenarios = preset sets; presets = per-endpoint fakes w/ seq+guards | `shared/src/case-yaml.ts`, forge sources, DB schema (read 2026-09-23) |

## Objective

Crucible cases become **orchestrations of screens and worlds** instead of tap-scripts: an app-level screen registry (route/entry, refresh gesture, named states), runner verbs `arrive`/`refresh`/`world`/`expect screen`, scenario *sets* for variants, and declarative state assertions — with every existing v1 case lifted mechanically and the 907-test suite green throughout. Done = all acceptance checks per stage pass, the intl drill case runs as a production R2 case, and no v1 case changes behavior.

## In / out of scope

**In (stages):** scripted-response UI surfacing (small); scenario sets (A1) in variants + forge apply; screen registry (schema, validation, app-level storage); case schema v2 (`screens:` refs, `worlds:`, `entry:`) with v1 lift; runner verbs (`arrive`, `refresh`, `world` swap w/ 3 guards, `expect screen` incl. transitions); playback integration + run-detail rendering of world/state events; intl-drill conversion as proof.

**Out:** Gherkin/BDD layer (rejected in brainstorm); cross-case state dependencies (deliberately — suites sequence, cases stay self-contained); Android adapter (parked backlog #1 — orthogonal); web UI redesign beyond what new steps render; per-case screen definitions (registry is app-level).

## Stage S1 — scripted responses: surface what exists (small)

Engine exists (D4); add: (a) preset editor field for `seq` (array editor: status/bodyPath/delayMs rows) in the forge UI preset form; (b) guide note documenting seq+failure+throttle as the resilience toolkit; (c) tests pinning seq-per-run reset (`seqIndex` keyed by activeRunId) and guards-fail-closed — they exist in code but no test pins them (verify: `grep seq server/test` — if absent, add).

## Stage S2 — scenario sets (A1)

- `variants_json[].scenarios: string[]` (plural); keep `networkScenario` as back-compat sugar for `[x]` (read + write path: writing singular normalizes to plural).
- Validation at variant save: all names resolve; **conflicts = duplicate `(method, path_pattern)` across the union → rejected** (decidable; catches two scenarios shipping the same endpoint — review F2). Glob/regex *shadowing* (one pattern plausibly subsuming another — undecidable in general) is a save-time **warning** listing the pair, never an error.
- Playback: activation applies every scenario's presets in the union (dedupe by preset id); per-request attribution stays (already tags preset id).
- Tests: set validation (resolve, conflict), union application order-stable, singular back-compat, conflict surfaces as 400 with both preset ids.

## Stage S3 — screen registry (app-level)

- New table `app_screens(app_bundle_id, screen_id, entry_json, refresh_json, states_json, updated_at)` — PK `(app_bundle_id, screen_id)`; registry YAML export/import via API (`GET/PUT /api/apps/{bundle}/screens`) so the map is versionable in git if the team wants.
- `entry_json`: `{tab?: selector, deepLink?: string, navigate?: [steps]}` (any one). `refresh_json`: `{gesture: pull|tab-retap|back-forward|deepLink, selector?: string}`. `states_json`: `{name: {all?: [selectors], any?: [selectors]}}` — a state matches when its selector-set holds (reuse existing selector matcher).
- Validation: state selector-sets non-empty; at least one entry; refresh gesture known.
- No UI authoring yet (YAML via API + guide); the cases page *references* screens by id.

## Stage S4 — case schema v2 + lift

- `YamlCase` v2 fields (all optional; v1 shape stays valid): `worlds: [{id, scenarios: string[], env}]` (supersedes inline `variants` — same storage, new authoring key; singular `networkScenario` still accepted), `entry: {screen: string, mode?: tab|deepLink|navigate}`, `steps` gains verbs: `arrive: <screen>`, `refresh: <screen>`, `world: <world-id>`, `expect screen: <screen>.<state>`, `expect screen: <screen>.state != <state>` (transition/negation forms).
- Parser: v2 keys validated (screens/worlds must resolve against registry + case's own worlds); v1 cases parse identically (lift = no-op at parse; the runner wraps any v1 case as one implicit screen named `main` with a null-refresh and no states — purely internal).
- `case_versions` snapshot includes resolved registry refs (screen/state names + their selector sets at save time) so historical runs re-resolve deterministically even if the registry changes later. **Registry change ≠ history rewrite.**

## Stage S5 — runner verbs + guards

- `arrive: screen` — resolve entry (deepLink → `simctl openurl`; tab → tap selector; navigate → replay steps), then settle (existing expect settle budget machinery).
- `refresh: screen` — registry gesture: pull (coordinate drag from screen mid), tab-retap, back-forward, deepLink re-entry. **Guard 1 (load-bearing): request verification** — after the gesture, the proxy must observe ≥1 request matching the active world's scenario presets within a budget (default 10s) or the step fails `WORLD_NOT_CONFIRMED`; traffic attribution is the proof.
- `world: <id>` — swap active scenario sets on the proxy (deactivate current, activate target), then the *next* `refresh`/`arrive` triggers guard 1. **Guard 1 mechanism (review F3): the step polls the traffic table** (in-process DB, keyed by run id + the target world's preset-id set) at short intervals within the budget; poller injectable for tests — no new proxy API. **Forge exclusivity (review F1):** forge holds ONE active preset set with a single `activeRunId` (verified `forge/state.ts`); scenario-carrying runs — activation today, `world:` swaps here — hold it **exclusively**: starting one while another is active fails fast 409 `FORGE_IN_USE` (checked by the existing T7 pre-flight surface); post-run restore returns to *pre-run* state regardless of swaps. Per-run preset selection (header/device-keyed matching) is the recorded future scale-out, explicitly out of scope. **Guard 2: swap-window bound** — after N consecutive world swaps without a relaunch (default 8, provisional — derived by analogy, tuned from S6 data; per-case configurable), force a relaunch lane note and reset the counter.
- `expect screen: X.state` — poll selector-set to true within budget; `!=` form polls to false; transition form (`state was A, becomes B`) = two polls with a max window. **Guard 3: black-display check (review F4)** — before passing any screen-state expect, capture via existing `alloy_screenshot` and pixel-scan excluding the top/bottom 12% bands (status bar / home indicator keep rendering there); all-near-black → fail `DISPLAY_DEAD` (the existing silent-flake class made visible).
- Run detail: steps log renders `world sg → my` transitions and `screen tracking: error → loaded` as first-class rows.
- Tests: verb parsing; arrive via each entry mode (fake engine); guard 1 pass/fail (proxy fake observing/not-observing request); guard 2 counter + forced relaunch; guard 3 black-frame rejection; state poll true/false/transition; v1 lift equivalence (same engine ops emitted for a lifted v1 case as today).

## Stage S6 — conversion + proof

- Convert `intl drill` to R2: one case, `worlds: [sg, my, empty]` (scenario sets), `entry: tracking-check-rates`, steps: `arrive` → `expect screen loaded` → `world: my` → `refresh` → `expect screen loaded`… payload-derived assertions (COUNTRY env retired).
- Live drill on simulator: batch runs 1 launch + 2 swaps; run detail shows transitions; traffic panel attributes both worlds' requests; durations compared vs the old 3-lane run (expect minutes saved).
- Gate green; commit per stage.

## Edge & failure cases

- Registry references a screen deleted/renamed → case save fails validation (name the ref); historical runs unaffected (S4 snapshot).
- World swap with app cached in memory → guard 1 catches it (no request → WORLD_NOT_CONFIRMED) → author picks a stronger gesture or converts case back to relaunch lanes (both modes always coexist).
- Deep-link entry with app not running → `arrive` falls back to launch+openurl (simctl handles cold deep links) — one path, both cases.
- Proxy down mid-world-step → pre-flight (T7) already 409s scenario runs; world step surfaces the same honest error.
- Concurrent scenario-carrying runs → **forge exclusivity (review F1)**: single active preset set means scenario runs serialize at the forge — second run 409 `FORGE_IN_USE` until the first restores pre-run state; per-run selection is the recorded future scale-out, not this arc.

## Validation & acceptance

- [ ] S1: seq UI + pinned tests (engine behavior unchanged, only surfaced).
- [ ] S2: sets validate, conflict-reject, apply as union; singular back-compat (tests).
- [ ] S3: registry CRUD + validation; YAML export/import round-trips.
- [ ] S4: v1 case parses byte-identical behavior (lift equivalence test); v2 fields resolve + snapshot into case_versions.
- [ ] S5: all three guards have pass AND fail tests; verbs emit expected engine ops; black-display rejection proven with a synthetic all-black frame; forge exclusivity — second scenario run 409s during an active one; swap sequence restores pre-run presets.
- [ ] S6: converted drill case passes live on simulator with 1 launch + 2 verified swaps; transitions render in run detail; 907+ tests green at every stage boundary.
- [ ] No v1 case changes behavior (regression pin across the suite).

## Rollout

Staged merges behind the green gate; feature is additive (v1 untouched until S6's single deliberate conversion). The R2 model becomes the documented authoring path in the guide; v1 remains supported indefinitely (lift is transparent).
