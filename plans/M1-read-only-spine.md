# M1 — Read-Only Spine (Crucible Phase 1)

**Status: READY — no build until approved.** · Parent: [../PLAN.md](../PLAN.md)
Prereq: M0 gate green · Duration: 2–3 days

## 0. Scope

Alloy in-process; real runs ingested and displayed **live**: device wall (state),
run history, step timeline with screenshots, AC matrix for one ticket. No
user-triggered runs (that's M2), no writes except run ingestion.

**Honest scope note:** in M1 the orchestrator triggers runs itself (a CLI command
`pnpm --filter server run:once -- --flows <dir> --udid <id>`) so the live UI has
something real to show. This code path becomes M2's POST /runs handler — building
it once, in the shape M2 will call.

## 1. Schema (this phase's tables — full DDL is contract)

```sql
CREATE TABLE runs(
  id TEXT PRIMARY KEY,                -- run_<8hex>
  ticket_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('automated','manual','rerun')),
  status TEXT NOT NULL CHECK(status IN ('queued','running','passed','failed','aborted')),
  triggered_by TEXT NOT NULL,
  device_udid TEXT NOT NULL,
  artifact_path TEXT, artifact_hash TEXT, artifact_mtime INTEGER,
  src_path TEXT,
  freshness TEXT NOT NULL DEFAULT 'unchecked'
    CHECK(freshness IN ('fresh','stale_ignored','unchecked')),
  launch_args_json TEXT NOT NULL DEFAULT '[]',
  scenario_id TEXT,                   -- NULL in M1; Forge M2
  parent_run_id TEXT REFERENCES runs(id),
  started_at INTEGER, finished_at INTEGER,
  note TEXT
);
CREATE TABLE run_steps(
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL, flow_name TEXT NOT NULL,
  kind TEXT NOT NULL, name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pass','fail','skip','error')),
  reason TEXT, started_at INTEGER, duration_ms INTEGER,
  evidence_ids_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY(run_id, idx)
);
CREATE TABLE ac_results(
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  ticket_key TEXT NOT NULL, ac_id TEXT NOT NULL,
  ac_text TEXT NOT NULL, category TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pass','fail','skip')),
  flow_names_json TEXT NOT NULL, bundle_id TEXT,
  PRIMARY KEY(run_id, ac_id)
);
CREATE TABLE evidence(
  id TEXT PRIMARY KEY, bundle_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('video','screenshot','diff','measurement','logs','network')),
  path TEXT NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL,
  moov_ok INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX idx_runs_ticket ON runs(ticket_key, started_at DESC);
CREATE INDEX idx_ac_ticket ON ac_results(ticket_key, ac_id);
CREATE INDEX idx_evidence_sha ON evidence(sha256);
```

Drizzle migrations are append-only; these tables are written once here.

## 2. New server modules

```
src/alloy/client.ts     # lazy singleton: import Alloy dist via ALLOY_CONFIG_PATH
                        # → AlloyDispatch (= alloy's dispatch) + LeaseManager wiring
src/alloy/runner.ts     # executeRun(spec): the ONLY code path that runs flows
src/domain/acs.ts       # scanFlowSet(dir): FlowSetMeta[] from YAML front-matter
src/domain/status.ts    # pure: deriveAcStatus / deriveTicketStatus / flakeOf
src/ingest/flowResult.ts# map flow-execute result → steps + ac_results rows
src/routes/devices.ts   # GET /api/devices (mirror from poller)
src/routes/runs.ts      # GET /api/runs, GET /api/runs/:id, GET /api/runs/:id/steps
src/routes/matrix.ts    # GET /api/tickets/:key/matrix
src/routes/evidence.ts  # GET /api/evidence/:id/file (stream; Range for video)
src/poll/devices.ts     # 2s poll alloy_health+alloy_devices → devices mirror + events
```

### 2.1 Alloy call sequence in `executeRun` (contract — order is normative)

**Lease-correctness rule (from Alloy's verified model):** engine A and engine B
must never hold/act cross-engine on one device. Video/flows/diff/measure are
engine B; install/open/logs/network are engine A. The sequence below is
engine-phased so no cross-engine conflict can occur. It requires **Alloy gap A4**
(`open {hold:false}`) — see M2 §1; M1 may prototype with the flows' own launch
steps (no A-open) if A4 lags.

```
1. A  alloy_apps { action:'install', path, srcPath? }   → STALE_ARTIFACT ⇒
      run.status='failed', freshness='stale_ignored' → record + STOP.
      (absent srcPath ⇒ freshness stays 'unchecked')
2. A  alloy_apps { action:'open', app, udid, launchArgs, hold:false }   [A4]
      → engine session (log stream source); NO alloy lease held
3. A  alloy_logs { action:'start' }                      (per-call; session alive)
4. B  alloy_video { action:'start' }                     (per-call; recorder persists)
5.    for each flow (sorted by (ticket, ac_id, name)):
5a.     B alloy_flow { udid, flowPath }                  (HELD lease — the only
                                                        holder during execution;
        flow YAML omits its own launch step: app already open from 2)
5b.     B alloy_screenshot_diff / alloy_measure as needed for AC evidence
        (per-call, SAME engine as holder ⇒ allowed; screen intact post-flow)
6. B  alloy_video { action:'stop', label: run.id }
7. A  alloy_logs { action:'capture' } + alloy_network    (per-call; NO holder now;
      session from step 2 still alive ⇒ failure-time log lines captured)
8. A  alloy_release { udid }                             → ALWAYS (finally):
      closes engine session (incl. hold:false) + clears any lease
9.    persist: steps, ac_results, evidence rows; run.status = AND(steps)
```

Steps emit WS events as they map (`step.started`, `step.finished`); UI never polls.

### 2.2 Flow-set metadata contract (source of AC truth — PLAN §9)

Each fragment YAML carries front-matter (written by the existing /record pipeline;
M1 only READS):

```yaml
# <flowsDir>/<name>.yaml
ticket: CUST-1234
ac_id: AC-3
ac_text: "FAQ phone link is hidden when faq-no-link variant is active"
category: data-dependent        # visual|interaction|data-dependent|temporal|network-failure
---
name: <name>
steps: [ ... ]
```

`scanFlowSet` rules: missing front-matter → flow is **unmapped** (runs, but its
result can't roll up — surfaced in UI, never guessed); duplicate `(ticket,ac_id)`
from different tickets → validation error, refuse run.

**Flows-dir layout (hard constraint, from Alloy's containment validation):**
`flowsDir` MUST be `<projectRoot>/<configured segments>/` exactly as Alloy's
engine config resolves it (default `flows/`; local install uses the engine's
canonical dot-dir). Fixtures live in `fixtures/proj/<segments>/`. `alloy_flow`
refuses anything else — validate in pre-flight, not at run time.

**AC aggregation rule (PK `(run_id, ac_id)` forces one row per AC):** status =
AND over the AC's flows in this run — any `fail|error` ⇒ `fail`; all `skip` ⇒
`skip`; else `pass`. `flow_names_json` lists contributors in execution order.

## 3. Web pages (read-only)

- **WallPage**: tiles from `/api/devices` + WS `device.changed`; lease badge
  (holder + engine), state chip, last run summary. No stream yet.
- **RunsPage**: `/api/runs` list → row click.
- **RunDetailPage**: header (ticket, artifact hash + freshness badge, launch
  args, device, times); step timeline (live append via WS); per-step screenshot
  thumbnails when evidence exists; failed step → triage panel (M2 completes it).
- **MatrixPage**: `/api/tickets/:key/matrix` → AC rows × latest runs columns;
  cells pass/fail/skip; empty cell = no automated coverage.

## 4. Tests (named)

| File | Asserts |
|---|---|
| `test/acs.test.ts` | scan: front-matter parse, unmapped detection, dup-AC refusal |
| `test/status.test.ts` | pure derivation: pass/fail/skip rollup; amber only from M2 baselines — assert M1 returns no amber |
| `test/flowResult.test.ts` | fixture flow-execute JSON → correct steps + ac rows (statuses, durations, evidence refs) |
| `test/routes.runs.test.ts` | inject: list/detail/steps shapes; 404 on unknown id |
| `test/evidence.stream.test.ts` | Range request → 206 + correct bytes slice (fixture file) |
| `test/alloy.runner.test.ts` | fake-Alloy (recorded calls): sequence order 1–9 incl. `hold:false` on open (A4) and NO cross-engine overlap — for every recorded call pair (i,j) with i holding, j same-engine or read-only-no-holder; STALE_ARTIFACT stops before open; release in finally even on step throw |
| `test/ingest.aggregate.test.ts` | AC aggregation: multi-flow AC → AND merge; all-skip ⇒ skip; mixed fail+pass ⇒ fail |
| `test/boot.reconcile.test.ts` | startup with orphaned engine session (fake) + stale waiting queue rows → session closed, queue aborted, devices mirror clean |
| `test/devices.poll.test.ts` | poll maps health+list → mirror rows; emits `device.changed` on diff |

Fake-Alloy pattern: import Alloy's exported `dispatch`/registry, register stub
handlers via `replaceToolHandlerForTests` — same trick as Alloy's own contract
tests; **no device needed for CI**.

**Boot reconciliation (crash recovery):** on server start — enumerate engine
sessions via Alloy health; close any session not owned by an active run (device
claims are host-global files that SURVIVE an orchestrator crash — without this,
devices read DEVICE_IN_USE forever); abort `waiting` queue rows older than boot.

## 5. Invariants

- `executeRun` is the only flow-execution path (lint: no other file may call
  `alloy_flow`).
- Run rows immutable post-finish; corrections = new run (kind 'rerun').
- Evidence dedup: insert keyed on sha256; existing sha → reuse row.
- WS events are the ONLY live channel; routes are read APIs.
- Unmapped flows run but cannot affect AC status (assert in status tests).

## 6. GATE (live, on this machine, Settings.app)

```bash
pnpm check                                   # all green
pnpm --filter server exec tsx scripts/run-once.ts \
   --flows ./fixtures/settings-flows --udid <booted>   # real Alloy run
# With web+server running and browser open DURING the run:
#  G1 WallPage shows the device tile flip to leased (holder: alloy) live
#  G2 RunDetail steps appear AS THEY EXECUTE (not after)
#  G3 a failed fixture flow shows fail step + reason in timeline
#  G4 MatrixPage for the fixture ticket shows correct pass/fail ACs
#  G5 after run: video evidence row exists, GET with Range returns 206
#  G6 second run-once: evidence sha dedup reuses blob (rows+1, files+0)
#  G7 STALE_ARTIFACT fixture (touched src) → run fails fast, freshness badge
```

G1–G7 observed in a real browser session = phase done. Screenshots of the session
are attached to the M1 completion message.

Commit: `feat(m1): read-only spine — live runs, steps, matrix` (+ any fixups).
