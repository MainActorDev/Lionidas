# Review — Screen Registry UI Plan

- Reviewed: `plans/20260924T052218Z-screen-registry-ui-plan.md` (created 2026-09-24T05:22Z, status Ready)
- Evidence sources: plan + live code verification 2026-09-24 (`shared/src/yaml-slots.ts`, `shared/src/yaml-completions.ts`, `server/src/routes/app-screens.ts`, `server/src/manual/screen-runner.ts`, `server/src/routes/manual.ts`, `web/package.json`, `shared/package.json`)
- Verdict: **Needs revision** (original) → **Ready for implementation** after operator answers + plan revision on 2026-09-24; see final section.

## Traceability summary

Objective → stages 1–3 → per-stage acceptance → validation section: consistent
and traceable. Out-of-scope matches the user's directive (recorder → BACKLOG
#10, done). Branch dependency on PR #1 is stated and correct. Evidence ledger
claims were independently re-verified in code; two claims failed
verification (F1, part of F6).

## Findings (prioritized)

### F1 — HIGH (confirmed defect) — Stage 3b: stateHolds import is infeasible as written
- Plan (line 117-118): "the same `stateHolds` logic **imported from
  `screen-runner.ts` (pure, shared module)**".
- Verified: `stateHolds`/`selectorMatches` are exported from
  `server/src/manual/screen-runner.ts:45,64` — a **server** module. The web
  app imports only `@crucible/shared` (`web/package.json` dep
  `workspace:../shared`). Web cannot import server code in this workspace.
- Consequence: verify-against-live (3b) cannot be implemented per plan.
- Correction: **move `stateHolds` + `selectorMatches` (and the `SnapNode`
  shape) into `shared/src/app-screens.ts`** (registry domain already lives
  there); `screen-runner.ts` re-imports from shared. Pure move, no behavior
  change; runner's 12 tests pin behavior.
- Verify fix: plan line updated; after implementation, server tests green +
  a shared-side unit test for `stateHolds` (the stage-3 test the plan
  already lists).

### F2 — MEDIUM — Stage 1: completions must be app-scoped; plan doesn't say so
- Plan 1a: screens aggregated "from all bundles, tagged with bundle id" —
  the tag exists but no rule states **completions filter to the case's own
  `app:` bundle**. Screen ids are only unique per bundle (PK is bundle+id);
  two apps can both have `home`.
- Consequence: unscoped suggestions offer screens that save-time validation
  then rejects — the authoring annoyance this arc exists to remove.
- Correction: 1b adds — screen completions filter by the `app:` value in the
  current buffer; when the case has no `app:` line, show all with the bundle
  suffix. Fixture test with two bundles sharing a screen id.
- Verify fix: plan text + the fixture test in stage-1 tests.

### F3 — MEDIUM — Stage 2: PUT is total-replace; lost-update risk undisclosed
- Verified: `PUT /api/apps/:bundle/screens` does `DELETE FROM app_screens
  WHERE app_bundle_id = ?` then reinserts (`app-screens.ts:31-33`) —
  last-writer-wins by construction. Two editors, or an editor + a probe
  "add as state" (stage 3) saving concurrently, silently destroy one side's
  changes. Also: a case save resolving screens mid-replace can transiently
  see an empty registry.
- Consequence: real data-loss path in the exact workflows this plan builds.
- Correction (decision needed, not silent): minimum — re-fetch + diff before
  save, warn on mismatch (cheap, no schema change); alternative — `PUT`
  gains an `If-Match`-style revision (guarded column + compare). Ask the
  operator which; record in the plan.
- Verify fix: plan names the chosen mitigation and its test (diff-warn path
  or revision 409 path).

### F4 — MEDIUM — Stage 1b: two-word action `expect screen` breaks the slot regex
- Verified: slot detection parses the action as `/^(\w+)\s*:/`
  (`yaml-slots.ts:61`) — `\w+` cannot match a space, so `expect screen: x`
  parses as action `expect` and falls into the **scalar on-value branch**
  (line 65), offering label/identifier vocab — wrong slot entirely.
- Consequence: the plan's `screen-state` slot is unreachable without first
  extending action parsing to two-word verbs. The risk section's
  "prefix-exact fallback" is not enough — the regex change is required work,
  not contingency.
- Correction: 1b adds an explicit work item — extend action extraction to
  recognize `expect screen` (and keep `expect` scalar behavior intact);
  slot tests cover both `expect: x` and `expect screen: x` lines.
- Verify fix: plan text + slot-classification tests for both forms.

### F5 — LOW — Stage 3: probe session semantics unverified
- "Start (or reuse) a manual session": whether a second session on an
  already-driven device is allowed, and mid-probe expiry (SESSION_NOT_FOUND
  410 observed live earlier this session), are unchecked.
- Correction: implementation note — probe degrades to a clear error state on
  410/expiry; concurrency behavior checked during stage 3 build.

### F6 — LOW — Wording: "same preference order as selector.ts resolution"
- Verified: `selector.ts` resolveSelector's policy is *hittable-preferring*
  (its own comment says pool policies differ); the identifier→label
  preference the plan means is `screen-runner.ts selectorMatches`'s order,
  not selector.ts's. The proposal logic should live in shared (with F1's
  move) and carry its own test — the plan's stage-3 test then covers it.

### F7 — OBSERVATION — Registry routes carry no role gate
- Verified: no `requireRole` on the screens routes. Consistent with
  neighboring template routes (PUT yaml also ungated) on this LAN-internal
  app — recorded, no change requested.

## Human questions — ANSWERED 2026-09-24 (session)

1. **F3 lost-update mitigation** — operator chose: **revision guard** (not
   the diff-warning recommendation).
2. **F2 default** — operator: **"do with your recommendation"** → app-scoped
   completions confirmed.

## Verdict after revision

All five required plan edits applied (F1 shared-move, F2 scoping, F3
revision guard, F4 two-word parsing, F5/F6 notes); decision log added to the
plan. **Ready for implementation** — stage 0 (sketches) is the first gate.

## Required plan edits before implementation

1. F1: replace the screen-runner import claim with the shared-move work item.
2. F2: add app-scoping rule + fixture test to 1a/1b.
3. F3: add chosen mitigation (after question 1) + its test.
4. F4: add the two-word action parsing work item + tests to 1b.
5. F5/F6: implementation notes as written above.

## Scope of this review

Paper review against live code; no implementation executed. Properties
inspected: feasibility of cited seams (verified), coverage vs objective,
ordering, test placement, data-safety of the registry write path. Requires
execution to confirm: slot-regex behavior after change, sketch outcomes
(stage 0 is a user gate), probe concurrency behavior (F5).
