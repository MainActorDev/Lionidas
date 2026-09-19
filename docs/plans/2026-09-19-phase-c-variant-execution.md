# Phase C — Variant Execution: Case × Variant Expansion (Implementation Plan)

> **For Hermes:** parent plan `docs/plans/2026-09-18-testcase-management.md`
> (Phase C section); Phase B shipped the format (`variants:` parses,
> validates, stores, autocompletes — `bbd065b…53fa51a`). Implement
> task-by-task, per-task verify + commit. The honest interim ends here:
> after Phase C, a variants case expands to N executions everywhere cases
> run.

**Goal:** A case with variants executes as one run PER variant — each with
its network scenario installed, its env merged (variant > invocation),
`runs.variant_id` stamped, and provenance pinning the variant's exact
inputs. A variantless case behaves exactly as today (the compat receipt).

**Architecture:** Expansion lives at the TWO run entry points — the
single-play route (`POST /api/templates/:id/play`) and the batch engine
(`runBatch` → `planLanes` input) — NOT inside `runTemplatePlayback`.
Playback gains a `variant` opt (the resolved `YamlVariant`) that (a) merges
env via the Phase-B-tested `mergeVariantEnv`, (b) overrides the scenario,
(c) stamps `runs.variant_id`, (d) passes the variant into the provenance
snapshot. Run rows carry `variant_id`; the runs list route + UI surface it.

**Tech Stack:** `server/src/manual/playback.ts` (opts + INSERT + env merge
seam), `routes/manual.ts` (single-play expansion), `batch/plan.ts` +
`routes/manual.ts runBatch` (lane expansion), `case-versions.ts` (variant
identity in provenance), vitest; runs-page chip.

---

## Verified facts (receipts, 2026-09-19)

1. **Playback env seam is singular**: `substituteStep(s, opts.env ?? {})`
   (playback.ts:643) — every step resolves through ONE map. Variant env
   merges into `opts.env` BEFORE dispatch; no other call site.
2. **Playback opts shape**: `{udid?, triggeredBy?, scenarioId?, bundleId?,
   env?, forgeAttribution?}` (playback.ts:235) — additive `variant?` is
   safe; both call sites (single-play :400, runBatch :557) spread their own
   opts objects.
3. **runs.variant_id column EXISTS, unwritten** (Phase A T1, schema.ts:254)
   — Phase C only starts writing it. The runs INSERT (playback.ts:330)
   needs one more column.
4. **Batch expansion point**: `runBatch` selects templates (manual.ts:515)
   → `planLanes({cases: sel.map(templateId…), devices…})` (manual.ts:541).
   Variants must expand BETWEEN select and planLanes — a 3-variant case
   becomes 3 lane entries (cost = latest-run ×N estimate).
5. **Lane runner is uniform**: pool.ts:79 `runOne(c.templateId, udid,
   {...opts, udid})` — the lane case shape `{templateId, costMs}` gains
   `variantId`, passed through to runOne.
6. **Provenance identity today**: sha(steps_json) + scenario CHOICE
   (case-versions.ts). A variant's env is NOT in steps_json — variant env
   must join the identity or two variants of one case would SHARE a
   version row (wrong: different expected outcomes).
7. **Single-play route** (manual.ts:397-415) passes body opts through;
   returns `{runId, udid}`.
8. **Evidence retention is latest-only per template**
   (retention.ts:24-31, keyed by template_id) — variant runs of ONE case
   would prune EACH OTHER's artifacts as they finish. Must key per
   template+variant for variant runs (minimal change), not defer.
9. **Vocabulary/`runFlow`**: `expandFlows` loads child steps by template
   id (playback.ts:531) — flows inherit the variant env via the merged
   map (env applies to the WHOLE execution, including flow children).
   Parent-plan policy ("flows inherit variant env") = this seam, free.
10. **PlanBatch haltedAt** (pool.ts:16) names a templateId — with
    variants, the halt reason should name the variant too (UX honesty).
11. **Existing corpus**: every playback/batch test seeds variantless
    templates — they are the compat receipt (must pass unchanged).

---

