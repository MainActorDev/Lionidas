# Declared Preconditions — setup Block + System-Dialog Interceptor — Scoped Plan

> **For Hermes:** TDD, small batches, commit per task. Verify each with live drills at the end.
> **Proven mechanism (drill run_852f6fbc):** fresh install → onboarding carousel blocks the flow; taps warn-pass with `screenChanged: false`; an iOS **location permission dialog** (outside app AX tree) appeared mid-flurry. The expect layer is honest — the missing pieces are (1) declared preconditions, (2) system-dialog visibility.

## Goal

A case can declare the state it assumes: `setup:` steps (guarded, no-op when already satisfied) + playback that names system dialogs instead of tapping into the void. Acceptance: fresh-install run of a case WITH a setup block passes without manual onboarding dismissal; a case WITHOUT setup fails with a reason naming the blocker.

---

## Task 1 — YAML: `setup:` section + `when:` step guard

**Files:** `shared/src/case-yaml.ts`; test `shared/test/case-yaml.test.ts` (extend).

- `YamlCase` gains optional `setup?: YamlStep[]` (same step schema as `steps:`).
- Step schema gains optional `when?: string` — a label fragment. Semantics: *run this step only if an element matching `when` is visible* (checked live, once, before the step). Absent element → step is a **no-op skip** with reason `when not shown: <fragment>` — NOT a failure, NOT optional-miss.
- Validation rules (errors with line numbers, existing style):
  - `when:` only valid inside `setup:` steps — in `steps:` it's an error (`when is a setup-only guard; steps always run`)
  - `when:` on scroll/runFlow steps → error (only tap/type/expect make sense; keep v1 small)
  - empty `setup:` → error (authoring mistake)
- Serialization: `caseToYaml` writes `setup:` before `steps:` with the same step serializer; `when:` round-trips.
- Recorder: manual sessions record only `steps:` — unchanged; setup is hand-authored YAML (state this in the guide row).

**Tests:** parse `setup:` with `when:`; `when` in `steps:` errors; empty setup errors; `when` on scroll errors; round-trip; unknown keys in setup steps error (existing unknown-key machinery applies since it's the same step validator).

## Task 2 — Playback: setup phase + when-guard execution

**Files:** `server/src/manual/playback.ts`; test `server/test/playback-setup.test.ts` (new, fake-alloy harness from playback-verify.test.ts).

- `PlaybackStep` gains `when?: string`.
- After app launch + first settle, BEFORE main steps: execute `setup` steps through the same step engine (same insStep, idx continues into the same run_steps — `flow: 'setup'` on each so the run detail groups them; run verdict treats setup fail as run fail, setup skip-by-when as neutral).
- `when` guard evaluation: one snapshot, `countMatches(nodes, { labelContains: when, ignoreCase: true }) > 0` → run the step; else skip immediately (no settle-poll wait — when-guards must be fast).
- Template storage: `templates.steps_json` unchanged; setup lives in a new `templates.setup_json` column (migration in schema.ts + routes/templates.ts PATCH accepts `setup`). Rationale: keeps `expandFlows`/steps consumers untouched; run_steps already has `flow` for grouping.
- `caseToYaml`/`parseCaseYaml` map `setup:` ↔ `setup_json` in the templates routes + web API shapes (`web/src/api.ts` or wherever Template type lives — follow the existing app field).

**Tests:** when-shown → step runs; when-not-shown → skip with reason; setup fail → run fails; setup steps appear in run_steps with flow='setup'; main steps run after setup passes; no setup column → behaves exactly as today (regression).

## Task 3 — System-dialog interceptor during settle

**Files:** `server/src/manual/playback.ts`; test extends `playback-setup.test.ts`.

- **[self-review correction]** The naive trigger — "app AX tree empty → inspect" — is WRONG for permission dialogs: iOS renders them in SpringBoard, and the drill (run_852f6fbc) showed the app's AX tree stays populated behind the dialog (taps still resolved, labels visible). Empty-tree only catches app-side blanking. Instead, TWO triggers:
  1. **Run-start inspect** — one `alloy_alert { action: 'inspect' }` right after the launch settle gate, before the first setup/main step. Cheap (one dispatch), catches dialogs that block from the very first frame.
  2. **screenChanged:false correlation** — when post-tap verification records `screenChanged: false`, dispatch one inspect before writing the warn. Dialog present → **upgrade the warn to a fail**: `blocked by system dialog: <text>` (inspect returns text/buttons). No dialog → warn stays (toggle/checkbox case).
- Both triggers cap at one inspect per site (no polling spam).
- v1 does NOT auto-dismiss: failing loudly with the dialog's name is the honest default; auto-accept is a policy decision (privacy dialogs auto-accepted in tests = silent data-grant) — edge case #8, revisit on demand.
- Empirical pin before implementing the correlation trigger: Task 5's fresh-install drill must capture what `alloy_alert inspect` actually returns over the location dialog (text? buttons? empty?) and what the AX tree contains while it's up — if inspect can't see SpringBoard dialogs either, the interceptor degrades to run-start best-effort + documented limitation, and pre-grants (`simctl privacy`) become the primary path (already in Task 5's drill script).

