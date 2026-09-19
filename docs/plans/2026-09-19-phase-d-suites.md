# Phase D — Suites: Named Collections + Variant Subsets (Implementation Plan)

> **For Hermes:** parent plan `docs/plans/2026-09-18-testcase-management.md`
> (Part 4 migrations, Part 5.4 suite play, Part 8 Phase D); DEFERRED §G
> (line 285: concept-first + sketches BEFORE any UI) and §H carry-forwards
> (suite × variant surfaces, per-variant trend, `?variant=` filter,
> plans-reference-suites). Phase C shipped variant expansion end-to-end
> (live-verified on the intl app 2026-09-19). Implement task-by-task,
> per-task verify + commit. UI tasks are GATED on the sketch pick.

**Goal:** A suite is a named, ordered collection of case memberships, where
each membership is one case plus an optional variant subset. Playing a
suite runs exactly those (case × variant) executions through the SAME
engine as play-all — lanes, halts, per-variant retention — with
`runs.suite_id` stamped. Plans may reference a suite as their case source.
Per-variant verdicts and a `?variant=` runs filter close Phase C's
carry-forwards.

**Concept (the noun, before any UI):** suites are ORGANIZATIONAL — a live
membership read, not a snapshot (parent Part 5.4; TestSuiteVersion is
forbidden by the brief). A case's verdict is computed once and shown
everywhere it appears (home board, case table, every suite detail) — one
source of truth. The home page's "run suite" button (play-all) is the
implicit all-cases suite; named suites are subsets with pinned variant
selections. Suites do NOT carry env/scenario of their own — the play body
accepts the same `{udid?, scenarioId?, env?}` play-all accepts, with the
same semantics (variant scenario still wins over batch, D3 of phase C).

**Tech Stack:** `server/src/db/schema.ts` (CREATE block + guarded ALTERs),
new `server/src/routes/suites.ts`, `server/src/routes/manual.ts` (runBatch
`cases` param + suite play), `server/src/manual/playback.ts` (opts.suiteId
+ INSERT), `server/src/db/suite.ts` (per-variant verdict partition),
`server/src/routes/runs.ts` + `web/src/pages/RunsPage.vue` (variant
filter), plans column + plan-run resolution, `sketches/009-suites/`
(3 options BEFORE UI), vitest.

---

## Verified facts (receipts, 2026-09-19)

1. **No suite schema exists.** `sqlite_master` lists 26 tables — none
   `suite*`. Parent Part 4 promised `suites`, `suite_members`, and
   `runs ADD COLUMN suite_id`; Phase A shipped only `case_versions` +
   `runs.case_version_id`/`variant_id` (schema.ts:248-251). `runs` PRAGMA
   columns end `… case_version_id, variant_id` — no `suite_id`.
2. **`plans` is a remembered invocation** — tags+udid+app+scenario+env,
   0 rows in prod (schema.ts:328-338; `planRow` manual.ts:654-656). No
   suite reference.
3. **`runBatch` selects by tags/app only** via `selectTemplates`, then
   expands ALL variants of each selected case into lane entries
   (manual.ts:538-583). `PlanCase` already carries `variantId` with
   templateId|variantId dedupe (plan.ts:10-17, :42-46).
4. **Playback INSERT site** writes `variant_id` today (playback.ts:337);
   the `opts.variant` seam (env merge, scenario override, run stamp) is
   phase C, live-verified.
5. **`/api/runs` filters** are ticket/template/app_version only
   (runs.ts:74-79). The variant chip renders but doesn't filter
   (RunsPage.vue:97-100).
6. **`suiteVerdicts` partitions by `template_id` only** (db/suite.ts:32) —
   variant executions currently fold into ONE mixed trend per case.
7. **Vocabulary collision:** `/` is `SuiteHomePage` — the whole-library
   board whose button says "run suite" (= play-all, SuiteHomePage.vue:41).
   The NEW noun must not silently overload it.
8. **Plans run + play-all share `runBatch`** (manual.ts:704-716) — one
   engine, `triggeredBy` attribution differs.
9. Gate commands (phase C T7 receipt): `pnpm typecheck && pnpm lint &&
   CI=true pnpm vitest run --maxWorkers=2`; `vue-tsc && vite build`.

