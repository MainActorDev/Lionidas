# Test-Case Management (Suites, Versions, Variants) — Assessment + Implementation Plan

> **For Hermes:** assessment-first per the brief's own Implementation
> Approach; plan → self-review → HUMAN GATE → phased implementation with
> per-phase verify + commit. Source brief: "E2E Test-Case Management — AI
> Agent Implementation Brief" (attached 2026-09-18).

**Goal:** Wrap management (suites), immutability (versions), and state
coverage (variants) around the existing YAML case system — without
replacing the recorder, the runner, or the format.

**Architecture:** New tables beside `templates` (suite, membership,
`case_versions` content-addressed snapshots), one new top-level YAML key
(`variants:`) expanding at batch-fan-out time, and run-reference columns
that make every historical run resolve its exact YAML + scenario. No new
test-definition language; `steps_json` stays the storage truth.

**Tech Stack:** SQLite migrations in `migrateM1` (CREATE-block + guarded
ALTER contract), `@crucible/shared/case-yaml` (parse/serialize + validation
with line errors), `runBatch`/`planLanes` fan-out in `routes/manual.ts`,
vitest.

---

## Part 1 — Assessment of the existing implementation (verified 2026-09-18)

### What already satisfies the brief

| Brief requirement | Current state | Receipt |
|---|---|---|
| Stable case ID + unique name | `templates.id` (`tpl_*`), `name UNIQUE` | schema.ts:135-147 |
| Description | `templates.description` EXISTS (unused by UI) | schema.ts:138 |
| Tags | `tags_json` + tag filter in play-all | schema.ts ALTER :229, selectTemplates |
| Owner | `created_by`/`updated_by` stamped from req.user (attribution rule) | schema.ts:335, auth rules |
| Preconditions / steps / assertions | `setup:` (guarded pre-steps), `steps:`, `expect:` + `on:`/`contains:`/`ignoreCase:` | case-yaml.ts; alert policy |
| Env variables in YAML | `${env.X}` resolved at playback, missing-key = step error | template-env.ts REF :16 |
| Validation w/ YAML path + line | unknown-key errors carry step numbers; parse errors carry lines | case-yaml.ts:225,287 |
| Sequential responses, delay, failure, throttle | presets: `seq_json`, `delay_ms`, `failure`, `throttle_kbps`, sha256 | schema.ts:79-93 |
| Scenario = preset collection | `scenarios` + `scenario_overrides`, activated per-run, restored after | playback.ts:344-353 |
| Proxy separate from UI instrumentation | Forge (mitm, own process) vs alloy engine — already decoupled | architecture invariant |
| Run records case + app build + device | `runs.template_id`, `app_version`, `device_udid`, per-step rows + evidence | schema.ts runs, run_steps |

### The gaps (each = a work item)

1. **No version immutability — the headline gap.** `runs.template_id`
   references the LIVE `templates` row; `steps_json` is mutable (the
   self-hardening sweep even rewrites it, playback.ts:1060-1072). A run
   from last week silently re-resolves to today's YAML. `runs` has
   `scenario_id`/`scenario_sha` COLUMNS (schema.ts:22) that playback NEVER
   WRITES — dead schema today, ready to be used.
2. **No suites.** `plans` are remembered INVOCATIONS (tags+device+env),
   not organizational collections; no membership table exists.
3. **No variants.** Nothing expands one case into N state-coverage
   executions. Closest machinery: `runFlow` expansion (`expandFlows`) and
   `${env.X}` — both reusable as-is.
4. **No case status lifecycle** (draft/active/deprecated) — play-all
   selects by tag/app only.
5. **Evidence retention is LATEST-ONLY per template**
   (playback.ts:320-323 prune). The brief requires historical runs to
   resolve their artifacts; today the previous run's artifacts are
   DELETED on the next run. Direct product tension — must be surfaced,
   not silently changed (disk growth).
6. **No git under the cases** — they live in SQLite. The brief's
   "reuse Git SHA" branch is inapplicable ⇒ content-hash snapshots are
   the only route.

---

## Part 2 — Data model

```
templates (TestCase)          + status TEXT CHECK(in ('draft','active','deprecated')) DEFAULT 'active'
  └─ case_versions            NEW — immutable snapshots
       id (cv_*), template_id FK, revision INTEGER, yaml_canonical TEXT,
       steps_sha256 TEXT, scenario_id TEXT NULL, scenario_snapshot_json TEXT NULL,
       created_at, created_by, source TEXT CHECK('run','publish')
       UNIQUE(template_id, revision)
  └─ suites                   NEW — id (su_*), name UNIQUE, description,
       created_by, created_at
  └─ suite_members            NEW — suite_id FK, template_id FK, added_by, added_at,
       PRIMARY KEY(suite_id, template_id)

runs                          + case_version_id TEXT REFERENCES case_versions(id)
  (existing scenario_id/scenario_sha columns START WRITTEN at playback)
  + variant_id TEXT NULL
  + suite_id TEXT NULL REFERENCES suites(id)  — when launched via suite play
```

