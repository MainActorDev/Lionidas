# Parallel test runs on multiple devices — can Lionidas do it today?

- Source prompt: "Can we run test cases paralelly on multiple devices right now? Is the infrastructre supported it?"
- Created: 2026-10-02T15:32:35Z
- Status: Direction selected

## Goal and context

The operator wants to know whether Lionidas can execute test cases on several simulators **at the same time** right now — and whether the current infrastructure (queue, dispatcher, engine) supports it, or needs work.

This brainstorm was grounded in the actual code (all citations from `server/src/` on `feat/device-cockpit` @ `7a5f491`), not guesswork.

## Confirmed inputs and decisions

Verified facts from the code (nothing user-confirmed beyond the question itself):

1. **The dispatcher allows cross-device parallelism by design.** `queue/dispatcher.ts:26` — `startDispatcher` runs a 250ms `setInterval` whose ticks are fire-and-forget (`dispatchTick(...).catch(...)`), so ticks **overlap**: while run A executes on device 1, the next tick can dispatch run B on device 2. There is no global "one run at a time" lock in the dispatcher.
2. **The busy-check is per-device.** `queue/store.ts:44-53` — `nextDispatchable` builds `busy` from `runs WHERE status IN ('queued','running')` grouped by `device_udid`, and only skips entries whose *own device* is busy. Entries for different devices dispatch.
3. **Runs are pinned to one device.** A run row has a single `device_udid` (`alloy/runner.ts:77-84`); queue spec requires exactly one `udid` (`routes/runs.ts:32`).
4. **Manual sessions also respect per-device busy** (`manual/session.ts:128`, `routes/devices.ts:91`): power/install refuse while a run holds *that device*.
5. **Install already proves per-device parallelism works**: `test/app-install.test.ts:78` — "different devices install in parallel (per-udid guard)".
6. **Engine session caveat (the big unknown):** the engine-A client keeps a shared, fixed-name `'alloy'` session, "re-opened by every dispatch" (`routes/devices.ts:113-116`). Whether the *engine* tolerates two concurrent flow executions on two different devices through that one session is not proven anywhere in this repo.
7. **Same-template overlap is explicitly blocked**: `manual/playback.ts:423` — a template with a queued/running instance can't start again (a variant-expansion seriality, not a device one).

## Exploration

### What "works today" honestly means

- **Queueing N runs across N devices: supported.** POST N specs with different `udid`s → the dispatcher will start them within ~250ms of each other, and the per-device busy logic keeps each device serial.
- **Executing them truly concurrently: unproven — the engine is the single point of risk.** Everything on the Crucible side is per-device-safe, but all engine calls funnel through one in-process Alloy client with one shared engine session (`alloy/client.ts`, `routes/devices.ts:113`). If the engine serializes flow execution internally (or the shared session's device claim conflicts), the second run would fail or block with `LEASE_HELD`/`DEVICE_IN_USE`-class errors rather than run in parallel. The dispatcher's `LEASE_HELD` path (backoff ×3 → abort) would mask this as flaky aborts.

### Options

**A. Prove it first (smallest useful step — recommended).**
Boot 2+ sims, enqueue the same smoke case against each device, watch both run rows go `running` simultaneously and check wall-clock overlap + engine errors. Zero code. Outcome decides everything: if it passes, parallelism is a docs/UX problem (a "run on all booted devices" button); if it fails, the failure signature tells us exactly which layer to fix (engine session vs. dispatcher serialization).

**B. If the engine blocks: per-device engine sessions.**
Change run execution to open a uniquely-named session per run/device instead of the shared `'alloy'` session (touch points: `alloy/runner.ts` session open/release, the power-route lease retry in `routes/devices.ts:108-121`, heal logic). Medium effort; also removes the shutdown-retry hack that exists today because of the shared session.

**C. First-class multi-device fan-out UX.**
A suite/queue API accepting `udids: [...]` (or `allBooted: true`), fanning out to one run per device, plus a matrix view. Real value (this is presumably the end goal) but premature until A/B settle the engine question.

### Risks worth noting

- **Resource contention:** two parallel runs = two simulator video encodes + installs; macOS may throttle. The run-still feed (`simdeck/holds.ts`) loops `simctl screenshot` per active run — fine at 2–3 devices, worth watching at 5+.
- **Latest-only evidence pruning** (`alloy/runner.ts:89` prunes the previous automated run's artifacts per ticket): two devices running the *same ticket* concurrently could race the prune. Different tickets are safe; same-ticket-fan-out needs the evidence key to include udid.
- **CI habit**: none of this is covered by a test today; option A should add one.

## Live drill results (2026-10-02, added same session)

**Multi-device manual control WORKS at the engine/server layer — proven live.**

- Two manual sessions on two booted sims at once: `ms_989398a4` (iPhone 14 Plus) + `ms_92ff9e5a` (iPhone 16) — server accepts both; the per-device guard (`manual/session.ts:127`) only blocks a device with an active automated run or existing session, never cross-device.
- Interleaved taps through the shared engine client both succeeded: A→B→A→B all `{"ok":true}` — the engine (alloy) dispatches per-udid and tolerates concurrent sessions. Both sessions then finished cleanly.
- **This also answers brainstorm question 1**: the engine executes per-device work concurrently. Parallel RUNS (option A) is now low-risk to enable — only the run-level drill remains to confirm the flow-execution path (taps prove the dispatch layer; runs add install+flow steps through the same seam).

**Why the cockpit kills control on tab switch — a UI-only limitation, not infrastructure:**

- `StageBezel.vue:66-76`: switching tabs sets `sessionId.value = null` (local view only). The server-side session/lease on device A **stays alive** — its idle watchdog (5-min) eventually reaps it, but nothing finishes it.
- Tabs therefore render "idle" for a device whose session is actually still open; re-taking control works (the old session is superseded), but the previous lease lingers until the watchdog.
- Stream legs are per-udid in the proxy, so watching both is already supported; only the CONTROL handle (one `sessionId` ref inside the single StageBezel) is single-device.

## Direction selected

1. **Same-ticket fan-out is IN scope** (operator decision) → the evidence prune key must include udid before any same-ticket parallel run ships (`alloy/runner.ts` prune + evidence rows).
2. **Parallel runs**: proceed to option A drill (queue two runs on two devices, confirm overlapping `running` + passes), then option C (multi-device fan-out UX: `udids[]` / `allBooted` + matrix view).
3. **Cockpit multi-device control**: make sessions a MAP keyed by udid (`udid → sessionId`) so each tab keeps its own control handle; switching tabs rebinds view+input to that tab's live session (or honestly shows "released by watchdog" when it expires). Session-lost, heartbeat, and take-control states all become per-device. The switcher's live dot can mark tabs holding live sessions.

## Open questions

None blocking. (Watchdog interplay: while A's session lingers after a tab switch, B's run/queue on A is blocked up to 5 min — acceptable for round 1; a "release on switch away" toggle can revisit.)

## Next step

Cockpit session-map change (smallest user-visible win, unblocks the two-sims workflow the operator just hit), then the two-run parallel drill.
