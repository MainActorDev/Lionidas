# Overview Vertical Slice — Gap Analysis + Minimum-Change Plan

> **Status: PLAN — awaiting human approval. No implementation yet.**
> Source specs: "E2E Testing Platform — Overview Page Implementation Brief"
> (attached 2026-09-22) + "E2E Test-Case Management" brief (2026-09-18,
> plan at docs/plans/2026-09-18-testcase-management.md).
> Inspection basis: live code read 2026-09-22 (routes/manual.ts, routes/runs.ts,
> routes/suites.ts, routes/flakes.ts, db/suite.ts, manual/batch/pool.ts,
> manual/playback.ts) + real DB state (717 runs: 497 passed / 133 failed /
> 87 aborted, of which 32 aborted carry blocked=1; 77 case_versions; 1 suite).

---

## Part 1 — Gap analysis

### 1a. Test-case management spec (2026-09-18) — residual gaps only

Phases A–E shipped (versions, variants, suites, status lifecycle; commits
through `0079d15`). What remains open, all deliberate DEFERRED entries:

| Residual gap | State | Disposition |
|---|---|---|
| Evidence retention beyond latest run | artifacts pruned per template (playback) | OPEN product decision (disk growth) — blocks nothing in the Overview slice; Overview links run ids, not artifact bytes |
| Per-flow variant lists | deferred | unchanged |
| Publish act | rejected v1 | unchanged (snapshot-on-run covers it) |
| Plans referencing suites | SHIPPED (plans.suite_id wired) | closed |

**Conclusion: the management spec is not the blocker. The Overview brief is
new work on an already-correct substrate.**

### 1b. Overview spec — section-by-section

| Brief section | Crucible today | Gap |
|---|---|---|
| Execution context (env/build/suite/device/time) | `runs.app_version` (write-through from installed bundle), `suite_id`, `device_udid`, `started_at`; `/api/runs` filters exist | No single context selector/aggregation; **app_version NULL on 345 runs** (incl. recent) — must be a first-class "unknown build" bucket, never silently merged |
| Health summary | NOTHING computes pass-rate/health anywhere (verified: no passRate/health outside `/api/health` liveness) | Full gap — the core of the slice |
| Comparable execution set | `batchId` exists ONLY in memory (pool.ts `batches` Map, dies with process); `suiteVerdicts` reconstructs "last play" via a 120s timestamp window heuristic | **The structural gap**: no persisted batch identity ⇒ "current vs previous comparable run" cannot be honest for the Overview |
| Requires attention | nothing; discovery = eyeballing trend glyphs / FlakesPage | Full gap (new-vs-recurring needs comparable-pair lookup per case) |
| Latest runs | `/api/runs` + RunsPage + SSE live updates (`activeRuns`, `run.finished` refetch pattern) | ✅ mostly satisfied; needs overview-shaped projection (ids for drill-down) |
| Failure summary / signatures | `run_steps` carries parseable reasons (`ambiguous (2 matches)`, `matched N (bound: …)`) | Grouping/signatures = Phase 2 per the brief's own release order |
| Coverage snapshot | inputs all exist post-Phase E: status counts, variants_json, suites, last-run per template (3 templates currently not run in 7d) | No endpoint computing it |
| Flaky | `/api/flakes` — FLOW-level scores + quarantine | Different grain (case/variant-level needed); case-level derivable from runs; keep flow-page untouched |
| Blocked ≠ failed | `runs.blocked` + `classifyBlocked()` infra signatures + B4 semantics (blocked=1 appears on aborted runs; failed runs carry blocked=0) | ✅ exists; Overview must present aborted+blocked as "blocked", never inside fail counts |
| Trigger source | `triggered_by` is a free-text zoo (`qa`, `admin`, `uitest`, 40+ drill labels) | Derivable classification only (session-user ⇒ manual; else label as-is); no schema change |
| Read model / aggregation API | none — clients stitch `/api/runs` + `/api/templates` + suites | Full gap — one aggregate route needed |
| Empty/loading/error states, URL-preserved filters | page-level patterns exist elsewhere | UI phase concern |

### The one insight that shapes the minimal design