Deliberate decisions:
- **Version stores `yaml_canonical`** (the serialized YAML of that
  revision) — not just a hash. "Resolve the exact YAML" must survive
  template deletion; a hash alone can't. Size is trivial (KBs).
- **Scenario snapshot rides the version row** (`scenario_snapshot_json`:
  the preset rows + body-file shas at snapshot time). Presets already
  carry sha256; scenario-level versioning (a whole new table per the
  brief's alternative) is over-engineering when the consumer only needs
  "what did the network look like". `runs.scenario_sha` = sha of that
  snapshot.
- **`revision` is monotonic per template** (max+1), not a hash — humans
  read run history; the hash lives alongside for integrity.
- **Suites many-to-many** per the brief; plans UNTOUCHED (an invocation
  may later reference a suite — out of scope, noted in DEFERRED).
- **No TestSuiteVersion** (brief forbids); suite runs snapshot their
  member-list into the batch spec, which the queue already persists
  (`queue.spec_json`).

## Part 3 — YAML schema changes (one key)

```yaml
name: Render account status
variants:
  - id: active            # [a-z][a-z0-9_-]* ; unique within case
    networkScenario: account-active   # optional; scenario NAME (resolution total — UNIQUE)
    env: { expected_title: "Account Active" }   # optional
steps: [...]
```

- `variants` joins case-yaml's top-level keys; absent ⇒ EXACTLY today's
  behavior (backward compat by construction).
- `id` is required per variant; `networkScenario`/`env` optional.
- Variable references stay `${env.X}` — variant env enters the SAME
  resolution map. Resolution order: **variant env > invocation env >
  plan env** (narrowest wins; missing key keeps today's honest step error).
- `runFlow` inside a variant case: flows execute with the variant's env
  merged (no per-flow variant lists — v1 out of scope, DEFERRED).
- Serialization round-trip: `caseToYaml` emits `variants` only when
  present (old cases stay byte-stable).

## Part 4 — Migrations (migrateM1 contract)

1. NEW TABLES in the `db.exec` CREATE block: `case_versions`, `suites`,
   `suite_members` (NEVER in the guarded-ALTER loop — dead-DDL trap).
2. Guarded ALTER (column-adds only): `templates ADD COLUMN status`,
   `runs ADD COLUMN case_version_id`, `runs ADD COLUMN variant_id`,
   `runs ADD COLUMN suite_id`.
3. Index: `idx_case_versions_template(template_id, revision DESC)`;
   `idx_runs_version(case_version_id)`.
4. Backfill (one-time, idempotent): create revision-1 snapshots for every
   existing template so historical runs can reference *something* honest;
   leave legacy runs' `case_version_id` NULL (they predate versioning —
   the UI shows "pre-versioning" honestly rather than lying).

## Part 5 — Runner execution-flow changes

1. **Snapshot at run start** (`runTemplatePlayback`): compute
   `steps_sha256`; if latest version's hash differs (or none) → insert
   new `case_versions` row (source='run'). Write `runs.case_version_id`,
   `scenario_id`+`scenario_sha` (snapshot of resolved presets), and
   `variant_id` when applicable. The self-hardening rewrite
   (playback.ts:1060) moves AFTER snapshot semantics: a hardening rewrite
   bumps the NEXT run's version, never the running one's.
2. **Variant expansion at fan-out** (`runBatch`): cases selected by
   tag/app expand to `[case × variant]` BEFORE `planLanes` (a 3-variant
   case = 3 lane entries, cost = latest run ×3 estimate). Single-template
   playback route: variant param optional (default all, matching
   play-all).
3. **Scenario wiring per variant**: variant `networkScenario` overrides
   batch-level `scenarioId` for that execution (batch-level scenario +
   variant scenario = 400 at expansion, honest conflict error — same class
   as ParallelScenarioError).
4. **Suite play**: new route `POST /api/suites/:id/play` → resolves
   member templates → same runBatch engine with `suite_id` stamped on
   runs. Suite ≠ stored plan; it's a live membership read.
5. **Evidence retention**: unchanged in this phase (latest-only stays).
  The brief's "artifacts must resolve" is met for the CURRENT run set;
  historical-artifact retention is surfaced as a product decision
  (disk-growth tradeoff) in the phase gate — not silently altered.

## Part 6 — Backward compatibility strategy

- No `variants` key ⇒ parse, serialize, run, count — all identical
  (existing corpus is the regression suite; every current test must pass
  UNCHANGED — that's the receipt, same as P3's route test).
- `steps_json` remains the executable truth; versions are WRITES-ONLY
  shadows (read path only for history/audit).
- API additions only: templates CRUD untouched; new suites CRUD + suite
  play + `GET /api/templates/:id/versions`.
- Legacy runs show honest "pre-versioning" instead of fabricated links.
- Vocabulary route (`/api/templates/vocabulary`) gains variant ids +
  scenario names (autocomplete completeness; malformed-steps tolerant).

## Part 7 — Validation (in case-yaml, line-carrying)

| Rule | Error shape |
|---|---|
| variant `id` missing / bad shape / duplicate | `variants[i]: …` with line |
| empty `variants:` list | line 1, "remove the key or add a variant" |
| unknown variant keys | `variants[i]: unknown key "x" — id/networkScenario/env` |
| `networkScenario` unresolved (name → no scenario row) | expansion-time 400 naming the case+variant (parse can't see the DB — SAME split as runFlow names today) |
| unresolved `${env.X}` at playback | existing per-step missing-env error (already ships) |
| duplicate case names / suite names | existing UNIQUE constraints → 409 (already ships for templates) |
| versioned scenario references a DELETED preset | snapshot row is self-contained (preset rows copied) — cannot dangle by construction |

("Mutable dependencies referenced by a published version" — moot under
snapshot-on-run: there is no publish act in v1, next section.)

## Part 8 — Phased plan (each phase = commits + gates)

- **Phase A — schema + versions (invisibly valuable):** migrations,
  snapshot-on-run, run-reference columns + scenario_sha finally written,
  versions read route. Tests: version created on first run; NEW version
  after steps change; same-version reuse when unchanged; legacy runs
  honest-null.
- **Phase B — YAML variants:** case-yaml parse/serialize/validation +
  vocabulary + editor autocomplete; NO runner change yet. Tests: 3-variant
  parse; duplicate/invalid ids; round-trip byte-stability of variantless
  cases.
- **Phase C — runner expansion:** runBatch/play expansion, variant env
  merge order, variant scenario override + conflict 400, per-variant runs
  + artifacts + `variant_id`. Tests: expansion count, env precedence
  (variant > invocation), variant-without-scenario default, backward-compat
  corpus green unchanged.
- **Phase D — suites:** tables, CRUD routes, membership endpoints, suite
  play stamping `suite_id`, web UI (⚠ concept-first + ≥3 sketches per the
  design-preview rule BEFORE building; suites are a new user-facing noun).
- **Phase E — status lifecycle + docs:** `status` column, play-all
  default excludes `deprecated`, filter chips; guide updates; DEFERRED
  entries (plans-reference-suites, per-flow variants, publish act,
  evidence-retention decision).

Explicitly OUT: publish act (implicit snapshot-on-run covers the brief's
"executed for the first time after changing"; an explicit publish adds a
TestRail workflow QA didn't ask for — revisit on demand), TestSuiteVersion
(brief forbids), git integration (N/A), per-flow variants, rewriting the
recorder/runner.

---

## Self-review (performed while writing; findings folded back)

- **(a) executed each planned test mentally:** the "same-version reuse"
  test must run playback TWICE with no edit — the second run reuses
  revision N (assert count, not identity). The env-precedence test needs
  a key present in BOTH variant and invocation env with different values.
- **(b) both ends of every data link:** version row written at run start ↔
  read by `GET /versions` + run detail join; `variant_id` written at
  fan-out ↔ read by run-detail; `scenario_sha` computed from the SAME
  snapshot json stored on the version row (sha-of-snapshot, not of
  presets at some other time).
- **(c) factual claims re-verified:** runs INSERT (playback.ts:316) lacks
  scenario_id today; scenario columns exist unused (schema.ts:22);
  self-hardening rewrite exists (playback.ts:1060); plans ≠ suites
  (schema.ts:268); evidence prune latest-only (playback.ts:320).
- **(f) schema placement:** all NEW tables in CREATE block; ALTERs are
  column-adds only; backfill idempotent via `max(revision) IS NULL` guard.
- **(g) harness determinism:** variant-expansion tests seed templates +
  devices rows per the post-resolveUdid rule; no wall-clock asserts.
- **Edge table walked:** template deleted after versioned run → version
  row survives (no FK cascade — deliberate; runs.template_id already
  SET NULL, version keeps the content); variant case in a plan (plans
  select by tags → expansion applies — covered in Phase C tests); 0
  active cases in suite play → honest 400 like play-all; variant id
  colliding with env keys → namespaces differ (`env.` prefix), no clash.
- **Honesty audit:** no fabricated back-references (legacy runs stay
  null); suite runs state their suite; variant runs state their variant;
  versions state their source ('run').
- **Scope check vs brief:** every brief bullet maps to a phase or an
  explicit OUT with reason. "UIInspector SDK" read as the alloy engine —
  decoupling constraint already satisfied by architecture.
