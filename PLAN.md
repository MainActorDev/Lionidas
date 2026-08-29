# PLAN — Crucible: the E2E testing control dashboard

**Status: DRAFT v1 — awaiting human approval before any build work.**
Date: 2026-08-30 · Location: `ai/crucible/` · Stack: Vue 3 + Fastify + SQLite, Alloy in-process

> Crucible is where apps are proven. Alloy runs the app; Crucible is the room you
> watch it happen in — and the record of what was proven, when, and against what.

## 1. Goal

A local-first web dashboard that gives **QA** and **engineers** a shared control
surface over end-to-end UI testing: live simulator visibility, test-run
orchestration, acceptance-criteria status, evidence management, and baseline
governance — all executing through Alloy.

**Users and their jobs:**

| | QA | Engineer |
|---|---|---|
| Question | "Is this ticket provably done?" | "Why did my change break this?" |
| Entry point | AC matrix | Failed step |
| Needs | Roll-ups, evidence bundles, baseline signoff | Repro: artifact, args, video, logs, network |
| Actions | Trigger run sets, approve baselines | Re-run fragment, open locally |

**Non-goals (explicit):**
- NOT a test authoring tool — flows come from the existing pipeline (per-AC
  fragments); Crucible executes and records.
- NOT a Jira replacement — joins on ticket keys, owns only status + evidence.
- NOT multi-tenant/cloud — local-first, one team, one machine (Mac Studio/lab box).
- NOT a second device layer — Crucible NEVER talks to engines. Alloy is the only
  execution path (single choke point preserved; engine-neutrality inherited:
  engine names must not appear in this repo either — signature scan applies).

## 2. Concept model — the zoom pyramid

```
Train ─ Release ─ Ticket ─ AC ─ Flow ─ Step ─ Evidence artifact
                                ▲
                everything hangs off this spine
```

- **Run** = one execution event: *artifact × device × flow-set × time*. Immutable.
  Kinds: `automated` | `manual` | `rerun` (links `parent_run_id`).
- **Evidence bundle** = the unit of trust: video + screenshots + diffs +
  measurement + logs + network for one AC, plus context (artifact hash, launch
  args, device, src freshness, trigger). Bundles are immutable and deduped by hash.
- **Status derivation (never stored, always computed):**
  - Step status: pass/fail/skip/error (from flow-execute).
  - AC status: AND over its flows' latest non-quarantined automated results;
    any pending baseline diff → `changes-pending` (amber — neither green nor red).
  - Ticket status: AND over ACs. Manual runs NEVER roll up.
- **Freshness is a first-class badge**: every run records whether the artifact
  passed Alloy's STALE_ARTIFACT gate (fresh / stale-ignored / unchecked). A stale
  run renders with a warning banner — the recorded pitfall made visible.

## 3. Architecture

```
┌────────────────────────────┐
│  Web UI (Vue 3 SPA)        │  Vite + Pinia + vue-router, minimal CSS
│  device wall · run view    │
│  AC matrix · triage        │
│  baselines · artifacts     │
└──────────┬─────────────────┘
      REST + WebSocket
┌──────────▼─────────────────┐
│  Orchestrator (Fastify TS) │  run queue · event bus · evidence GC
│  ├ better-sqlite3 (WAL)    │  runs/steps/acs/baselines/queue (immutable runs)
│  ├ artifacts on disk       │  + content-addressed refs
│  └ Alloy (imported dist)   │  IN-PROCESS, typed — no MCP hop, no engine contact
└────────────────────────────┘
```

Layering rules (enforced by lint boundaries):
1. UI knows only orchestrator API shapes — it cannot import Alloy.
2. Orchestrator is Alloy's only client. It layers **run queueing** on top of
   Alloy's **device arbitration (leases)**; it never bypasses a lease.
3. Runs are immutable rows; corrections are new runs (`rerun` kind).

## 4. Data model (SQLite)

