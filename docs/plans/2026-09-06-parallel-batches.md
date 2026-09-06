# Parallel test-case execution — device-lane batches — 2026-09-06

Status: **SHIPPED + live-drilled 2026-09-06** — commits:
`9f554b5` (planner/pool/seams/routes, Tasks 1-3) · `d7378d3` (batch
lifecycle + stop-all, drill-caught fix). Drill: 2 sims × 3 cases, SQL
overlap proof, stop mid-batch, honest failure reporting.
Date: 2026-09-06

## Plain English summary

Today `run filtered` runs every case one-after-another on one device. If
you have three simulators booted, two sit idle. This plan teaches batches
to use ALL booted simulators at once: cases are split across "lanes"
(one lane per booted device, each lane strictly sequential — the B5
one-run-per-device safety contract is untouched), so 10 cases on 3 sims
finish in roughly a third of the time. One booted device = exactly
today's behavior. Two honest v1 limits: network scenarios aren't allowed
in parallel batches (the proxy state is global — fakes would
cross-contaminate), and traffic-to-run attribution is off for parallel
batches (the proxy can't tell which sim sent a request).

## Research grounding (2026-09-06)

**Our own code (read this session):**
- The automated-flow queue is ALREADY device-parallel:
  `nextDispatchable` skips busy devices (`queue/store.ts:50-64`) and the
  dispatcher's `setInterval` tick doesn't await prior ticks
  (`queue/dispatcher.ts:53-57`). Two flows on two devices already
  overlap. The sequential wall exists ONLY in template playback.
- `runBatch` (`routes/manual.ts:292-330`): strict `for…await done` —
  the loop to replace.
- B5 guard (`manual/playback.ts:269-272`): `WHERE device_udid = ?` —
  per-device, parallel-across-devices already legal.
- `forgeState.activeRunId` (`forge/proxy.ts:22`, `forge/state.ts:117`)
  and the addon state file are GLOBAL singletons; scenario presets are a
  single global set. Parallel scenario runs would serve run A's fakes to
  run B. → v1 restriction, not a refactor.
- `resolveUdid` (`playback.ts:248-264`) throws DEVICE_AMBIGUOUS with
  >1 booted — batch mode must pick devices EXPLICITLY, per lane.
- `prunePreviousRunArtifacts({templateId}, runId)` — latest-only
  retention keyed by template: the same template running on two devices
  concurrently would prune each other's evidence. → same-template
  concurrency guard.
- UI: progress pills + tracker + abort are per-template (Task from
  2026-09-06) — already render N concurrent runs of distinct templates.

**Maestro (mobile-dev-inc) — model + vocabulary to steal:**
- `--shard-split` = distribute the suite so each case runs ONCE (speed)
  vs `--shard-all` = full suite on every device (compatibility matrix).
  We ship shard-split; shard-all is a natural follow-up (same planner,
  lanes get the full list).
- Sharding splits by COUNT, not duration ("divides tests by quantity
  rather than execution time" — their own caveat). We can do better:
  run_steps.duration_ms gives us per-template cost history →
  duration-weighted packing.
- Local parallelism is bounded by host CPU/RAM (their docs; iOS sims
  especially) — lane count caps + honest degradation.
- Parallel hazards they call out: artifact name collisions, fixed-port
  conflicts, driver-startup timeouts under simultaneous boot. Ours:
  per-run artifact dirs (safe), per-udid alloy sessions + stream ports
  (safe by construction), gate under load (drill checkpoint).

## Design

### Execution model — device-lane pool

```
planLanes(cases, bootedDevices, costHint)   PURE: which cases on which lane
        │  one lane per booted sim; lane is serial (B5 intact)
        ▼
runParallelBatch(deps, lanes, opts)         per-lane worker loops:
        │  lane: for case of lane → runTemplatePlayback(udid=lane.device)
        │  lane halts ITS remaining cases on DEVICE_BUSY/APP_NOT_INSTALLED/
        │  DEVICE_AMBIGUOUS (today's batch semantics, scoped to the lane);
        │  other lanes continue
        ▼
batch registry (module-level Map<batchId, controller>)  for stop-all
```

- **Lane claim is explicit**: each case runs with `opts.udid = lane.device`
  — resolveUdid's ambiguity path never fires inside a batch.
- **Same planner, one lane** = today's sequential batch (equivalence
  proven by test, not by keeping old code).
- **Lane count** = booted simulators at batch start, capped by
  `CRUCIBLE_BATCH_MAX_LANES` (default: unlimited). Devices that die
  mid-batch fail their lane's current case honestly (stream gate); the
  lane halts, siblings continue.
- **Watch mode**: unchanged — the dock binds the run you watched; pills
  cover every other lane.

### Case→lane planner (pure, TDD)

- Cost per template = total duration of its LAST finished run
  (`SUM(run_steps.duration_ms)` over the latest run_id; unknown →
  median of known costs, else 30s default).
- **Greedy least-loaded packing** (better than Maestro's count-split,
  and we have the data): sort cases by cost desc, id asc (determinism),
  assign each to the lane with the smallest accumulated cost.
- A template appears at most ONCE per batch input (UI already sends
  distinct rows; planner dedupes defensively).
- NEVER two lanes running the same template concurrently → also guards
  the prune race (belt: playback checks before prune anyway — Task 2).

### Forge / traffic in parallel (v1 honesty)

- `scenarioId` + >1 lane → **409 `PARALLEL_SCENARIO_UNSUPPORTED`**
  (global preset set would cross-contaminate; single-lane keeps scenarios).
- Traffic attribution: with >1 lane, playback skips setting
  `forgeState.activeRunId` (new playback opt `forgeAttribution`, default
  true; pool passes false for multi-lane). Proxy still captures; rows
  land with `runId: null`. Documented, not silent.
- Rationale: the mitm proxy sits on the HOST — sims share it; it cannot
  attribute a request to a sim without deep work (per-device proxy
  instances = future, explicitly out of scope).

### Stops & failures

- `POST /api/templates/play-all` response gains `batchId` + per-lane
  breakdown; returns when all lanes settle (today's shape + fields).
- `POST /api/batches/:id/abort`: halts lane dispatch (pending cases
  marked `skipped · batch aborted` in the response), in-flight runs go
  through the EXISTING run-abort (between-steps semantics).
- UI `■ stop all` additionally calls the batch abort (it already aborts
  tracked runs + queue rows).
- Lane report: per lane — runIds, halted-at + reason, skipped count.
  The UI summary line shows `done N/M · K lanes · halted L`.

## Tasks (TDD where pure; drill where live)

### Task 1 — `server/src/manual/batch/plan.ts` (pure planner, TDD)

Exports `planLanes(input: { cases: Array<{templateId, costMs}>, devices: Array<{udid, name}>, maxLanes?: number }): Lane[]`.
Tests (`batch/plan.test.ts`):
- duration-greedy: heavy case to the empty lane, balanced split
- unknown cost → default weight; mixed known/unknown deterministic
- more lanes than cases; single case; empty cases → []
- same templateId twice → deduped (first occurrence)
- maxLanes caps lane count (device order = mirror order)
- determinism: same input → identical output (run twice)

### Task 2 — `server/src/manual/batch/pool.ts` + playback seams (TDD)

- `runParallelBatch(deps, {lanes, opts, runOne})` — `runOne` injectable
  (default: runTemplatePlayback with lane udid + opts).
- Lane semantics tests (fake runOne): all-pass; one lane DEVICE_BUSY →
  its tail skipped + reported, other lane unaffected; APP_NOT_INSTALLED
  payload surfaced per-case; batch abort stops dispatch, in-flight
  results still collected; rejects scenarioId when lanes>1.
- Playback seams:
  - `forgeAttribution?: boolean` opt (skip activeRunId set/clear + scenario
    activation when false) — unit test: no forge writes when false.
  - prune guard: skip `prunePreviousRunArtifacts` when another RUNNING
    run of the same template exists (SQL check) — unit test.
- Registry: `batchRegistry` (Map + register/abort/cleanup on settle) —
  unit tests for abort-before-start race and cleanup.

### Task 3 — route wiring (`routes/manual.ts`)

- `runBatch` → detect booted sims (mirror), plan lanes, `runParallelBatch`.
- Response: `{ batchId, runIds, count, lanes: [{udid, name, runIds, skipped, haltedAt?}] }`
  — `runIds` stays flat (UI compat).
- `POST /api/batches/:id/abort` route (404 unknown / settled).
- Route tests: 2 fake devices → 2 lanes; 1 device → single lane
  equivalence with today's abort semantics; scenario+parallel → 409;
  abort route flips registry.

### Task 4 — UI (browser-verified)

- play-all against >1 booted sim: summary line `running N cases on M devices`;
  pills already light per case; on settle `done N/M` (+ halted note).
- stop-all: also POSTs batch abort when a batchId is in flight.
- Guide rows (runs-with-feature rule) + a note that parallel batches are
  live-network only.

### Task 5 — live drill (the honesty gate)

Two booted sims (iPhone 16 + 16 Plus), Batam + tnc + privacy cases:
1. `play-all` → verify OVERLAP in DB: ≥2 runs with disjoint device_udid
   and overlapping [started_at, finished_at] windows (SQL proof).
2. All runs pass; evidence per run intact (prune guard held).
3. stop-all mid-flight: in-flight run aborts between steps, pending
   cases skipped, response reports honestly.
4. Single-sim play-all: byte-compat with today (sequence + semantics).
5. scenarioId + 2 sims → honest 409.
6. Gate-under-load check: both lanes' readiness gates pass concurrently
   (no stream/port contention).

### Task 6 — closure

Plan status + commit map; guide merged with Task 4; skill note
(device-lane pattern, planner purity, forge-parallelism limits);
DEFERRED entry for per-device proxy attribution + shard-all mode.

## Edge-case table

| Case | Behavior |
|---|---|
| 1 booted sim | single lane ≡ today (tested equivalence) |
| Device shutdown mid-batch | lane's current case fails (stream gate), lane halts, others continue |
| Manual session opened on a lane's device mid-batch | next case DEVICE_BUSY → lane halts (B5 unchanged) |
| Same template twice in filter set | deduped by planner; never concurrent |
| scenarioId + >1 lane | 409 PARALLEL_SCENARIO_UNSUPPORTED |
| Traffic during parallel batch | captured, `runId: null` (attribution off — documented) |
| stop-all with pending lane cases | batch abort skips them; in-flight abort between steps |
| 0 booted sims | today's resolveUdid path (recorded device / ambiguity error) |
| Host CPU saturation (many lanes) | CRUCIBLE_BATCH_MAX_LANES cap; Maestro-documented bound |
| play-all while another batch runs | devices busy → lanes plan to 0 free devices → honest error (or join? NO — v1 refuses) |
| Two batches, disjoint devices | allowed (guards are per-device); planner only sees its own lanes |

## Out of scope (explicit)

- Per-device proxy instances / parallel traffic attribution (DEFERRED entry)
- shard-all (compatibility matrix) mode — same planner, later
- Auto-booting idle sims to widen lanes
- Duration-aware REPACKING mid-batch (lanes fixed at start)
- Parallel MANUAL sessions (already per-device legal; no UI change)

## Verification gates

- `pnpm vitest run` server (planner, pool, registry, routes, playback seams)
- `npx vue-tsc --noEmit` + `npx vite build` web
- Task 5 drill matrix (overlap SQL, abort, equivalence, 409, load)

## Self-review checklist (executed 2026-09-06 — findings folded in)

- [x] prune race is REAL: `prunePreviousRunArtifacts` fires at run-start
      keyed by templateId (playback.ts:321) — two same-template runs on
      two devices would delete each other's evidence. Planner dedupes
      (Task 1) AND playback gets a running-sibling guard (Task 2, belt).
- [x] still-feed latch is per-udid (stream-relay.ts:51) — overlapping
      run.started events already safe; no relay work needed.
- [x] automated-queue busy-set is device-keyed (store.ts:51) — template
      lanes and the automated queue share the same per-device truth; a
      lane + an automated run on the same device serialize via B5.
- [ ] single-lane output EXACTLY matches today's runBatch semantics (test, not hope)
- [ ] no lane ever dispatches a case after batch abort (test the race)
- [ ] forgeAttribution=false leaves NO writes (set AND clear skipped — a stray clear would null a sibling's attribution)
- [ ] prune guard checks RUNNING runs only (finished runs still prune)
- [ ] registry cleanup on all-settle paths (success, all-halt, abort)
- [ ] play-all response backward-compatible (runIds flat array)
- [ ] planner deterministic across runs (no Map-iteration-order luck)
