# Plan — Multi-device control + parallel runs

- Source: `brainstorm/20261002T153235Z-parallel-multi-device-runs.md` (Direction selected, `54fac6a`)
- Created: 2026-10-02T16:45:00Z
- Status: Ready (rev 2 — review `reviews/20261002T153235Z-parallel-multi-device-runs-plan-review.md` applied: F1 drop prune code-change, F2 route fix, F3 per-device template guard, F4 sessions API, F5 heartbeat decision, F6 :key-remount shape)

## Decision log

| Decision | Source |
|---|---|
| Same-ticket parallel fan-out is in scope | operator: "same ticket should also working" (2026-10-02) |
| Cockpit must keep control of a device after switching tabs (session map per udid) | operator: "in the cockpit I booted two sims. then took control one of them, when I switched tab, the other sim control is dead" (2026-10-02) |
| Engine + server already support concurrent per-device sessions | live drill, same session: two sessions open at once, interleaved taps A→B→A→B all ok, clean finishes |
| Dispatcher already allows cross-device parallel runs | code: `queue/dispatcher.ts:26` overlapping ticks; `queue/store.ts:44` per-device busy set |
| Evidence prune blocks same-ticket parallelism | code: `alloy/runner.ts:89` prunes previous automated run's artifacts per ticketKey |

## Objective

1. An operator with N booted sims can hold manual control on every device in the cockpit and switch tabs without losing any session.
2. Queued automated runs on different devices execute concurrently (verified end-to-end), including the same ticket on two devices (evidence isolated per run+device).
3. A one-click fan-out: run a case on all booted devices.

Measurable: two booted sims — take control on A, switch to B, take control on B, switch back to A → A still shows its live session chip and taps dispatch (no re-take). Two runs enqueued on two devices overlap in `running` state. Same ticket on both devices keeps both runs' evidence.

## In scope

- Cockpit StageBezel/page: sessions keyed by udid; per-tab control state.
- Evidence prune key: ticket → ticket+udid (or run-scoped) so same-ticket parallel runs don't destroy each other's artifacts.
- Parallel-runs drill + regression test (queue layer).
- Fan-out UX: queue accepts multi-device spec; cockpit/console "run on all booted".

## Out of scope (this plan)

- Engine-side changes (proven unnecessary by the live drill).
- Cross-HOST device pools (single Mac).
- Automatic scheduling/load-balancing beyond "device free → dispatch".

## Requirements

### R1 — Per-device control state (cockpit) + sessions API (review F4/F5/F6)
- Server: `GET /api/manual/sessions` (operator-gated) → `{ sessions: [{ id, udid, operator, startedAt, lastActivity }] }`; cockpit hydrates the map on mount + device refresh; revisited tab whose session was watchdog-reaped shows the session-lost state (probe from this list — no per-switch ping).
- Heartbeat (F5 decision): page-level loop pings `/api/manual/:id/heartbeat` every 30s for ALL map entries while the cockpit is open — background sessions stay alive (the "control persists" semantic); closing a device's tab releases its entry.
- `StageBezel` stops owning one `sessionId`; the page holds `Map<udid, {sessionId, startedAt, dims}>` (a `useDeviceSessions` composable).
- Switching tabs rebinds the stage to that map entry: session chip, heartbeat, tap routing, release button all read the active entry.
- Take-control on a device with an existing live entry reuses/refreshes it (supersede, not duplicate).
- Session-lost (410 class) clears only that device's entry.
- Switcher dot marks tabs holding a live session (live dot exists; extend to session state).
- Watchdog honesty: if a background session expires (5-min idle), the tab shows "session expired — take control again" when revisited (probe on activation, not on every switch — one `/record`-style lightweight check or reuse heartbeat state).

### R2 — Same-ticket evidence isolation (NO code change needed — review F1)
- Review grounding: `evidence/retention.ts:29-31` already prunes only FINISHED runs (`finished_at IS NOT NULL`), and `evidence-retention.test.ts:60` pins "never prunes a still-running previous run". Same-ticket parallel runs are evidence-safe today. The parallel-runs drill (R3) must assert both runs' evidence survives, as the regression net.