Every Overview metric the brief asks for is **a derived query over columns
that already exist** — except "comparable execution set", which today is a
120-second timestamp guess. Persisting batch identity is the single
structural change the slice needs; everything else is SQL + one route.

---

## Part 2 — Minimum changes for the vertical slice

Scope: **server-side end-to-end** — a batch play executes → its runs are
stamped → one aggregate API answers health/attention/coverage from them.
The dashboard PAGE is explicitly NOT in this slice (next phase, with
concept-first sketches per house rule).

### 2a. Data model — exactly one change

```
runs  + batch_id TEXT NULL        -- persisted execution-set identity
      index idx_runs_batch(batch_id)
```

- Written by the batch engine for every play-all / plan / suite play.
- Solo row-runs stay NULL (not an execution set — they appear in Latest
  Runs but never feed health math; documented, not hidden).
- No new tables. No `batches` parent table in the slice — set metadata
  (started/finished/trigger/scope) derives from member runs via
  MIN/MAX/`triggered_by`; a durable batches/spec table is Phase-2 material
  if the Overview ever needs pre-run specs.
- Read model: **none** (derived queries; 717 rows compute in ms — the
  brief explicitly permits this over a materialized model).

### 2b. Migration (migrateM1 contract)

1. Guarded ALTER: `runs ADD COLUMN batch_id TEXT` (column-add only).
2. `CREATE INDEX IF NOT EXISTS idx_runs_batch ON runs(batch_id)`.
3. Fresh-CREATE block gains the column (no CHECK — free-text id).
4. No backfill: legacy NULL = "pre-batch", honestly labeled; the
   suiteVerdicts 120s window stays as the legacy fallback ONLY there.

### 2c. Runner changes — three touch points, all tiny

1. `manual/batch/pool.ts`: the batchId it already generates (line 71) gets
   merged into each `runOne` opts payload (it already threads opts).
2. `manual/playback.ts`: runs INSERT gains `batch_id` (one column, one
   placeholder, read from opts). ~3 lines.
3. **`manual.ts` single-template variant play (~:429)**: the direct
   lane-chain route (post-c1032d1 shape: lanes 1..N chained, respond when
   lane 1 starts) generates its OWN batchId and passes it to every lane —
   a multi-variant play IS an execution set (the board already treats it
   as one batch via worst-of-lanes). Without this, the intl-drill row
   button would mint runs the Overview ignores. TRUE solo plays (one run,
   no variants) stay NULL — documented: not an execution set.