**Tests:** run-start inspect sees dialog → fail before step 1 with named dialog; screenChanged:false + inspect sees dialog → fail with named dialog; screenChanged:false + no dialog → warn stays (regression of existing behavior); inspect errors → fail-open (warn stays, run proceeds).

## Task 4 — Web: outline + guide rows

**Files:** `web/src/components/CaseEditorPanel.vue`; `web/src/pages/GuidePage.vue`; `web/src/composables/useYamlEditor.ts` + `shared/src/yaml-completions.ts` if slot-driven.

- Outline renders a `setup` group header before steps (same outlineFromSteps; tag setup steps, reuse existing soft-badge style for when-skips).
- Completions: `setup:` offered at top level; `when:` key offered inside setup steps (vocabulary already flows from the templates vocabulary endpoint — add the key there).
- Guide rows: `setup:` (declared preconditions, when-guards no-op when satisfied) and `when:` (setup-only guard) in the yaml editing card.

**Tests:** existing web checks (vue-tsc) + completions unit tests in `shared/test/yaml-completions.test.ts` if the slot map is tested there.

## Task 5 — Drills (live, fresh install)

1. **Positive:** uninstall intl app → install from store → author setup block on a copy of the privacy-policy case (`when:` onboarding dismissal + grant-location-via-taps if needed) → run → expect: setup skips/passes visibly, main flow passes. NOTE: location permission needs the dialog interceptor or a pre-grant via `simctl privacy booted grant location <bundle>` — use the simctl pre-grant in the drill setup script (deterministic), keep the interceptor for detection.
2. **Negative:** same fresh install, case WITHOUT setup → expect: fail with named blocker (dialog or screenChanged+expect miss), not a pass.
3. **Regression:** normal (already-onboarded) run of both existing cases → pass, setup steps skip-by-when, zero new snapshots when no guard fires.

---

## Edge cases

| # | Case | Behavior |
|---|---|---|
| 1 | `when:` matches transiently during animation | Guard is one snapshot at step start; if it flickers, step skips — author's `when` should target settled labels. Documented in guide |
| 2 | setup step fails mid-block | Run fails (setup is precondition); reason carries the step |
| 3 | when-fragment matches multiple elements | Fine — guard is existence, not uniqueness (countMatches > 0), unlike expect |
| 4 | system dialog appears mid-main-steps | Task 3 fires in settle-poll of any step — same named failure |
| 5 | app crashed (process dead) | Existing watchdog/abort owns it; interceptor only when process alive |
| 6 | `setup:` + runFlow inside setup | v1: runFlow in setup → validation error (compose setup INTO cases instead); keep small |
| 7 | optional + when on same setup step | Allowed; when-skip reason wins (guard checked first) |
| 8 | auto-dismiss policy | v1 never dismisses — named fail only; a future `permissions:` grant block (simctl privacy pre-grants) is the follow-up |
| 9 | YAML completions offering `when:` inside `steps:` | Completer offers it only in setup context (slot map keyed by section) |
| 10 | Templates API consumers (old web) reading new column | Column is nullable; API adds `setup` field only when present — additive, no break |
| 11 | **[self-review]** `when:` fragment matches an element that exists on BOTH onboarding and main screens | Guard fires (step runs) though not onboarding-specific — acceptable: when is a "dismiss if shown" guard, not a screen identity check; author picks distinctive fragments |
| 12 | **[self-review]** setup tap itself gets `screenChanged:false` warn (dismissing onboarding changes to ANOTHER onboarding page with similar AX sig) | Possible false warn; acceptable in v1 (warn ≠ fail); if noisy, upgrade when-guard steps to also verify post-state |
| 13 | **[self-review]** run_steps evidence (screenshot) for when-skips | Skip writes no screenshot today — keep (skips are cheap, no dispatch happened) |

## Out of scope (recorded, not built)

- Auto-accept/auto-dismiss policy for system dialogs (needs a per-case `permissions:` grant block — natural follow-up using `simctl privacy`)
- Fresh-install run mode (uninstall/install per run)
- Screen anchors (per-step recorded screen verification) — separate plan; setup+interceptor may reduce its value, re-evaluate after usage