### R3 — Parallel runs verified
- Drill (manual, then automated test): queue the same smoke case on two booted devices; assert both rows reach `running` with overlapping timestamps and both finish `passed`/`failed` honestly.
- Regression test at the dispatcher level: two specs, different udids → both dispatch without waiting (fake runner clock).

### R4 — Fan-out UX (route corrected per review F2/F3)
- `POST /api/runs` (the real enqueue route, `routes/runs.ts:24`, operator-gated) accepts `udids: string[]` or `allBooted: true` → pre-flight validation once, device-existence per udid, one `enqueue` per device; response `{ queueIds: [...] }` (202). Single-`udid` body keeps working unchanged.
- Same-template guard becomes per-device: `manual/playback.ts:423` adds `AND device_udid = ?` — different devices may run the same template concurrently (that is the feature); check its test's intent and update the test.
- Cockpit play-case picker gains "all booted devices" — calls the fan-out and toasts "queued on N devices".

## Architecture / touch points

| Area | Files | Change |
|---|---|---|
| Session map | `web/src/composables/deviceSessions.ts` (new), `CockpitPage.vue`, `StageBezel.vue` | page owns durable map + heartbeat loop; stage remounts per udid via `:key` (F6) |
| Sessions API | `server/src/routes/manual.ts` | `GET /api/manual/sessions` (operator-gated) |
| Template guard | `server/src/manual/playback.ts:423` | per-device scope |
| Fan-out route | `server/src/routes/runs.ts` | `udids[]` / `allBooted` → N enqueues |
| Prune guard | `server/src/alloy/runner.ts` | prune only runs not in `queued/running` |
| Queue fan-out | `server/src/routes/runs.ts` (`/api/queue`), queue store | accept `udids[]`/`allBooted`; loop existing insert |
| Cockpit picker | `CockpitPage.vue` play-case modal | multi-select devices or "all booted" toggle |
| Tests | `server/test/queue*.test.ts`, new `web deviceSessions` unit, runner prune test | per R2/R3 |

## Stages (rev 2 — R2 dropped as code work, session map promoted to Stage 1)

1. **R1 cockpit session map + sessions API + heartbeat** (the operator's immediate pain) + unit tests + live two-tab drill. Implementation shape (F6): the page owns the durable `Map<udid, session>`; StageBezel may keep local per-mount state, remounted via `:key="activeUdid"` — switching tabs reconstructs stage-local state while the map holds the handles. Acceptance stays behavior-level.
2. **R3 parallel-runs drill** (two devices, overlapping runs; assert BOTH runs' evidence intact = R2 net) + dispatcher regression test.
3. **R4 fan-out** — `POST /api/runs` multi-device + per-device template guard + cockpit picker action + tests.
Each stage lands independently green (tests + build); commit per stage.

## Failure cases

- Background session reaped by watchdog while user is on another tab → honest expired state on revisit (R1).
- Device shut down via tab close while holding background session → close-tab flow already releases the ACTIVE device's session; extend to release that device's map entry (all sessions the map holds for it).
- Fan-out where a device is mid-run → per-device busy set skips it; entry stays waiting (existing behavior, unchanged).
- Same-ticket prune race in the wild → R2 removes the class.

## Validation / acceptance

- Unit: session map binding/expiry; prune guard skips running runs; queue fan-out creates N entries; dispatcher parallel test.
- Live drill A (control): two sims, control both, switch tabs, tap from each — both dispatch, both chips live.
- Live drill B (runs): same case queued on both devices — overlapping `running` timestamps, both evidence sets intact afterward (same ticket).
- Gates: `pnpm -C web test`, server vitest, builds; PR to `feat/device-cockpit` after human gate.

## Rollout

Single PR on `feat/device-cockpit` (create-only; operator merges). No migrations. Backwards-compatible API (`udid` still accepted).
