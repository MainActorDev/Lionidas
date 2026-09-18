# Phase A — Case Versions: Immutable Run Provenance (Implementation Plan)

> **For Hermes:** parent plan `docs/plans/2026-09-18-testcase-management.md`
> (assessment + data model). Implement task-by-task, per-task verify +
> commit. UI (version-history surface) is EXCLUDED — sketches delivered
> separately, build gated by the user per the design-preview drill. Gates
> per repo standard.

**Goal:** Every automated run references an immutable snapshot of the
exact YAML, steps, and network scenario it executed — created lazily on
first-run-after-change — so any historical run resolves its inputs even
after the case is edited or deleted.

**Architecture:** New `case_versions` table (content-addressed by
steps-sha, monotonic per-template revision, self-contained scenario
snapshot). `runTemplatePlayback` snapshots at run start; `runs` gains
`case_version_id` (+ finally WRITES the existing-but-dead `scenario_id`/
`scenario_sha` columns). Read-only surface: one list route. No behavior
change to any existing path — the corpus is the regression suite.

**Tech Stack:** `migrateM1` (CREATE-block + guarded-ALTER contract),
`shared/case-yaml#caseToYaml` (canonical YAML), `runTemplatePlayback`,
Fastify routes, vitest (real in-memory DB per file; playback harness
pattern from playback-expect.test.ts).

---

## Verified facts (receipts, 2026-09-18)

1. **runs INSERT today** (playback.ts:316-318): `(id, ticket_key, kind,
   status, triggered_by, device_udid, started_at, note, template_id,
   app_version)` — no version, no scenario. The `runs.scenario_id` /
   `scenario_sha` columns (schema.ts:22) have NEVER been written (dead
   schema since creation).
2. **Case shape for canonical YAML**: `caseToYaml({name, tags, app?,
   setup?, alerts?, steps})` (case-yaml.ts:351) — reconstructable from a
   template row + `steps_json` (setup_json exists on the row; alerts
   policy is `alerts_policy`).
3. **Self-hardening sweep** rewrites `templates.steps_json` mid-run
   (playback.ts:1058-1074, match-by-action+coords) — the snapshot MUST be
   taken BEFORE playback begins, and the rewrite bumps the NEXT run's
   version, never the running run's.
4. **Scenario activation** (playback.ts:344-353): presets joined via
   scenario_overrides, activated through forgeStateService, restore handled
   by the service. `opts.scenarioId` arrives from batch opts / queue spec.
5. **Evidence retention stays latest-only** (playback.ts:320-323) — Phase A
   does NOT touch it (flagged product decision in the parent plan).
6. **Migration contract**: NEW TABLES go in the `db.exec` CREATE block;
   the guarded loop at schema.ts:207+ is COLUMN-adds only; backfills must
   be idempotent (tsx-watch re-runs migrate on every edit).
7. **Harness pattern**: seed template + fake alloy via `__setAlloyForTest`
   (playback-expect.test.ts:20-48); runs need `allowAct` toggling; DB is
   a real file (`CRUCIBLE_DB_PATH`) migrated before buildApp.
8. **Play-all batch engine**: `runBatch` → `planLanes` → per-template
   `runTemplatePlayback` (manual.ts:506-583) — version stamping INSIDE
   runTemplatePlayback covers single + batch + plan paths with ONE seam.

---

## Tasks

### T1 — Schema: `case_versions` + run columns

**Files:** `server/src/db/schema.ts`

- CREATE block (before the guarded ALTER loop):
```sql
CREATE TABLE IF NOT EXISTS case_versions(
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL,          -- NO FK cascade: version must survive template deletion
  revision INTEGER NOT NULL,
  steps_sha256 TEXT NOT NULL,
  yaml_canonical TEXT NOT NULL,
  scenario_id TEXT,
  scenario_snapshot_json TEXT,        -- resolved preset rows at snapshot time (self-contained)
  variant_id TEXT,                    -- Phase C fills it; column lands now (one ALTER-era)
  source TEXT NOT NULL CHECK(source IN ('run','backfill')) DEFAULT 'run',
  created_by TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(template_id, revision)
);
CREATE INDEX IF NOT EXISTS idx_case_versions_template ON case_versions(template_id, revision DESC);
```
- Guarded ALTER adds: `runs ADD COLUMN case_version_id TEXT`,
  `runs ADD COLUMN variant_id TEXT` (runs side, not version side — a run
  names its variant; a version stays variant-free until Phase C reuses
  the column on new per-variant versions).

  ⚠ Correction from self-review (see below): `variant_id` belongs on
  `runs` ONLY in Phase A. The `case_versions.variant_id` column above is
  REMOVED — per-variant versioning is a Phase C decision (variant env
  changes the YAML hash → separate versions THEN, keyed the same way).
