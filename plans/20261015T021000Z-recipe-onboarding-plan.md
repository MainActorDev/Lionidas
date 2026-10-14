# Recipe Onboarding Gate — Implementation Plan

- Source: `plans/20261015T021000Z-recipe-onboarding-outline.md` (decisions locked in-session, 2026-10-15)
- Status: READY — all material decisions confirmed by the operator; review gate (`hms-review-detailed-plan`) next
- Branch: `feat/recipe-onboarding` (PR #44) — no direct-to-main work (operator directive, 2026-10-15)

## Decision log (operator-confirmed, verbatim provenance)

| # | Decision | Source |
|---|---|---|
| D1 | Separate `recipes` table (revision rows; migrate `projects.build_scheme`/`build_configuration`) | operator, 2026-10-15: "1. Separate table" |
| D2 | Fixtures from real repo shapes; detector tests also run against both live repos | operator accepted lean: "2. Your lean" |
| D3 | Prepare scripts IN our repo, trust enforced by verify verdict | operator, 2026-10-15: "do that" on the outline's lean; clarified "in" |
| D4 | NO weekly verify scheduler — on-demand only | operator, 2026-10-15: "No need for that" |
| D5 | No direct-to-main changes; branch + PR for everything including butler | operator, 2026-10-15: "Do not make changes directly to the main branch again. Create a new branch. Push everything first and create PR if any including Butler changes." |

## Objective

Registering a project produces an honest build-recipe state in seconds — `found` / `derivable` (generated, flagged) / `blocked` (named blockers with evidence) — never a silent discovery fallback. Recipes live as server-side data (separate table + prepare scripts in the Lionidas repo). A verify-build turns recipe state into a proven verdict. AI handles the long tail (unclassifiable repos, failed verifies) through the existing proposal→confirm seam, never deciding green and never touching secrets.

Measurable completion:
- Register both real repos (intl, consumer) fresh → three-state report < 30s each, zero silent fallbacks (status canary shows manifest/source per project)
- A fixture repo of each archetype classifies correctly (matrix below)
- Verify build on intl → green verdict stamped; consumer → first-ever recipe + verdict
- No code path writes `.lionidas/` into a worktree for recipe-managed projects; pathspec guard retained as legacy safety
- Full suite + tsc green; live drill on `/status` + Projects page

## Scope

IN: slices 1–4 below, `server/src/projects/` + `server/src/routes/status.ts` + Projects web page + `recipes` migration + two live-repo verifications + AI proposal commands.
OUT: Android; `.ipa`/export anywhere (compile-only); weekly scheduler (D4); touching the target repos' own files; EffectWorker; changing butler's transport semantics (v0.6.2 seams are sufficient).

## Architecture

```
registration ──▶ recipe-detect.ts ──▶ three-state report ──▶ Projects UI + /status canary
                     │                        │
             archetype matrix          derivable ⇒ generated recipe (flagged)
                     │                        │
                     ▼                        ▼
              recipes table ◀── AI proposal (slice 4, HARD STOP) ◀── failed verify
                     │
              prepare scripts: server/recipes/<project>/prepare-*.sh  (our repo, D3)
                     │
              build engine + compileWorktree receive the recipe EXPLICITLY
                     │
              verify-build ──▶ verdict + timestamp on the recipe revision
```

### Data model (D1)

```sql
CREATE TABLE recipes (
  id TEXT PRIMARY KEY,             -- rcp_<12>
  project_id TEXT NOT NULL REFERENCES projects(id),
  revision INTEGER NOT NULL,       -- 1..n, monotonic per project
  transport TEXT NOT NULL,         -- 'repo-lane' | 'generic'
  scheme TEXT, configuration TEXT,
  prepare_json TEXT NOT NULL,      -- ordered [{run: string}] — server-side script paths or repo-relative
  generated INTEGER NOT NULL DEFAULT 0,
  provenance_json TEXT NOT NULL,   -- {by: 'user'|'ai+user'|'import', at, evidence: string[], source: string|null}
  superseded_by TEXT REFERENCES recipes(id),  -- revision chain
  verify_state TEXT,                -- 'unverified' | 'green' | 'failed' (review R8)
  verified_at INTEGER,
  verify_log TEXT,
  created_at INTEGER NOT NULL
);
-- ACTIVE recipe per project = highest revision WHERE superseded_by IS NULL
```

Migration M-next: create `recipes`; import intl `.lionidas/lionidas.yml` as revision 1 (`provenance.by: 'import'`); import `projects.build_scheme`/`build_configuration` for consumer → its first recipe (`by: 'user'`, prepare: `pod install`). The projects columns are DEPRECATED, NOT DROPPED (SQLite DROP breaks on referenced columns; the codebase's migration style is guarded ADD COLUMN only) — the engine reads `recipes` exclusively; a lazy one-time backfill converts any lingering column values into recipe rows on first read. (review R1)

### Module: `server/src/projects/recipe-detect.ts`

```
detectRecipe(ws: string): DetectionReport
DetectionReport =
  | { state: 'found',     source: 'root-manifest' | '.lionidas-manifest' | 'repo-lane', recipe: Recipe }
  | { state: 'derivable', recipe: Recipe, generated: true, notes: string[] }
  | { state: 'blocked',   blockers: Blocker[] }
Blocker = { code: 'SCHEME_AMBIGUOUS' | 'NEEDS_GENERATION' | 'PODS_UNINSTALLED' | 'MISSING_XCCONFIG'
                 | 'NEEDS_SECRETS' | 'NO_APP_SCHEME',
            detail: string, evidence: string }  // evidence = file:line or command output ref
```

Archetype patterns (existence checks + one `xcodebuild -list` where warranted — no reasoning):
`*.xcodeproj` committed · `*.xcworkspace` · `Podfile` · `project.yml` (xcodegen) · `Project.swift` (Tuist) · `Package.swift` (SPM-executable app) · `fastlane/Fastfile` with `build_sim` lane · `scripts/build-sim.sh`.

### Recipe resolution order (build engine change)

1. repo-committed `lionidas.yml` at root — **wins** (the repo speaking for itself)
2. active row in `recipes` (server-side data)
3. `.lionidas/lionidas.yml` — LEGACY import source only; after migration, detection reports it as `found(legacy)` with a one-time nag to import
4. discovery — NEVER silent again: reachable only via explicit user action "derive" (which writes a `generated` recipe row); the status canary flags any build that ran on discovery (`FALLBACK_LIED` semantics, already shipped)

### Verify build (slice 3, D4)

`POST /api/projects/:id/verify` → runs `compileWorktree(ws, log)` (existing, no `.ipa`); on settle, writes verdict to the recipe revision (`verified_at`, `verify_log`). Per-project serial lock reuses the builds queue's `running` map. UI: Projects page button + verdict chip; `/status` canary reads `verified_at` — no scheduler (D4); staleness is displayed, never auto-run.

### AI seat (slice 4)

Two entry points, both riding the EXISTING seams (`prepareTurn` provider swap is unnecessary — these are normal tool turns with a read + proposal contract):
- Trigger A (blocked/unclassifiable at registration): chat command `/recipe-propose` — model reads the repo via existing repo tools, emits a proposal table (archetype, scheme, prepare chain, xcconfig/secrets findings — each row `file:line`-cited), HARD STOP; on confirm the host writes a `recipes` row (`provenance.by: 'ai+user'`) — the model never writes the row.
- Trigger B (verify failure): `/recipe-diagnose` — same contract over the verify log; output is a proposed recipe REVISION; confirm → host writes revision → re-verify (manual click; bounded by the human, not a retry loop).
Secrets rule: any proposal naming a credential/xcconfig path it cannot read → blocker `NEEDS_SECRETS`, human supplies; the command instructions state this verbatim.

## Implementation stages (order = dependencies, each ends green)

**S1 — detection (pure function + fixtures)**
1. `recipe-detect.ts` with the archetype matrix; NO route changes yet
2. Fixture repos under `server/test/fixtures/archetypes/` (D2, review R6 — nothing invented): ONLY archetypes we possess — `committed-project` (from consumer shape: pbxproj + Podfile), `xcodegen` (from intl shape: project.yml + .lionidas), `workspace`, `fastlane-lane`. Tuist and SPM-app are NOT green fixtures (no real repo to derive from): they are blocked-with-evidence cases — pattern found (`Project.swift`/`Package.swift`) + no generated project ⇒ `NEEDS_GENERATION` + AI-proposal trigger; a test asserts exactly that report
3. Detector unit tests per fixture + live-repo tests (skipped under VITEST unless repos present — gated on `existsSync('repos/ios-consumer-intl')`)
Deliverable: `detectRecipe()` tested, zero route/UI impact

**S2 — recipes storage + engine resolution**
1. Migration M-next (`recipes` table + imports + column drop)
2. `projects/recipes.ts` store module (get-active, write-revision, list-revisions)
3. Build engine: resolve order (root manifest > recipes row > legacy .lionidas > explicit-derive); `startBuild`/`compileWorktree` take the resolved recipe. RESOLUTION CONTRACT (review R4): every store-driven build records `resolution = {scheme: 'recipes', recipeId, revision}` on its builds row — the canary distinguishes store-green from discovery-green by this marker; add a resolution-contract test
4. `server/recipes/ios-consumer-intl/prepare-sim.sh` — COPIED, not moved (review R2): the store copy is canonical for store-driven builds; the target repo's `.lionidas/` copy stays untouched because the identifier-flow overlay still reads it — deleted only in Rollout, after the store-recipe identifier-flow drill passes. Precedence test: store recipe wins for engine builds; overlay path untouched for legacy
5. Store tests + engine resolution tests (fixture recipes)
Deliverable: recipes as data, engine obeys them, worktree overlay path unused for managed projects

**S3 — registration gate + canary + UI**
1. Detection hooks (review R3): (a) the END of `POST /api/projects/:id/clone` on clone success — the only moment a workspace exists; (b) on demand via `POST /api/projects/:id/recipe/detect` (re-runs; serves projects registered before this change). Report persisted on the project row (`recipe_state`, `recipe_report_json`). Project-create without clone reports NOT_CLONED honestly
2. `POST /api/projects/:id/recipe/derive` (admin) — writes the generated recipe for `derivable` projects (the only discovery path left)
3. `/status` canary: per project — recipe source, generated flag, verified_at, last-build-used-recipe; degraded on MISSING/FALLBACK_LIED/unverified-generated
4. Projects page: state chip (found/derived/generated-unverified/blocked+blockers), "derive recipe" and (S4) verify buttons — all admin-only actions on an already admin-gated page; the web test asserts the buttons render only for admin sessions (review R5)
Deliverable: the honest gate visible end to end

**S4 — verify build**
1. `startVerify(db, projectId)` implemented INSIDE `builds.ts` (review R7 — shares the module-private `running` map and the per-project serial lock; mirror of `startBuild`); route `POST /api/projects/:id/verify` (admin) calls it. Compile-only gate on the project workspace, verdict + `verified_at` on the recipe revision, log persisted
2. UI button + verdict chip; canary upgrade (verified-at / stale display, no auto-run)
3. LIVE: verify intl (expect green, ~5 min) and consumer (first recipe: `pod install` prepare — expect green or honest blocker)
Deliverable: verdicts exist and are enforced as trust (D3)

**S5 — AI commands**
1. `/recipe-propose` and `/recipe-diagnose` command specs (orders 5, 6) — instructions embed the evidence-citation + HARD STOP + secrets-blocker contract; tools narrowed to repo-read set
2. Host-side apply routes: `POST /api/projects/:id/recipe/apply-proposal` (admin) — writes the revision from a confirmed proposal; provenance `ai+user`
3. Command registry + web fallback palette entries
4. Tests: command registration, apply-route auth + revision write, HARD STOP presence in instructions
Deliverable: the long tail is served without new transport seams

## Edge and failure cases

- **Registered but not cloned**: detection returns `blocked {code:'NOT_CLONED'}` — UI shows "clone first"; gate re-runs post-clone
- **Repo-committed manifest conflicts with store recipe**: root manifest wins (resolution order); report says so
- **Generated recipe later fails verify**: stays `generated`, verdict red — slice-4 diagnose proposes a revision; never auto-mutated
- **Prepare script missing on disk (recipe points at our repo file)**: blocker `MISSING_PREPARE`, build refuses, canary degraded — visible, not silent
- **Two recipes revisions racing**: revision chain is append-only; apply-route uses INSERT with next-revision in one txn — last write wins, both rows retained
- **Fixture schema vs production** (session law): detector tests run against live repos when present, so fixture drift can't paper over reality
- **`xcodebuild -list` slow/absent on a machine**: detection treats list-failure as `NEEDS_GENERATION` evidence, not a crash; timeout 120s (existing discovery behavior)

## Validation & acceptance

1. `npx vitest run` (server) — all green, new tests included; `npx tsc --noEmit` clean; web `vitest + vue-tsc` green (Projects page changes)
2. Live drill: re-register-style detection call against BOTH real repos; verify intl; verify consumer (or honest blocker); `/status` shows the upgraded canary
3. The three success criteria from the outline, checked one by one
4. Review: `hms-review-detailed-plan` before implementation; human gate before merge (standing rule)

## Rollout

All on `feat/recipe-onboarding` (PR #44). Slices land as separate commits; PR stays open until S5 + live drills pass; merge is human-only. Butler: no changes needed (v0.6.2 seams already merged via butler PR #4). After merge: retire `ios-consumer-intl/.lionidas/` overlay carry only after one full identifier-flow drill proves store-recipe worktrees (kept as legacy until then).