## Design decisions (alternatives rejected)

### D1 — Membership = (suite, case) row with a variant-subset JSON
`variant_ids_json`: `NULL` = the case's default play semantics (variants
case → all variants; plain case → plain); `["sg","my"]` = subset. Rejected:
one row per (case, variant) — pollutes membership UX for plain cases and
makes "all variants" unstorable; tags-on-templates as implicit suites —
tags are per-case metadata with no ordering, no name uniqueness, no
variant pinning (that's what plans approximate today and why they're not
suites).

### D2 — Suite play goes THROUGH runBatch, via an explicit `cases` param
`runBatch` gains an optional `cases: Array<{templateId, variantIds?}>`
input; when present it REPLACES tag selection (members resolved by the
suite route, expansion consults each member's subset). Rejected: suite
route looping `runTemplatePlayback` directly — bypasses lanes/pool/halts/
abort = a second engine; synthesizing a tag per suite — mutable, collides
with user tags, dishonest provenance.

### D3 — Verdicts stay per-case; per-variant is a partition, not a second truth
`suiteVerdicts` gains an optional per-variant breakdown
(`variants: [{id, lastStatus, lastBlocked, trend}]` on the case payload,
plain runs = the NULL-variant partition). Suite detail boards are the SAME
verdict map filtered by membership. Rejected: per-suite stored verdicts —
computed status is never stored (db/suite.ts header rule).

### D4 — Plans reference suites by `suite_id`; exactly-one-of tags|suite
`plans.suite_id` (guarded ALTER). Create/update with BOTH tags and suite →
400; plan run with `suite_id` resolves members via the D2 param. Rejected:
mirroring a suite's cases into plan tags — drifts the moment either edits.

### D5 — FK semantics: membership dies with its case; runs survive their suite
`suite_members.template_id REFERENCES templates ON DELETE CASCADE`;
`runs.suite_id REFERENCES suites ON DELETE SET NULL`. A deleted suite's
historical runs keep their rows and render `suite: <deleted>` honestly.

### D6 — UI is sketch-gated; server is not
T0 produces `sketches/009-suites/option-{1,2,3}-*.html` + concept labels
(resolves the D1-noun wording AND the `/`-page collision: home stays
all-cases, wording decided by the picked sketch). NO suite UI lands before
the pick (DEFERRED ⚠; house rule ≥3 options → pick → 1:1 verbatim). Server
tasks T1-T5 ship independently.

### D7 — `position` column on members; order is declaration order
Deterministic playback order + stable reordering UX; dedupe at expansion
stays templateId|variantId-first-wins (existing plan.ts rule).

---

## Tasks

### T0 — Concept sketches (GATE for all UI; no code) — ✅ PICKED 2026-09-19
**PICK: option-1-sidebar-detail** (`sketches/010-suites/option-1-sidebar-detail/`,
commit 565fd72 round). Build spec for T6/T7: `/suites` page — suite list rail
with inline rollups + `+ new`; detail board (name/description, rollup KPI,
ordered member rows, dashed=all-variants default chips / solid=pinned subset,
per-variant trend squares, run button, edit/runs footer links). Collision
resolution: home hero → `▶ run all cases`, sidebar gains `/suites`.
Options 2 (home row + drawer) and 3 (playlist strip, absorbs plans) rejected —
plans keep their own identity; T5 stands as written.
`suites/009-suites/`: 3 REAL-token options (e.g. option-1 sidebar list +
detail board; option-2 suites row on home + modal detail; option-3 suites
as first-class tab replacing plans strip). Each shows: suite list, member
rows with variant-subset chips, rollup summary, run button, and what the
HOME page's button says now (collision resolution). NEW FILE per option;
no trimming to "just the diff". **Pick → then T6/T7 UI build 1:1.**

### T1 — Schema (receipt 1) — ✅ SHIPPED `27e0365`
CREATE block: `suites(id, name UNIQUE, description, created_by, created_at,
updated_at)` + `suite_members(suite_id, template_id, variant_ids_json,
position, UNIQUE(suite_id, template_id))`. Guarded ALTERs: `runs ADD
COLUMN suite_id`, `plans ADD COLUMN suite_id` — columns added to BOTH the
CREATE statements and the ALTER loop (phase C dead-DDL lesson). Index
`idx_runs_suite(suite_id, started_at DESC)`. Tests: fresh-DB + existing-DB
migration (column present both paths), CASCADE/SET NULL behavior.

### T2 — Suites CRUD + membership (`routes/suites.ts`) — ✅ SHIPPED `5f5e323`
`GET /api/suites` (list + member counts + rollup from D3 map),
`GET /api/suites/:id` (members with verdicts), `POST`, `PATCH`
(name/description/members replace), `DELETE`. Name UNIQUE → 409 (existing
shape). Membership validation: template exists (400); variant ids ⊆ case's
`variants_json` ids — stale id → 400 naming case+variant (same honesty
class as expansion-time scenario errors); plain case with a subset → 400;
empty subset array → 400 ("omit for all"). Tests: CRUD round-trip, 409
dup name, all four validation 400s, member order = position.

### T3 — runBatch `cases` param + suite play route (receipts 3, 8) — ✅ SHIPPED `5f5e323`
`runBatch` accepts `cases`; expansion: plain member → 1 entry; variants
member NULL-subset → all variants (existing flatMap); subset → pinned
entries only. `POST /api/suites/:id/play` → resolve members → `runBatch`
with `suiteId` + `triggeredBy: 'suite:<name>'`; empty suite → 400
"suite has no members". Suite play body passes `{udid?, scenarioId?, env?}`
through unchanged (variant scenario precedence preserved). Tests: subset
expansion COUNT (3-variant case, subset of 2 → exactly 2 runs), all-variant
member, plain member stays plain (variant_id NULL), suite_id on every run,
halt reason names case+variant (phase C shape), DEVICE_BUSY payload reuse.

### T4 — Playback `suiteId` opt (receipt 4) — ✅ SHIPPED `5f5e323` + `18ab5e6` (staging fix)
opts.suiteId → INSERT column (playback.ts:337 site); runs payload carries
`suiteId` + suite NAME resolved at read time (join on the runs route, no
denormalization). Tests: stamped when present, NULL for non-suite runs.

### T5 — plans-reference-suites (receipts 2, 8) — ✅ SHIPPED `5f5e323`
`plans.suite_id` in planRow payload + create/update validation
(exactly-one-of tags|suite → 400 both-set and neither-set). Plan run:
suite branch resolves members → D2 param (suite wins; tags ignored by
construction since validation forbade both). Deleted suite → 400 honest at
run. Tests: validation 400s, plan-with-suite runs the members, 400 on
deleted suite.

### T6 — Per-variant verdict partition (receipt 6) — UI sketch-gated — ✅ SHIPPED `d9bbea4` + `f3fb411` (010-1 sidebar+board; per-variant chips in editor + board)
`suiteVerdicts` variant partition (NULL = plain); case payload gains
`variants: […]`; case table renders per-variant trend inside the case row
(cell list, not one column per variant — 12-variant cases must not break
layout; exact shape from the picked sketch). Tests: mixed plain+variant
history partitions correctly; variantless case has no `variants` array.

### T7 — `?variant=` runs filter + chip click-through (receipt 5) — ✅ SHIPPED `5f5e323` (server `?suite=`/`?variant=`) + `d9bbea4` (RunsPage deep-link)
Route: `variant_id = ?` param; RunsPage chip links `?variant=<id>`.
Exact-id only; filtering plain runs (`variant_id IS NULL`) is OUT (cheap
later, needs a reserved token decision). Tests: filter matches only that
variant's runs; absent param unchanged.

### T8 — Docs + DEFERRED + gates — ✅ SHIPPED `fc3bbef` (guide section) · **phase D COMPLETE 2026-09-20**, live play drill verified (stamped runs, board verdicts, deep-link)
Guide: suites section (create → pin variants → run → read rollup; plan
pinning), variants paragraph gains subset mention. DEFERRED: strike the
Phase D lines from §G/§H, note what's still carried (per-flow variants,
publish act, unknown-top-key strictness). Docs = SEPARATE commit.