- `CREATE INDEX IF NOT EXISTS idx_runs_version ON runs(case_version_id);`
- Backfill (idempotent, after ALTERs): for each template with zero
  versions, insert revision 1, `source='backfill'`, `scenario_id` from
  the template's `default_preset_id`? NO — from nothing: templates carry
  no scenario binding; `scenario_snapshot_json` NULL. Revisions start
  honest: backfill = current content, no invented provenance.
- **Test** (`server/test/schema-versions.test.ts`): fresh DB → tables +
  columns exist; second migrate run (idempotence) → no error, no dup
  backfill rows; template with pre-existing version → not re-backfilled.

### T2 — Snapshot service (`server/src/manual/case-versions.ts`)

Pure-ish module, DB-injected:

```ts
export interface VersionSnapshot { id: string; revision: number; isNew: boolean }
export function snapshotCaseVersion(db, args: {
  templateId: string; scenarioId?: string | null; triggeredBy?: string | null;
}): VersionSnapshot
```

- Read template row (`name, tags_json, app_bundle_id, setup_json,
  alerts_policy, steps_json, ticket_key`).
- Canonical YAML via `caseToYaml` from the row fields (setup parsed from
  setup_json; alerts from alerts_policy) — the SAME serializer the editor
  preview uses (no second yaml writer can drift).
- `steps_sha256` = sha256 of `steps_json` (raw stored string — byte-truth,
  not re-serialized steps; the executable truth IS steps_json).
- Scenario snapshot: if `scenarioId` — resolve preset rows (same JOIN as
  playback.ts:346), store `JSON.stringify(presets)` (each preset already
  carries its own sha256; body files referenced by `body_path` get a
  `{path, sha256, bytes}` manifest inside the snapshot — body files live
  on disk and CAN drift).
- Lookup latest version by `(template_id)` order revision desc; if
  `steps_sha256` AND `scenario_id` match → REUSE (return existing id,
  `isNew:false`). Else insert revision = max+1.