```sql
runs(id, ticket_key, kind, status, triggered_by, device_udid,
     artifact_path, artifact_hash, artifact_mtime, src_path, freshness,  -- fresh|stale_ignored|unchecked
     launch_args_json, scenario_id, scenario_sha,                        -- Forge (M2)
     parent_run_id, started_at, finished_at, note)
run_steps(run_id, idx, flow_name, kind, name, status, reason,
          started_at, duration_ms, evidence_ids_json)
ac_results(run_id, ticket_key, ac_id, ac_text, category,   -- visual|interaction|data-dependent|temporal|network-failure
           status, flow_names_json, bundle_id)
evidence(id, bundle_id, type,   -- video|screenshot|diff|measurement|logs|network
         path, sha256, bytes, moov_ok, created_at)
baselines(id, scope_key,        -- "<flow>/<step-or-ac>"
          image_sha256, approved_by, approved_at, supersedes_id, ticket_key)
baseline_diffs(id, run_id, scope_key, old_sha, new_sha, state,  -- pending|approved|rejected
               decided_by, decided_at)
queue(id, spec_json, priority,  -- 0 manual > 1 scheduled > 2 agent
      state,                   -- waiting|dispatched|done|aborted
      requested_by, enqueued_at, dispatched_run_id)
devices(udid, name, state, lease_holder, lease_engine, last_seen)  -- mirror, not truth
```

Indexes: `runs(ticket_key, started_at desc)`, `ac_results(ticket_key, ac_id)`,
`evidence(sha256)` (dedup), `queue(state, priority, enqueued_at)`.

## 5. API surface

REST (`/api`): `GET /devices` · `GET /runs?ticket=&limit=` · `POST /runs` ·
`GET /runs/:id` · `GET /runs/:id/steps` · `GET /tickets/:key/matrix` ·
`GET /queue` · `DELETE /queue/:id` · `POST /baselines/diffs/:id/approve|reject` ·
`GET /evidence/:id/file` (stream, range-enabled for video).

WebSocket `/api/events` (typed taxonomy — list below is the M1 core; each phase
extends it, e.g. `forge.traffic.*` in M2, `manual.session.*` in M3):
`device.changed · queue.changed · run.queued · run.started · run.freshness.checked ·
step.started · step.finished · run.finished · baseline.diff.pending ·
baseline.diff.decided · run.aborted`

## 6. Alloy call map (feature → tool)

| Feature | Alloy calls |
|---|---|
| Device wall state | `alloy_health` (leases) + `alloy_devices list` (poll 2s → mirror) |
| Run pre-flight | `alloy_apps install {path, srcPath}` → STALE_ARTIFACT = fail-fast, recorded |
| Run execute | `alloy_apps open {launchArgs}` → `alloy_video start` → `alloy_flow` per fragment → `alloy_video stop` → `alloy_release` |
| Step evidence | flow-execute per-step results + `alloy_screenshot_diff` (baseline) |
| Triage capture | `alloy_logs capture` · `alloy_network` · `alloy_measure` on failure |
| Baseline write-back | `alloy_flow {updateBaselines:true}` after approval |
| Manual cockpit (M3) | `alloy_snapshot` + `alloy_act` point taps under a held lease |

