# PLAN (Ready) — Runner latency stages 1+2: poll tuning + push-based GUARD 1 + wait-vs-work telemetry

- Source brainstorm: `brainstorm/20260925T112947Z-drill-latency-budget.md` (revised 2026-09-25T11:40Z)
- Plan status: **Ready** (pending gate passed 2026-09-25)
- Baseline for all acceptance checks: drill `run_b5207d00` (8/8, 2026-09-25)

## Decision log (operator answers, 2026-09-25, clarify form)

1. **First-PR scope = stages 1+2** (retune poll constants + push-based GUARD 1, Crucible-only, no app change). Stages 3 (Bellwether ack channel) and 4 (AX-diff stream) are OUT of scope; Q2 of the pending plan (ack semantics) is moot.
2. **Telemetry lands with/before stage 1** — per-step wait-vs-work timing in the run report, so speedups are provable in the UI.

## Objective and completion conditions

Make screen-state drill steps observe the app at the app's true speed instead of poll-tick speed, without weakening any correctness guard. Done when:
- (C1) A re-run of the `run_b5207d00` template (same drill, same 8 steps) passes 8/8.
- (C2) Measured from the new telemetry: `refresh home` steps ≤ 1.5s each (baseline 3.93s/3.99s) and `expect screen` steps ≤ 1.0s each (baseline 2.19–2.34s).
- (C3) All existing suites pass unchanged in semantics — GUARD 1/2, abort latency, dialog handling keep their contracts (tests below).
- (C4) The run report (API + UI where steps render) shows wait-vs-work split per step.

## In / out of scope

In: `server/src/manual/screen-runner.ts`, `server/src/manual/playback.ts` (poll constants + telemetry), GUARD 1 event subscription, `server/test/screen-runner.test.ts` + a playback timing test, run-report surface for timing split.
Out: Bellwether 0.4 / any app-side change (stage 3), the device daemon AX-diff stream (stage 4), launch readiness gate, dialog drains, abort-latency floor (250ms poll floor stays), `maxSwaps`.

## Verified facts the design rests on

- Every wait is sleep-poll; granularities: `worldConfirmPollMs: 500` (screen-runner.ts:55), `statePollMs: 1000` (screen-runner.ts:56), `CRUCIBLE_EXPECT_POLL_MS ?? 2000` (playback.ts:754). Budgets are env-overridable; poll intervals partially (expect + step-settle only).
- The typed bus already emits `forge.traffic.hit` synchronously at insert time with `runId`, `matchedPresetId`, `latencyMs` (manager.ts:86 for file-tail ingest, proxy.ts:78 for live mode, bus.ts:25 shape) — GUARD 1 needs only a subscription; the event carries everything the SQL predicate checks.
- `step.finished` already carries `durationMs` (playback.ts:508) and `insStep.run(...)` writes `evaluated_json` — the telemetry rides an existing payload path.
- `ScreenRunner` construction site: playback.ts:1007 — deps object assembled there; `bus` is already on playback deps (playback deps interface, `deps.bus`).
- Screen-runner tests exist with fast-budget fakes (`settleMs: 50, worldConfirmMs: 120, worldConfirmPollMs: 20`) and cover GUARD 1 pass/fail/run-attribution (screen-runner.test.ts:75–100).
- Baseline numbers: refresh 3.93s/3.99s, expect screen 2.19–2.34s, proxy latency 0–2ms, app signal→fetch ~0.3–0.5s.

## Architecture / method

### Stage 1 — poll-constant retuning (surgical, no new code paths)

1. `screen-runner.ts:55` `worldConfirmPollMs: 500 → 150`.
2. `screen-runner.ts:56` `statePollMs: 1000 → 250`.
3. `playback.ts:754` `CRUCIBLE_EXPECT_POLL_MS ?? 2000 → ?? 250`.
4. Make the two screen-runner poll intervals env-overridable to match the existing pattern: `CRUCIBLE_WORLD_CONFIRM_POLL_MS`, `CRUCIBLE_STATE_POLL_MS` (same `Number(process.env[...] ?? default)` shape used at playback.ts:754/856).
5. Do NOT touch: `settleMs`, `worldConfirmMs` budgets, `CRUCIBLE_EXPECT_SETTLE_MS`/`MAX_MS`, step-settle 60ms poll, `awaitUiStable`, launch readiness gate, abort 250ms floor.
   Rationale: budgets are correctness ceilings; ticks only quantize how soon a satisfied predicate is noticed. Finer ticks never weaken a predicate, they only add reads (bounded: 10s/150ms ≤ 67 reads worst case vs 20 today).

### Stage 2 — push-based GUARD 1 (event race instead of table poll)