## Explicitly OUT (Phase D)

TestSuiteVersion (brief forbids), per-suite env/scenario overrides (play
body covers it), scheduled/triggered suite runs, suite-of-suites,
per-flow variant lists (parent OUT), `?variant=` reserved-token plain
filter, renaming the home page/route (collision resolved by WORDING in
sketches, not churn), evidence retention changes (phase A decision stands).

## Edge cases (walked)

| # | Case | Behavior |
|---|---|---|
| 1 | Case deleted while in suites | CASCADE removes membership; suite detail shows the rest; runs keep template_id (existing SET NULL there) |
| 2 | Suite deleted with historical runs | runs.suite_id SET NULL; run row renders `suite: <deleted>` honestly |
| 3 | Variant renamed in case YAML after suite pinned it | play-time re-validation → 400 naming case+variant (membership saved, run honest) |
| 4 | Same case in two suites | two memberships; verdicts identical everywhere (D3 one truth) |
| 5 | Subset pins a variant whose scenario was deleted | phase C edge 2 semantics carry: snapshot records CHOICE, activation best-effort, run proceeds |
| 6 | Suite play while play-all running | device-busy 409 existing shape (pool owns it) |
| 7 | 12-variant case, subset of 11 | 11 lane entries; ×N cost estimate; no cap (parse-time max stands) |
| 8 | Plan has suite_id AND tags (hand-edited DB) | run takes the suite branch; log warn (validation is the guard, runtime degrades honest) |
| 9 | Membership list reordered | position drives order; expansion order deterministic (D7) |
| 10 | Suite with one plain case | 1 run, variant_id NULL, suite_id stamped — a suite is not a variants-only feature |