4. No new events: live refresh = existing `run.finished` → refetch
   (SuiteHomePage's proven pattern). `batch.started` already carries batchId.

### 2d. API — exactly one route

`GET /api/overview?suite=<id|all>&app_version=<v|all>&days=14` (auth: any
logged-in role; read-only) returns ONE JSON:

```
context        { suite, appVersion, days, computedAt }
health         { status: healthy|degraded|failed|running|no_data,
                 passed, failed, blocked, passRate, delta,
                 previousSetLabel, lastSuccessfulAt }
attention[]    { severity, kind: new_failure|infra_blocked|repeated_failure|stale_case,
                 templateId, runId?, explanation, tag: new|recurring|flaky,
                 firstSeenAt, lastSeenAt }
latestRuns[]   top 10 in scope: runId, templateId, templateName, status,
               blocked, variantId, appVersion, triggeredBy, startedAt, durationMs
coverage       { active, draft, deprecated, variants, suites,
                 executedInRange, notRunRecentlyDays: 7, notRunRecently }
```

Metric definitions pinned to our schema (brief's Metric Definitions section):

- **Comparable set** = all runs sharing the latest non-NULL `batch_id` in
  scope. Previous comparable = next-earlier batch with the same suite-scope
  AND same app_version (when the latest set's version is known; unknown
  build falls back to same-scope and the response labels it — never
  silently merges builds). **Worst-of-lanes collapse: when a batch contains
  multiple runs of one template (variant lanes), the template's set-verdict
  is its worst lane (failed > blocked > passed/aborted-without-block),
  mirroring suiteVerdicts — one case = one observation in health math.**
- **Pass rate** = `passed / (passed + failed)`; blocked (aborted ∧ blocked=1)
  and skipped counted/shown separately, never inside the rate. (Crucible has
  no existing formula to preserve — this IS the first one; documented in UI
  later.)
- **Health** — any member running/queued ⇒ `running` (checked FIRST; a
  mid-flight re-run must not show yesterday's failures as current truth);
  failed>0 ⇒ `failed`; blocked>0 or a flaky-flagged case present ⇒
  `degraded`; else `healthy`; no comparable set in scope ⇒ `no_data`
  (never rendered as 0%).
- **Newly failing** = failed in latest set ∧ passed in previous comparable
  set, comparing `case_version_id` when both known (version change ⇒ label
  "definition changed", per brief).
- **Repeated** = failed in ≥2 consecutive comparable sets.
- **Flaky (v1, case grain)** = both outcomes within last ≤5 comparable sets
  without a case-version change between them. (Flow-grain page untouched.)
- **Stale** = active template with no run in 7 days.
- **Severity order** (brief's priority, v1 subset): new product regression →
  infra-blocked → repeated product failure → stale coverage. Test-definition
  sweep + baseline alerts = Phase 2.
- Attention items carry templateId/runId for drill-down (brief's
  Data Requirements: identity in every aggregate).
- Trigger source v1: `triggered_by` shown verbatim (honest zoo > invented
  taxonomy); classification refinement deferred.

### 2e. Tests (TDD, same harness patterns as Phase E)

1. **overview.test.ts** — health math (each status branch incl. no_data);
   blocked never counted as failed; delta sign; comparability guard (different
   suite or known-different build never compared); unknown-build fallback
   labeled; pass-rate excludes blocked/aborted; empty-DB state.
2. **attention ordering** — new > infra > repeated > stale with seeded sets.
3. **batch stamping** — runBatch writes batch_id on every member run; solo
   play leaves NULL; legacy runs read as pre-batch without error.
4. **coverage** — counts by status (draft/deprecated excluded from
   executed-expectations), not-run-recently with clock injection.
5. Full-suite regression: 863 existing tests green unchanged (batch_id is
   additive; suiteVerdicts untouched).

### 2f. Explicitly OUT of this slice

- The Overview PAGE (needs concept + ≥3 sketches first — house rule).
- Failure signatures/grouping (brief Phase 2), trends charts (Phase 3),
  baseline/YAML-sweep alerts, `batches` parent table, CI trigger taxonomy,
- Any change to suiteVerdicts, verdict trends, or the existing run pages.

---

## Part 3 — Self-review

- Both ends of the new link: batch_id WRITTEN by pool→playback (test 3) and
  READ by /api/overview set selection (test 1) — same value asserted.
- Solo-run exclusion from health is a documented semantic, and Latest Runs
  still shows them (nothing disappears).
- **Variant lanes collapse** (self-review catch): intl drill = 4 runs per
  batch (empty/th/my/sg); without worst-of-lanes in the set-verdict math,
  one case would count 4 observations and a single failed lane would
  double-count as "failed + 3 passed ⇒ flaky". Mirrors suiteVerdicts.
- **Running-first health order** (catch): the drill for "running" status
  must seed a mid-flight batch (status running) and assert health=running
  even when an OLDER completed batch has failures.
- **Solo variant play stamping** (catch): the c1032d1 lane-chain route
  bypasses runBatch entirely — needs its own batchId or the board's Run
  button mints invisible-to-Overview runs.
- **Comparability self-check** (catch): "previous comparable with same
  app_version" is only computable when the batch's runs share one version;
  mixed-version batches (NULL from pre-write-through runs + a versioned
  run in the same batch) label the comparison "mixed builds", never
  fabricate a single previous-version.
- **Clock injection** (catch): stale-coverage and firstSeen/lastSeen need
  the same injectable-now pattern as freshness elsewhere — tests must not
  depend on wall time.
- suiteVerdicts' 120s window keeps serving legacy rows; new rows get exact
  identity — no behavior change to existing surfaces (regression suite is
  the receipt).
- app_version NULL reality (345 runs) handled as labeled bucket, per the
  brief's "do not display zero/unknown as valid measurement".
- No speculative abstraction: one column, one index, one route, two small
  runner diffs. Nothing else.
