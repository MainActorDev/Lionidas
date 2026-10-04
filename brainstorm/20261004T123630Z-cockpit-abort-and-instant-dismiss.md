# Cockpit — instant modal dismiss + abort button for running cases/suites

- Source prompt: "Why the 'suite' modal not immediately dismissed after the action. And even the notification 'queued' is showing after the whole test cases run finished. Check for other modals too" + "instead of 'case running..' disabled button, show 'abort' button when test case is running in cockpit. If we run a test case then it should abort that test case. and if suite, should abort the whole testcases in that suite"
- Created: 2026-10-04T12:36:30Z
- Status: Direction selected

## Goal and context

Two follow-ups on the merged cockpit (PR #15):

1. **Modal responsiveness** — submitting from a modal should dismiss it immediately and toast right away. Today the *suite* modal hangs on `running…` until the entire suite finishes, then dismisses + toasts "queued" (absurdly late). The user asked to audit the other modals too.
2. **Abort affordance** — replace the disabled `case running…` button with an active **abort** button: aborts the running case when a single test case was launched from the cockpit, or the whole batch (all lanes, in-flight + pending) when a suite was launched.

## Confirmed inputs and decisions

Verified in code (main @ post-#15):

- **Why the suite modal hangs**: `POST /api/suites/:id/play` (manual.ts:918) awaits `runBatch` → `runParallelBatch` (pool.ts) awaits `Promise.all(lanes.map(...))` where each lane awaits every case's `started.done`. The HTTP response only resolves when the **entire suite finishes**. The client's `playSuite` awaits that response before closing the modal + toasting — hence "queued" after the runs finish. (Test-case modal is fine: `/api/templates/:id/play` resolves at queue time.)
- **Abort surface already exists server-side**:
  - `POST /api/runs/:id/abort` — per-run abort with between-steps semantics (runs.ts).
  - `POST /api/batches/:id/abort` — batch abort: stops dispatching pending lane cases; in-flight runs get the run-abort between-steps treatment (manual.ts:783, pool.ts `abortBatch`). RunPanel already uses the run-abort.
- The button today: `caseRunning` state (5s runs poll) disables take-control as `case running…`.

## Exploration

### Fix 1 — suite play response latency

**Option A (chosen): server returns at queue time.** The suite play route should resolve with `{runIds, batchId, count}` once all lanes have *started* dispatching, not when every run settles. The pool already emits `batch.started`; the lane dispatch loop pushes `started.runId` before awaiting `done`. Smallest correct shape: give `runBatch` a `settle: false` mode used by the suites route (the run rows + events remain the live view — same philosophy the play route already documents: "Execution continues in background; run status/step rows are the live view"). Client unchanged: it already closes + toasts on response.
- Risk: none observable — the batch result (halted lanes, skips) is derivable from run rows/events; nothing consumes the HTTP response's lane detail in the cockpit path (RunPanel on the suites page uses its own event feed).

**Option B (rejected): client-side fire-and-forget** — close the modal without awaiting. Dishonest: an immediate 409 (device busy, drift) would surface as a toast long after the modal closed, or not at all.

**Modal audit** (client, all already dismiss-on-response): test case ✓ fast, suite ✗ (this fix), run app ✓ (~1s engine ack — acceptable, it's one dispatch), install ✓ (~12s install time — the button shows "installing… (≈12s)" which is honest work, NOT a hang), boot ✓ (waits for boot confirm — honest, ~8s). Conclusion: only the suite path is wrong; install/boot delays are real work already labeled.

### Fix 2 — abort button

Replace the disabled button with an **ember-bordered `abort` button** when `caseRunning`:

- **Single case launched from cockpit**: abort the active run for the active device (`POST /api/runs/:id/abort` with the run id from the same 5s poll that drives `caseRunning`).
- **Suite launched from cockpit**: remember the last-launched `batchId` (the play response carries it); abort via `POST /api/batches/:id/abort`. This stops pending lanes AND between-steps aborts in-flight runs — exactly "abort the whole testcases in that suite".
- Selection rule: if the last launch was a suite (batchId known + batch still live), the button aborts the batch; otherwise it aborts the device's active run. If the batch has settled, fall back to run-abort.
- Keep `take control` unavailable while running (the abort button occupies the slot; control returns when the run ends — aborting ends it sooner).

Edge cases: multiple devices in a distributed suite — batch-abort covers all lanes regardless of device; the button lives on the stage (active device) but acts batch-wide, labeled clearly (`abort suite`). Confirm-on-click not needed (abort is recoverable by re-running; RunPanel made single-click the established pattern).

## Open questions

1. Should abort also be offered for runs NOT launched from this cockpit session (e.g. a suite started from the suites page, visible via the runs poll)? Proposal: yes when a live batch/run touches the active device — same button, it's the device's truth. (Defaulting to yes.)

## Next step

Implement: (1) `settle:false` mode for the suite play route + regression test asserting the response lands while runs are still `running`; (2) cockpit abort button (run vs batch selection, labels `abort case` / `abort suite`), reusing the 5s run poll; live-verify both paths on the booted sims.