**Alloy gaps to close (small, in Alloy, before/with M2):**
1. `alloy_flow` schema: expose `updateBaselines` passthrough (exists in engine).
2. `alloy_act`: accept `{x,y}` point targets (engine supports; schema doesn't).
3. `alloy_stream` (new, engine-B passthrough): return the device stream URL so
   live video stays behind the Alloy choke point. Without it, M2 streaming would
   force direct engine contact — not acceptable.
4. `alloy_apps open {hold:false}` (self-review F1): open an engine session
   WITHOUT acquiring the alloy lease — required for the engine-phased run
   sequence (A session for logs/network while B holds flows); mutations stay
   lease-exclusive. Without A4, runs must fall back to flows' own launch steps
   and lose A-side log fidelity.

## 7. Screens

1. **Device wall** — tiles per simulator: name, state chip, lease badge
   (holder+kind), queue depth, last run. M2: live stream embed.
2. **Run view (live)** — step timeline rendering `step.started/finished` events
   with per-step screenshots; settle diffs as the step's visual. Header: ticket,
   artifact hash + freshness badge, launch args, device, trigger.
3. **AC matrix** — ticket × AC grid; cells green/red/amber(changes-pending)/
   gray(quarantined)/empty(no automated coverage); click → evidence bundle.
4. **Failure triage** — failed step: screenshot vs last-green diff, video segment
   (range-served), marked logs, network dump, launch args, artifact info.
   Buttons: *Re-run fragment* (enqueues `rerun`), *Copy alloy command*.
5. **Baseline approvals** — pending diffs queue; approve/reject with identity;
   approval writes new baseline via `alloy_flow updateBaselines` and records
   lineage (`supersedes_id`).
6. **Artifacts** — known builds (path, hash, mtime, source freshness), run counts.
7. **Queue** — visible queue per device with priority and requester; abort.

## 8. Run queue semantics

- Priority classes: manual(0) > scheduled(1) > agent(2); FIFO within class.
- Dispatch: pick head entry whose device constraint is free → create run →
  `alloy_apps open` acquires the lease → execute → release in `finally`.
  `LEASE_HELD` (someone bypassed) → requeue with backoff ×3, then surface.
- One run per device at a time, hard rule; starvation guard: agent class yields
  if any manual entry waited > 60s.
- Pre-queue validation: flow-set existence, artifact existence, srcPath freshness
  check (`alloy_apps install` gate) — invalid requests never enter the queue.

## 9. AC join (source-of-truth policy)

- AC identity comes from the flow fragments themselves: YAML metadata
  (`ticket`, `ac_id`, `ac_text`, `category`) written by the /record pipeline.
  Orchestrator scans the flows dir; renders AC text from metadata. Crucible never
  parses FDB markdown and never edits Jira. Jira status push = M3, opt-in.

## 10. Flake management

- Per-flow rolling history (immutable runs make this free): flake score =
  alternation rate over last 10; `quarantined` when ≥3 alternations within 7 days.
- Quarantined flows: gray in matrix, excluded from roll-up, listed on a
  "attention" strip. Un-quarantine is a manual QA action (with reason).

## 11. Evidence retention (nightly GC)

- Failure bundles: keep until ticket closed + 90d **when the Jira integration
  is enabled**; without it (integration off/opt-out), age-cap at 180d so GC
  never depends on an optional integration. Success bundles: 14d.
- Content-dedup by sha256 (videos from identical runs collapse to one blob).
- SQLite `VACUUM` after GC; disk budget alarm at 80% of quota.

## 12. Testing

- **Unit**: queue semantics (priority, backoff, starvation), status derivation
  (amber/gray rules), flake calculator, retention GC, AC metadata scanner.
- **Contract**: orchestrator↔Alloy against Alloy's fake-engine pattern (no device).
- **E2E (live)**: real Settings.app run through orchestrator → UI shows steps
  streaming; triage a deliberately-failed step; baseline approve round-trip.
- **Concurrency**: 3 queued runs on 2 devices — serialization + lease correctness.

## 13. Phases (gates = named, live-verified — Alloy discipline)

**Per-phase implementation plans (authoritative, self-contained):**
[M0-scaffold](plans/M0-scaffold.md) · [M1-read-only-spine](plans/M1-read-only-spine.md) ·
[M2-act](plans/M2-act.md) · [M3-cockpit](plans/M3-cockpit.md) — each carries the
full DDL/module/test/gate contract for its phase; this section is the summary.

**M0 — scaffold (½ day)**: repo, Vite+Vue3+TS, Fastify+better-sqlite3+Drizzle,
CI (typecheck→lint→signature scan→unit). *Gate: CI green; empty shell serves.*

**M1 — read-only spine (2–3 days)**: Alloy in-process; run ingestion (drive one
real flow set on Settings.app); schema + WS events; device wall (state), run
history + step timeline with screenshots, AC matrix for one ticket.
*Gate: a live automated run appears end-to-end in the UI as it executes.*

**M2 — act (3–4 days)**: POST /runs + queue + pre-flight freshness; triage view
(video/log/network); baseline approvals + write-back; Alloy gaps #1–#3; live
stream on wall. **+Forge core**: proxy (record/hybrid/intercept), presets +
scenarios + scenario picker, traffic inspector.
*Gate: QA triggers a ticket run → queues → runs live → failed step triaged with
video+logs; baseline diff approved and next run goes green; a scenario with one
overridden endpoint demonstrably changes app behavior mid-run.*

**M3 — cockpit (2–3 days)**: manual drive (labeled, lease-held, never rolls up),
flake analytics + quarantine, Jira evidence comment (opt-in), rerun-fragment.
**+Forge advanced**: failure injection & sequences, match tester + rehearse, MITM
spike (go/no-go gate).
*Gate: manual session visibly labeled and excluded from matrix; quarantine + Jira
comment verified on a staging ticket; a network-failure AC passes via injected
500-sequence preset.*

## 14. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Live streaming cost/complexity | Ship last in M2; step screenshots + video cover most triage |
| SQLite write contention | WAL mode, single-writer orchestrator, immutable rows |
| Disk growth from evidence | retention GC + dedup + budget alarm (day one, not later) |
| FDB/fragment metadata drift breaks the join | scanner validates + reports unknown shapes as "unmapped flow", never guesses |
| Manual mode erodes trust in "green" | manual runs labeled everywhere, never counted, separate wall badge |
| Agent runs starve interactive use | priority classes + starvation guard |
| Baseline approval bottleneck | amber state is explicit — blocked ≠ failed; approvals queue is visible |
| Proxy MITM complexity / security surface | out of scope until explicit gate; M2 = HTTP/staging + DEV base-URLs only |
| Preset drift breaks scenario reproducibility | scenarios content-hashed at run time; live amendments logged in timeline |
| Proxy port exposed on LAN | bind loopback by default; UI reaches proxy only via orchestrator API |

## 15. Forge — endpoint intercept & response presets

> Alloy controls the device; Crucible controls what the app sees. Forge is the
> network-level response control plane: a local proxy with recordable, presettable,
> scenario-scoped endpoint behavior.

**Two-layer story (explicit):** app-side mocking (launch-arg patch engine, DEV
builds) stays as-is for surgical data-dependent cases; Forge adds network-level
control for any build, any app, network-failure ACs, and live mid-run changes.
They unify under one **Scenario** object.

### 15.1 Objects

- **Preset** — one endpoint behavior: match (method + path pattern exact/glob/
  regex + optional query/header guards, longest-path-wins), response (status,
  headers, JSON body file, delay_ms), optional **sequence** (ordered responses;
  last repeats) for retry paths. Content-hashed; hand-editable but hash-recorded.
- **Scenario** — named set of enabled presets + optional `launch_arg` variant
  (drives the app-side layer in the same run). Immutable once referenced by a run.
- **Traffic log** — every proxied request: mode (record/intercept/hybrid), match,
  status, latency, req/res hashes. Scoped to a run when one is active.

### 15.2 Modes

| Mode | Behavior | Use |
|---|---|---|
| record | pass-through + log | capture real behavior, freeze as preset |
| hybrid (default) | real traffic, matched endpoints overridden | one endpoint mocked, rest real |
| intercept | all matched; unmatched → 501 + logged | fully deterministic replay |
| failure | latency / 5xx / malformed / drop / throttle presets | network-failure ACs |

### 15.3 Run integration

- Run creation gains a **scenario picker**; `runs.scenario_id` + scenario hash
  recorded → reproducibility evidence ("same artifact + same scenario = same
  outcome").
- Scenario is fixed for the run's lifetime; **live preset edits** (dashboard,
  mid-run) are allowed and logged into the traffic stream — visible in the run
  view timeline as "scenario amended @ step N" (auditable, not silent).
- Failure-injection presets map 1:1 to the `network-failure` AC category.

### 15.4 Device wiring & HTTPS (decisions, not assumptions)

- Simulator proxy configuration: orchestrator drives the Apple simulator CLI
  directly (toolchain boundary, same class as the build lane) — documented
  exception to "devices only via Alloy"; promoted into an Alloy settings area
  once stable.
- HTTPS interception requires a MITM CA trusted by the simulator. **Out of scope
  until an explicit gate**: M2 ships HTTP/staging and DEV base-URL paths only.
- Proxy = separate Fastify listener (own port); UI proxies through the
  orchestrator API, never the proxy port directly.

### 15.5 Data model additions

```sql
presets(id, method, path_pattern, match, status, headers_json, body_path,
        delay_ms, seq_json, created_by, created_at, sha256)
scenarios(id, name, description, launch_arg, created_by, immutable_since)
scenario_overrides(scenario_id, preset_id, enabled)
traffic(id, run_id, ts, mode, method, host, path, matched_preset_id,
        status, latency_ms, req_sha, res_sha)
-- runs gains: scenario_id, scenario_sha
```

Retention: traffic rows 14d (run-scoped rows follow the run's bundle policy).

### 15.6 UI — Response Studio

- **Traffic inspector** — live stream of proxied requests (WS), filter by
  run/endpoint/status; row → request/response viewer.
- **Freeze as preset** — from any recorded response row.
- **Preset editor** — JSON body w/ syntax check, match tester (paste a URL →
  shows which preset wins and why).
- **Scenario builder** — toggle presets, set launch-arg variant, "rehearse"
  (runs a smoke flow against the scenario before saving).
- Run view: scenario chip + amendments in the timeline.

### 15.7 Phasing

- **M2 (+Forge core)**: proxy process (record/hybrid/intercept), presets +
  scenarios + run integration, scenario picker, traffic inspector.
- **M3 (+Forge advanced)**: failure injection & sequences, Response Studio
  polish (match tester, rehearse), MITM spike → explicit go/no-go gate.


## 16. Decisions (answered 2026-08-30)

1. **Repo**: `ai/crucible/` + `MainActorDev/Crucible` — DECIDED yes.
2. **UI design**: brainstorm BEFORE M0 build (direction first, then mockups,
   then scaffold). Hand-rolled, no component kit.
3. **Auth**: PIN for approve actions + agent token for programmatic POST /runs
   (lioclaw workers) — DECIDED (agent priority class is pointless without
   agent identity).
4. **Video retention**: 14d success / failure until ticket closed +90d
   (180d age-cap without Jira) — accepted; revisit after dogfood.
5. **Jira scope (M3)**: comment-only. Transitions = later decision.
6. **A4 `hold:false`**: ratified — engine session without alloy lease;
   mutations stay lease-exclusive.
7. **Fragment front-matter**: confirmed — /record fragments carry
   ticket/ac_id/ac_text/category; Crucible reads, never guesses.
8. **Evidence materialization**: copy-at-ingest — Crucible copies engine-owned
   temp evidence into its own artifacts dir at run end; owns retention.
9. **Topology**: local-first NOW; remote lioclaw Mac worker LATER — bind
   address configurable from M0 (loopback default), agent token exists day one.
10. **Forge proxy isolation**: per-app base URLs (DEV builds) as PRIMARY
    (per-run proxy instances, true parallel isolation); global simulator proxy
    kept as serialized fallback for any-app runs. M2 spec updated accordingly.
11. **Scheduling**: NO cron/scheduler now; queue schema keeps the `scheduled`
    priority class so a producer can be added later without migration.
12. **Evidence quota**: 50 GB default (config knob); warn 80%, pause new runs
    at 100%.
13. **Sequencing**: Crucible builds DURING the Alloy dogfood window (Crucible
    is the dogfood); A4 lands in Alloy first.
14. **MITM**: spike in M3 (3h); on GO → re-plan, do not auto-build.

Still open: which wall mode wins (ambient vs focused) — decided after live use.

## 17. Quality bar (user directive, 2026-08-30)

**Everything is production-grade.** Means: structured logging (pino) with
request ids; graceful shutdown (SIGTERM → drain queue → close); fail-fast config
validation with actionable messages; every route validates input (zod, M1+);
no placeholder code shipped; CI gates never skipped; dependencies pinned and
audited on bump; error surfaces show cause + next action, never raw stacks to
end users (full detail in logs).
