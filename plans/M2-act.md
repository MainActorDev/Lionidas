# M2 — Act: Queue, Triage, Baselines, Stream, Forge Core (Crucible Phase 2)

**Status: READY — no build until approved.** · Parent: [../PLAN.md](../PLAN.md)
Prereq: M1 gate green (esp. `executeRun` + fake-Alloy harness) · Duration: 3–4 days

## 0. Scope

The dashboard becomes actionable: POST /runs + queue + pre-flight, failure
triage with full evidence, baseline approval loop with write-back, live device
stream on the wall, and **Forge core** (proxy, presets, scenarios, traffic
inspector). Three small Alloy-side gaps close FIRST — Crucible features that
need them are blocked until their gates pass.

## 1. Alloy gaps (built in the Alloy repo, gated before Crucible work)

| # | Gap | Spec | Gate |
|---|---|---|---|
| A1 | `alloy_flow` lacks `updateBaselines` | schema passthrough boolean → engine | Alloy contract test + live: run w/ flag rewrites baseline PNG |
| A2 | `alloy_act` lacks point targets | accept `target:{x,y}` object alt in schema; adapter maps to `{kind:'point'}` | Alloy contract: dispatch with point target reaches engine shape |
| A3 | no stream URL surface | new `alloy_stream` row (**engine B** passthrough — the stream URL lives in engine B's simulator-server; engine A has none): `{udid}` → `{streamUrl, status}`; degraded-safe | Alloy live: returns URL on booted sim; LISTED in tools; scan clean |
| A4 | `alloy_apps open` always holds the lease | `open` accepts `hold:false` — engine session WITHOUT alloy lease (release still closes it); powers the M1 run sequence's A-session + B-flows phasing | Alloy lease tests: hold:false open ⇒ lease map empty; per-call B tools unaffected; release closes session |

A1–A4 ship as one Alloy release bump (A4 FIRST — M1's run sequence depends on
it); Crucible pins the new Alloy version in its `alloy.client.ts` (workspace
`file:../alloy` link + version pin; health fails on mismatch) and fails health
if mismatched.

## 2. Queue (server)

```
src/queue/store.ts     # SQLite-backed FIFO w/ priority classes
src/queue/dispatcher.ts# loop (250ms): head(waiting, priority asc, enqueued asc)
                       #   whose device is idle → create run → executeRun
src/routes/queue.ts    # GET /api/queue, DELETE /api/queue/:id (waiting only)
```

Semantics (normative):
- Priority: manual(0) > scheduled(1) > agent(2); FIFO in class.
- One run per device, hard rule (mirrors Alloy lease; LEASE_HELD ⇒ requeue
  backoff 5s/15s/45s ⇒ then `aborted` + event).
- Starvation guard: any manual waiting > 60s ⇒ agent-class entries for that
  device defer (skip, not drop).
- Pre-queue validation (reject 400, never enqueue): flows dir scanned OK, no
  duplicate AC ids, artifact path exists, device exists & booted, udid given.
- POST /api/runs body:

```ts
{ ticketKey, flowsDir, udid, artifactPath, srcPath?, launchArgs?: string[],
  triggeredBy, priority?: 'manual'|'scheduled'|'agent', triage?: boolean }
```
→ `202 {runId, queueId}`. Run row is created `queued`; dispatcher flips to
`running` when picked (events `run.queued`, `run.started`).

## 3. Triage view (web, completes M1's panel)

Failed step detail now renders: screenshot-vs-last-green **diff** (evidence type
`diff` from `alloy_screenshot_diff` — added to `executeRun` step 4 on fail),
**video segment** (player with `t=step.start..step.end` using Range),
marked **logs** (`alloy_logs` capture), **network** (`alloy_network`), launch
args, artifact hash + freshness badge. Buttons: **Re-run fragment** (POST /runs
kind `rerun`, `parent_run_id` set, flowsDir = single flow) and **Copy alloy
command** (renders the equivalent CLI sequence for local repro).

## 4. Baselines (server + web)

```
src/domain/baselines.ts # match scope_key "<flow>/<step>"; find baseline image
src/routes/baselines.ts # GET /api/baselines/diffs?state=pending
                        # POST /api/baselines/diffs/:id/approve | reject
```

Flow (normative): every automated run's `diff` evidence that mismatches ⇒
`baseline_diffs(state='pending')` + WS `baseline.diff.pending`. Approve ⇒
rerun **only that flow** with `updateBaselines:true` (A1) inside the SAME lease
session when possible (cheap path: run right after approval if device free;
else enqueue priority manual) → new baseline row `supersedes_id` lineage →
diff `approved` → WS `baseline.diff.decided`. Reject ⇒ diff `rejected`; AC stays
red with pointer to decision. **AC status: any pending diff ⇒ `changes-pending`
(amber) — the M1 status module gains the amber rule here** (M1 tests asserted
its absence; M2 tests assert its presence — deliberate).

Baseline identity = sha256 of approved image; runs reference baseline sha they
were diffed against.

## 5. Live stream (web + A3)

WallPage tile gains **Watch** (only when device booted): fetch
`alloy_stream` via orchestrator (`POST /api/devices/:udid/stream`) → embed
streamUrl. Lease rules unchanged — watching ≠ holding. If stream fails ⇒ tile
badge "stream unavailable", wall stays functional (stream is enhancement,
not backbone).

## 6. Forge core

### 6.1 Proxy process (server, second listener)

```
src/forge/proxy.ts      # Fastify on cfg.FORGE_PORT (default 8888), loopback only
src/forge/matcher.ts    # longest-path-wins; guards; seq cursor per preset+run
src/forge/traffic.ts    # append traffic rows + WS forge.traffic.* events
```

Request pipeline (normative): parse → match(active scenario presets; else
mode) → `record|hybrid`: forward real (fetch, streaming), log; `intercept`:
matched ⇒ preset response; unmatched ⇒ 501 + log; `failure` presets: delay /
status / malformed-body / drop(connection close) / throttle(kbps). Sequence
presets: cursor advances per hit (per run), last entry repeats.

Preset JSON schema (contract for editor + storage):

```ts
{ id, method: 'GET'|'POST'|'PUT'|'DELETE'|'PATCH'|'*',
  pathPattern: string,             // exact | glob | regex per `match`
  match: 'exact'|'glob'|'regex',
  guards?: { query?: Record<string,string>, headers?: Record<string,string> },
  status: number, headers?: Record<string,string>,
  bodyPath?: string,               // file under artifacts/presets
  delayMs?: number,
  seq?: Array<{ status: number; bodyPath?: string; delayMs?: number }>,
  failure?: 'timeout'|'reset'|'malformed'|'throttle', throttleKbps?: number }
```

### 6.2 Scenarios + run integration

Tables per parent PLAN §15.5. `POST /api/runs` gains `scenarioId?`. Dispatcher,
before step 2 of `executeRun`: activate scenario on proxy + record
`runs.scenario_id/sha`; device proxy set via simulator CLI (documented exception,
loopback). After `alloy_release`: deactivate + unset device proxy (finally).
Scenario immutable once referenced (`immutable_since` set by first run).

**Proxy isolation (decided): PRIMARY = per-app base URLs.** DEV builds are
configured (launch arg / build config) to point at a per-run proxy instance
`http://127.0.0.1:<dynamic port>` — each scenario run spins its own proxy
listener, so scenario runs run in PARALLEL with zero host side effects.
**FALLBACK = global simulator proxy** (host-level, affects everything) for
any-app interception: serialized behind a global proxy mutex, disabled unless a
run explicitly requests it. HTTPS: not interceptable without MITM either way —
scenario picker states "HTTP/DEV base-URL targets only" until the M3 MITM gate.
Per-run port allocation: FORGE_PORT_BASE..+N, released on run end (finally).

### 6.3 Traffic inspector (web)

`/forge` page: live table via WS `forge.traffic.hit` (method, host, path,
status, latency, mode, matched preset name); filter by run/endpoint/status;
row → req/res viewer (bodies from `artifacts/forge/<id>`, size-capped 256KB);
**Freeze as preset** action (prefills editor with recorded response).

## 7. Tests (named)

| File | Asserts |
|---|---|
| `test/queue.order.test.ts` | priority+FIFO pick; starvation skip; abort |
| `test/queue.lease.test.ts` | LEASE_HELD → requeue backoff ×3 → aborted |
| `test/queue.validate.test.ts` | all 400 pre-flight rejections (each rule) |
| `test/baselines.flow.test.ts` | pending→approve triggers updateBaselines rerun; supersedes lineage; amber derivation now active |
| `test/forge.matcher.test.ts` | exact/glob/regex; longest-path-wins; guards; seq cursor advance + repeat-last |
| `test/forge.modes.test.ts` | record passthrough+log; hybrid override only matched; intercept 501 unmatched; failure reset/timeout/malformed |
| `test/forge.scenario.test.ts` | activate/immutability; run records scenario sha; deactivate in finally |
| `test/alloy.stream.route.test.ts` | route → alloy_stream call shape; degraded when A3 missing |
| `test/triage.route.test.ts` | triage bundle assembly for a failed step fixture |

## 8. GATE (live)

```bash
pnpm check
# A-gates first (in Alloy repo): A1 baseline rewrite, A2 point target, A3 stream URL
# Then with dashboard running:
#  G1 POST /api/runs (Settings fixture) → 202 → wall tile leases → steps stream live
#  G2 second POST while busy → queue visible → runs after first releases
#  G3 failing fixture → triage panel: diff + video segment plays (Range 206) + logs + network
#  G4 baseline diff appears pending (amber in matrix) → approve → baseline flow
#     reruns w/ updateBaselines → next identical run GREEN
#  G5 Forge: record mode on real staging GET → row logged → freeze preset →
#     scenario w/ that preset → run with scenario → app traffic shows override
#     (traffic row mode=intercept, matched preset) + run records scenario sha
#  G6 seq preset (200 then 500) → app retry path visible in traffic rows
#  G7 stream Watch on booted device shows live screen; lease untouched
#  G8 STALE_ARTIFACT via UI run form → 400-level fast fail, badge recorded
```

G1–G8 observed in browser + traffic inspector = phase done; session screenshots
attached to completion message.

Commit: `feat(m2): queue, triage, baselines, stream, forge core`.