- **Tests** (`server/test/case-versions.test.ts`, real DB):
  1. first snapshot → revision 1, isNew
  2. immediate second snapshot, nothing changed → same id, isNew:false
  3. edit steps_json → revision 2
  4. scenario differs, steps same → revision 2 (scenario is part of
     identity — receipt for the brief's "network-scenario revision")
  5. scenario preset EDITED (body bytes changed) → same revision (preset
     sha lives in the snapshot; identity = template content + scenario
     CHOICE, not the scenario's content — snapshot content records what
     was resolved)
  6. template deleted after versioning → version rows survive (no FK)
  7. yaml_canonical round-trips through `parseCaseYaml` to the same steps

### T3 — Playback wiring

**Files:** `server/src/manual/playback.ts`

- At run start, right AFTER the template row load (before any step
  execution, before the self-hardening sweep could fire):
  `snapshotCaseVersion(db, {templateId, scenarioId: opts.scenarioId,
  triggeredBy: opts.triggeredBy})` → carry `versionId`.
- runs INSERT (line ~316): add `case_version_id`, `scenario_id`,
  `scenario_sha` — `scenario_sha` = sha256 of the stored snapshot json
  (or NULL when no scenario).
- Failure of snapshotting = run fails honestly (throw — a run that
  cannot name its provenance is not evidence). Wrap so the runs row still
  lands with status='aborted' + note (existing error-path shape,
  playback.ts:1105).
- **Tests** (`server/test/playback-version.test.ts`, harness from T-facts
  #7): run once → runs.case_version_id set, scenario cols NULL (no
  scenario); run with `opts.scenarioId` (+ seeded presets/scenario rows)
  → scenario_id + scenario_sha set, sha matches sha256 of the version's
  snapshot json; self-hardening rewrite mid-run → NEXT run snapshots a
  NEW revision, the executed run keeps referencing the old one.
- **Backward-compat receipt**: every existing playback test must pass
  UNCHANGED (they assert behavior, not the new columns).

### T4 — Read route + run-detail join

**Files:** `server/src/routes/templates.ts`

- `GET /api/templates/:id/versions` → `[{id, revision, stepsSha,
  scenarioId, createdAt, createdBy, source, yaml}]` (yaml inline — this
  IS the audit surface), ordered revision desc. 404 unknown template —
  but versions survive deletion, so also `GET /api/versions/:id` →
  single version + its runs (`SELECT id, status, started_at, app_version
  FROM runs WHERE case_version_id = ? ORDER BY started_at DESC LIMIT 50`).
- Run detail (wherever the panel reads a run — runs.ts show shape):
  include `caseVersion: {id, revision, stepsSha}` when present, honest
  null for pre-versioning runs.
- **Tests** (`server/test/versions-route.test.ts` via buildApp):
  list shape + order, single fetch with runs, 404, legacy-run null
  honesty, auth gate (suite passes `CRUCIBLE_REQUIRE_AUTH` default —
  assert 401 without session, mirroring auth.test patterns).

### T5 — Docs + DEFERRED

- Guide row (one line: "every run pins the exact case version it
  executed — /versions on a case").
- DEFERRED.md: append Phase-A-done note + carry-overs (evidence retention
  decision, per-variant versions (C), publish act, plans-reference-suites).
- Separate docs commit (user preference).

---

## Explicitly OUT (Phase A)

- Any UI (version list panel, badges) — sketches delivered alongside;
  build = separate gated task after the drill.
- Variant columns/behavior (Phase C) — one `runs.variant_id` column lands
  in T1 only to avoid a second migration-era; nothing writes it.
- Suite tables (Phase D), status lifecycle (E), evidence retention change.
- Web bundle changes of any kind.

## Edge cases (walked)

| # | Case | Behavior |
|---|---|---|
| 1 | Template edited between run-start and self-hardening rewrite | snapshot taken BEFORE execution; rewrite bumps next run's revision |
| 2 | Same case run twice concurrently (two lanes) | both snapshot BEFORE either runs; identical hash ⇒ both INSERT attempt revision N+1 — UNIQUE(template_id,revision) makes the loser retry-once (catch + re-read latest) — deliberate tiny race window, resolved by reuse-check |
| 3 | Scenario deleted after versioning | snapshot json is self-contained (preset rows copied) — version unaffected |
| 4 | Body file edited after versioning | snapshot's body manifest records the OLD sha; historical truth preserved (file itself is not copied — noted honestly in route output as `bodyManifest`) |
| 5 | steps_json == current but tags/name changed | SAME revision reused — identity = executable content + scenario, not metadata (names/tags are management, not behavior) |
| 6 | Template deleted | versions survive (no FK); `GET /api/versions/:id` still resolves; template list 404s honestly |
| 7 | tsx-watch double-migrate | guarded CREATE IF NOT EXISTS + idempotent backfill (max-revision check) |
| 8 | Pre-versioning historical runs | `case_version_id` NULL — UI honesty ("pre-versioning"), never fabricated |

## Gates

`pnpm typecheck && pnpm lint && pnpm vitest run --maxWorkers=2` (full
suite — the corpus IS the compat receipt); `vue-tsc && vite build` skipped
(no web changes) but run once anyway as a no-change receipt.

---

## Self-review (findings folded back)

1. **variant_id column placement corrected.** First draft put
   `variant_id` on `case_versions` — wrong: until Phase C decides
   per-variant versioning, a version is variant-free; runs carry the
   variant. Column moved to `runs` (T1), no writer in Phase A.
2. **Identity rule sharpened (edge #5).** "Hash of steps_json only" would
   re-version on cosmetic steps_json reformats (self-hardening rewrite
   changes content though — that's a REAL behavior change, correctly a new
   version). Kept: identity = sha(steps_json) + scenario CHOICE. Walked
   the trap the other way too: if identity included name/tags, renaming a
   case would orphan history from "same behavior" — rejected.
3. **Edge #2 race actually reachable** (parallel lanes run the same
   template after a fresh edit — the planner dedupes by templateId, but
   planLanes dedupe is per-BATCH; two batches from two users can collide).
   UNIQUE constraint + retry-once-reuse added; test seeds the collision
   by snapshotting twice concurrently is overkill for sqlite sync —
   documented as constraint-backed instead of a flaky concurrency test.
4. **(b) both ends of data links:** `runs.case_version_id` written (T3) ↔
   read by run-detail join (T4) and version-runs list; scenario_sha
   computed at snapshot (T2) ↔ asserted in T3 test to equal sha256 of the
   version row's own snapshot json (same string, not a recompute).
5. **(c) receipts re-checked:** runs INSERT line numbers, dead scenario
   columns, self-hardening site, harness shape — all quoted from fresh
   reads this session, not memory.
6. **(f) schema placement:** new table in CREATE block, ALTERs
   column-only, backfill guarded — matches migrateM1 contract (skill rule
   (f)). Fresh-DB path tested explicitly (T1 test 1).
7. **(g) determinism:** all tests synchronous DB work or the existing
   fake-alloy harness; no wall-clock asserts; no sleep-based waits.
8. **Snapshot failure honesty:** a run that cannot record provenance
   aborts with a note rather than passing unversioned — matches the
   "status is computed, evidence is real" house stance. (If this proves
   noisy in practice the fallback is warn+NULL — flagged for the phase
   gate, not silently chosen here.)
9. **Sketch scope:** the UI drill (3 options) covers ONLY the
   version-history surface reachable from a case — no dashboard, no
   suites UI, no variant UI (later phases get their own drills).