## Design decisions (alternatives rejected)

### D1 — Expand at entry points, not inside playback
Playback executes ONE world. Expansion inside it (loop over variants)
would tangle the settle/watchdog/evidence lifecycle (one recorder per run
row) with loop control. Rejected. The two entry points each expand:
- **Single play**: route reads `variants_json`; N variants → N sequential
  `runTemplatePlayback` calls (variant order = declaration order,
  deterministic); 1-variant or variantless → exactly today's shape.
- **Batch**: expand case list → lane entries before planLanes.

### D2 — Variant identity in provenance (fixes fact 6)
`snapshotCaseVersion` identity becomes sha(steps_json) + scenario CHOICE +
**variant env json** (`variant.env ? JSON.stringify(variant.env) : ''`).
Two variants with different env → two versions. Two variants with the SAME
env and scenario → one version, honestly shared (identical inputs).
The version row gains `variant_id` (denormalized label; identity is the
content, the id is the name).

### D3 — Scenario precedence: variant wins over invocation
`opts.scenarioId` (batch/invocation) vs `variant.networkScenario`:
**variant wins** (narrowest scope, consistent with env precedence).
Conflict is NOT an error — the invocation scenario applies to variantless
cases in the same batch, variants override it for their own executions.
A variant with NO scenario + invocation scenario → invocation applies
(inherits the batch's world). Deliberate: parent plan floated a conflict
400; that punishes the common "default scenario + one special variant"
pattern. Rejected conflict-error.

### D4 — `runs.variant_id` + note label
Run rows stamp `variant_id`. The human-facing label rides the existing
note convention: `template:<id> <name>` becomes
`template:<id> <name> / <variant>` — the runs-page caseName parser
(`note.slice(note.indexOf(' ') + 1)`) picks it up with ZERO UI change;
the chip wiring reads `variant_id` directly.

### D5 — Retention keys per variant (fact 8)
`prunePreviousRunArtifacts` gains an optional `variantId` in the
`templateId` key: WHERE template_id = ? AND (variant match). Variantless
runs keep today's behavior exactly (NULL variant matches only NULL).
Latest-only semantics become latest-only-PER-VARIANT — the honest reading
of the existing product decision.

### D6 — Cost estimation ×N (batch planner)
`costFor(templateId)` returns latest finished run duration. For a variant
case with no per-variant history, estimate = latest × variantCount
(deterministic, monotone); once per-variant runs exist, average the
variant's own last 3 runs. Simple, no schema change.

---

## Tasks

### T1 — Playback `variant` opt: env merge, scenario override, run stamp
**Files:** `server/src/manual/playback.ts`

- opts type gains `variant?: YamlVariant | null` (import from shared).
- At env seam (fact 1): `const env = mergeVariantEnv(opts.variant ?? null, opts.env ?? {})`
  → `substituteStep(s, env)`.
- Scenario resolve: `const scenarioId = opts.variant?.networkScenario ?? opts.scenarioId ?? null`
  → used by BOTH the provenance snapshot call and the runs INSERT (fact 2's
  scenarioId + D3).
- runs INSERT adds `variant_id` (fact 3): `opts.variant?.id ?? null`; note
  label per D4.
- **Tests** (`server/test/playback-variant.test.ts`, fake-alloy harness):
  1. variantless run → variant_id NULL, note unchanged (compat)
  2. variant run → variant_id stamped, note carries `/ active`
  3. variant env reaches `${…}` in steps (expect step resolves the
     variant's value)
  4. variant env OVERRIDES invocation env on collision
  5. variant scenario overrides invocation scenarioId (snapshot identity
     differs — assert two variants → two version rows)
  6. variant WITHOUT scenario inherits invocation scenario
- Existing playback tests: UNCHANGED (compat receipt).

### T2 — Provenance: variant env in version identity
**Files:** `server/src/manual/case-versions.ts`, tests

- `snapshotCaseVersion` args gain `variant?: YamlVariant | null`.
- Identity string: sha(steps_json) + '\0' + scenarioId + '\0' + envJson
  (D2); version row stores `variant_id` label.
- canonicalYaml: unchanged (variant env is not part of the case doc; the
  version's yaml stays the case yaml — the variant is recorded by id on
  the row and by env in identity).
- **Tests** (`server/test/case-versions.test.ts` extend): two variants,
  same steps+scenario, different env → 2 revisions; same env → shared
  revision; backfill reuse unaffected.

### T3 — Single-play expansion route
**Files:** `server/src/routes/manual.ts`

- `POST /api/templates/:id/play` reads the template's `variants_json`:
  - none → exactly today's call (compat)
  - N variants → loop, sequential, each `{...opts, variant}`; response
    becomes `{runIds: [...], udid, variants: [{id, runId}]}` (additive:
    `runId` key kept for N=1 single-shape callers — 1-variant case returns
    both keys)
- Body may pass `variant?: string` (run ONE named variant — the manual
  "just test pending" case): unknown id → 422 naming it.
- **Tests** (`server/test/play-variant-route.test.ts` via buildApp +
  fake dispatch): no-variants single shape; 3-variant case → 3 runIds in
  declaration order, each stamped; `variant: 'pending'` → exactly one run;
  unknown variant → 422; DEVICE_BUSY mid-sequence → honest abort, later
  variants do not run (sequential contract).

### T4 — Batch expansion + planner cost
**Files:** `server/src/routes/manual.ts` (runBatch), `server/src/manual/batch/plan.ts`, `pool.ts` passthrough

- runBatch: after `selectTemplates`, expand: for each template read
  `variants_json` → lane cases become `{templateId, variantId?, costMs}`.
  Batch-level `scenarioId`/`env` ride opts (variants override per T1).
- planLanes: accept optional `variantId` on case entries (dedupe key
  becomes templateId+variantId); sorting unchanged.
- pool `runOne(templateId, udid, opts)` signature gains the variant
  resolution: runBatch's runOne closure reads the case's variantId →
  resolves the YamlVariant → passes `variant` into runTemplatePlayback.
  haltedAt naming per fact 10 (`templateId/variantId` string).
- **Tests** (`server/test/batch-variants.test.ts`): 2 cases (one 2-variant,
  one plain) → 3 lane executions, 3 runIds, stamps correct; dedupe:
  same case+variant twice → one execution (variantless dedupe unchanged);
  cost ×N estimate present in lanes when no history.

### T5 — Retention per variant
**Files:** `server/src/evidence/retention.ts`, playback call site

- `RetentionKey` template shape gains `variantId?: string | null`; WHERE
  clause: `AND variant_id IS ?` (NULL matches NULL — variantless unchanged).
- Playback passes `variantId: opts.variant?.id ?? null`.
- **Tests**: variant run prunes only its variant's prior artifacts;
  variantless run prunes only NULL-variant priors; siblings survive.

### T6 — Runs list + chip surfacing
**Files:** `server/src/routes/runs.ts` (list SELECT already `*` —
`variant_id` rides free; include in versionMeta join unchanged), 
`web/src/pages/RunsPage.vue` (chip shows `/ active` after revision chip)

- Runs page: variant suffix on the case cell (`login / active`), derived
  from `r.variant_id`; tooltip names the scenario when available (joined
  via versionInfo extension — add `variantId` to versionMeta payload).
- **Tests**: route receipt (variant_id in list payload); browser drill:
  chip renders, stale logic unchanged.
- vue-tsc + vite build gates.

### T7 — Docs + DEFERRED + gates
- Guide: replace the interim sentence ("executes next phase") with the
  real behavior (each variant = its own run, own evidence, own version).
- DEFERRED H: Phase C shipped; carry variant×suite surfaces (Phase D) +
  per-variant trend columns.
- Full gates: server suite `--maxWorkers=2` (compat corpus unchanged),
  vue-tsc, vite build. Docs commits separate.

---

## Explicitly OUT (Phase C)

- Suite play integration (Phase D: suites may reference variant subsets).
- Per-variant trend/history columns on the case table (Phase D UI).
- `?variant=` filter on runs page (cheap later; not required now).
- Parallel variant execution on one device (sequential by contract —
  scenarios are device-global proxy state).
- Cross-DEVICE variant fan-out (a variant lane pinning; batch device
  assignment stays case-granular).

## Edge cases (walked)

| # | Case | Behavior |
|---|---|---|
| 1 | Variant case mid-B→C saved variants, run now | expands — the interim is over; first run may create N versions |
| 2 | Variant references deleted scenario | run-time snapshot records scenario CHOICE; activation best-effort (existing behavior playback.ts:352 catch) — run proceeds, provenance honest |
| 3 | 12 variants × sequential on one device | long batch; planner cost ×N surfaces it; no artificial cap (max enforced at parse) |
| 4 | Variant env key collides with flow-child's env | flow inherits merged map (fact 9) — parent env wins over child invocation env, variant wins over parent's (documented precedence: variant > invocation > nothing) |
| 5 | Same variant run twice concurrently (two devices) | version identity same → both pin same revision (correct); evidence prune skipped while sibling running (existing guard, now variant-scoped) |
| 6 | `variant` body param + variants absent | 422 "case has no variants" (honest) |
| 7 | Run aborted mid-variant-2 of 3 | later variants skip; aborted run stamps its variant; batch halt names case/variant |
| 8 | Variant case used as runFlow child | child runs variantless (flows don't expand children — declaration-site only); parent's variant env still resolves inside child's steps via merged env |
| 9 | variants_json malformed (hand-edited DB) | expansion try/catch → treat as variantless + warn log (honest degrade, matches vocabulary tolerance) |
| 10 | Invocation env sets a key the variant also sets | variant wins (D3 rule; test T1-4) |

## Gates

`pnpm typecheck && pnpm lint && CI=true pnpm vitest run --maxWorkers=2`;
`vue-tsc && vite build`. Existing suites = the compat receipt.

---

## Self-review (findings folded back)

1. **(a) executed tests mentally:** T3's DEVICE_BUSY-mid-sequence test must
   fake busy on the SECOND variant (assert run 1 finished, run 3 never
   started — runIds length 1); my draft first asserted only "not all 3,"
   which passes even if 2 ran. T4's dedupe test needs the SAME
   template+variant listed twice via two tag-matching rows — planner input
   dedupe, not natural batch shape.
2. **(b) both ends of links:** `runs.variant_id` written (T1) ↔ read by
   list route (T6, free via SELECT *) ↔ chip (T6) ↔ retention WHERE (T5)
   ↔ provenance label (T2). `variantId` in versionMeta payload produced
   (T6 route) ↔ consumed (chip tooltip).
3. **(c) receipts re-checked:** env seam singular (fact 1) — verified this
   session; retention WHERE clause exact (fact 8) — the prune guard reads
   template_id only, variant scoping is additive SQL; pool runOne uniform
   (fact 5); runs INSERT site (fact 3).
4. **(f) schema:** NO new migrations — variant_id existed since Phase A
   (the one-migration-era decision paying off). case_versions gains
   variant_id via guarded ALTER (column-add, T2).
5. **(g) determinism:** no wall-clock asserts; sequential expansion order
   = declaration order (deterministic); planner tests assert lane
   composition, not timing.
6. **D3 reversal noted honestly:** the parent plan said conflict-400; this
   plan rejects it with a use-case argument. Flagged for the user gate —
   if you prefer strict conflict errors, T1 changes one line + one test.
7. **Sequencing risk (T4):** runBatch + planLanes + pool signatures change
   together — land as ONE commit with both test files; a partial push
   would break lane typing (no consumer outside this repo).
8. **Scenario activation timing:** variant scenario is activated per-run
   inside playback (existing opts.scenarioId path) — no NEW proxy state
   handling; sequential runs restore between (existing service owns it).
   Verified the restore path exists (playback.ts:344-353).
9. **Honesty audit:** variant runs are named (`/ active`) everywhere a
   human looks — note, run row, version label, halt reason. A failed
   variant never masquerades as the plain case (variant_id always stamped
   for variant executions).
10. **Cost estimate honesty:** ×N is an estimate; planner already
    tolerates null costs. No invented precision (no averaging before
    history exists).