1. Extend `ScreenRunnerDeps` (screen-runner.ts:20) with optional `onTrafficHit?: (cb: (e: { runId: string | null; matchedPresetId: string | null }) => void) => () => void` — a subscribe returning an unsubscribe. Playback wires it to `deps.bus.on('forge.traffic.hit', ...)` at the construction site (playback.ts:1007).
2. In `refresh()` (screen-runner.ts:253–262): replace the `while` SQL poll with `await Promise.race([firstMatchingHit, budgetTimeout])` where `firstMatchingHit` resolves when the subscription observes an event with `runId === this.d.runId && matchedPresetId !== null && ts-marker check`. Keep the SQL COUNT as the *immediate* pre-check (a row may have landed before the race starts). On timeout → existing `SWAP_NOT_CONFIRMED` code and note, unchanged contract.
3. Marker semantics preserved: only traffic attributed to this run (`runId`) counts, and only AFTER the gesture's `markTs`. The event payload has `runId`/`matchedPresetId` but not `ts` — the handler filters on `runId`+`matchedPresetId` and the SQL pre-check+final COUNT query (run once after resolution for the count in the note) guarantees the epoch rule; if the resolved count is 0 (race edge: event for a different marker window), re-enter the race with the remaining budget. This keeps the note's `N request(s) confirmed` semantics identical.
4. Fallback contract: when `onTrafficHit` is absent (tests, older callers), the method degrades to today's poll loop verbatim. This keeps screen-runner.test.ts's three GUARD 1 cases meaningful with and without the subscription.
5. Abort-awareness: the race's timeout leg uses the existing budget; unsubscribe in a `finally` so an aborted run never leaks a listener.

### Telemetry — wait-vs-work split per step (lands with stage 1)

1. In playback's step loop, wrap the existing settle/wait regions with `performance.now()` marks: `waitMs` = sum of time spent inside poll loops/races (expect settle, step settle, awaitUiStable, screen-runner verbs' internal waits — the runner returns it in `VerbOutcome` as optional `waitMs`), `workMs = durationMs - waitMs`.
2. Store into `evaluated_json` alongside the existing action/note fields (additive; consumers that ignore unknown keys are unaffected) and include in `step.finished` payload (additive key).
3. Surfaces: `runs.ts` step payload already returns `evaluated_json`-derived fields where used; add `waitMs`/`workMs` to the step detail (runs.ts:173/184) — UI rendering of the split is a thin add-on if the steps panel displays it; minimum bar is API-visible.

## Requirements and constraints

- No behavior change to any pass/fail predicate. A step that passes today must pass after; a step that fails today must fail with the same code.
- Every new/changed interval stays env-overridable (existing pattern), with today's semantics as the documented default only where changed by this plan.
- No app-side change, no new dependencies, no Bellwether change.
- Preserve: abort ≤ one step + watchdog (B2); readiness gate; maxSwaps dialog-drain semantics.
- Tests: extend `screen-runner.test.ts` — (a) event-resolved confirm fires as soon as the bus emits a matching hit (fake clock or generous budgets); (b) non-matching hit (other run / no preset) does not resolve; (c) timeout still yields `SWAP_NOT_CONFIRMED`; (d) fallback path (no subscription) unchanged. Add one playback-level test asserting `evaluated_json` carries `waitMs`+`workMs` summing to `durationMs` (±5ms tolerance).

## Implementation stages (ordered)

1. **Telemetry plumbing** (VerbOutcome.waitMs + playback marks + runs.ts fields + playback test) — lands first so stage-2 speedup is provable.
2. **Stage 1 constants + env overrides** (4-line change + defaults documented) — run screen-runner tests + full vitest.
3. **Stage 2 event race in refresh()** (+ deps plumbing at playback.ts:1007 + 4 new tests) — suites + a local drill re-run.
4. **Verification drill**: same template as `run_b5207d00` on the same sim; compare step durations + waitMs/workMs split; record before/after in the PR body.
5. Docs: update code comments referencing 500ms/1000ms/2000ms tick rationale (the comments at screen-runner.ts:54–56 area and playback.ts:753) to the new values + the event race.

## Edge and failure cases

- Bus event arrives between pre-check and race start → final COUNT covers it; count re-check loop (3) resolves honestly.
- Multiple hits (recommendation + other calls) → first match resolves; note counts via COUNT as today.
- Unsubscribe leak on abort → `finally` unsubscribe.
- Env-override misuse (poll 1ms) → worst case more reads, predicates unchanged; document guidance.
- Legacy callers without `onTrafficHit` → verbatim poll fallback.
- Tests with fake static hierarchies → budgets already injectable; new race uses the same `worldConfirmMs` budget so tests stay fast.

## Validation and acceptance

- `pnpm run check` + full vitest green (C3).
- Drill re-run of the `run_b5207d00` template → 8/8 pass (C1), telemetry shows refresh ≤1.5s / expect ≤1.0s (C2).
- API step detail includes `waitMs`/`workMs` (C4).
- PR body carries the before/after table (baseline vs new drill, per step).

## Rollout / handoff

Single Crucible PR on `feat/screen-state-runner`; no migration (additive schema-free — evaluated_json keys are additive). Stages 3–4 remain future backlog items referencing this plan.