## Gates

Per task: `pnpm typecheck && pnpm lint && CI=true pnpm vitest run
--maxWorkers=2` (full suite stays green — the backward-compat receipt).
Web tasks add `vue-tsc && vite build`. UI tasks additionally cite the
picked sketch file in the commit body (1:1 verbatim rule).

---

## Self-review (findings folded back)

1. **(a) assertions sharpened:** T3's subset test now asserts the EXACT
   run count AND `variant_id` set membership (a "not all 3" assertion
   passes even if expansion is wrong — phase C self-review lesson applied
   to itself). T6's partition test seeds a case with interleaved
   plain+variant runs and asserts each partition's trend separately.
2. **(b) both ends of every link:** `suite_id` written (T4 INSERT) ↔
   carried by runs payload (T4) ↔ rendered (sketch-gated UI);
   `suite_members` written+validated (T2) ↔ resolved (T3) ↔ rendered
   (T6); `plans.suite_id` accepted (T5) ↔ resolved at run (T5) ↔ planRow
   payload (T5). `?variant=` param (T7) ↔ chip href (T7).
3. **(c) receipts re-verified this session:** facts 1-9 read from live
   DB/files TODAY (PRAGMA, sqlite_master, manual.ts:538-646, playback.ts:
   337, runs.ts:74-79, db/suite.ts:32, SuiteHomePage.vue:41).
4. **(d) schema contract:** new tables CREATE-block only; new COLUMNS in
   both CREATE and ALTER loops (phase C dead-DDL fix generalized);
   FK actions tested, not assumed.
5. **(e) determinism:** declaration order everywhere (D7); no wall-clock
   asserts; cost stays estimate-only.
6. **(f) scope discipline:** UI strictly post-pick (D6); OUT list keeps
   publish act, per-flow variants, retention OUT; no home-page churn.
7. **(g) vocabulary risk surfaced, not buried:** the `/` page already
   says "suite"; T0 must resolve wording BEFORE any suite UI ships —
   flagged as the phase's one product decision for the user gate.
8. **(h) honesty audit:** every 400 names case+variant/suite; deleted
   dependencies render honestly (edges 2, 3, 8); computed status never
   stored (D3).
9. **(i) sequencing:** T3 changes runBatch + suite route together — one
   commit, both test files; T4 before T6/T7 UI reads suite names.
10. **(j) plan-run dual-source risk:** validation forbids tags+suite at
    write time; runtime trusts suite branch and warns on hand-edited
    rows rather than guessing (edge 8).
