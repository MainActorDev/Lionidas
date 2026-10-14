# Review — Recipe Onboarding Gate Implementation Plan

- Plan reviewed: `plans/20261015T021000Z-recipe-onboarding-plan.md` (status READY), plus its superseded outline and the in-session decision log
- Evidence sources: `server/src/projects/{routes,builds,discovery,manifest,workspace,store}.ts`, `server/src/db/schema.ts` (migration mechanics, M3 guarded-ALTER pattern), `server/src/routes/status.ts` (canary), `server/src/agent/identifier-flow.ts` + `worktree.ts` (overlay/pathspec guards), web `router.ts`/ProjectsPage, butler v0.6.2 seams (PR MainActorDev/butler#4), live DB state (projects, builds #21–23 logs)
- Review date: 2026-10-15
- Verdict: **Needs revision** — 1 Critical, 3 High; all correctable in the plan text. No operator decisions outstanding (D1–D5 are locked); the blocked items are internal consistency fixes, not new questions.

## Coverage / traceability

All five locked decisions (D1–D5) trace to plan sections: D1→data model, D2→S1 fixtures + live tests, D3→S2.4/S4.2 + verdict enforcement, D4→S4 (no scheduler), D5→Rollout. The five principles from the outline appear as constraints in the architecture (resolution order, secrets blocker, oracle rule). Success criteria are measurable and repeated in acceptance. What this review checked on paper: data-model consistency, migration mechanics against the actual `schema.ts` pattern, engine seam fit, API/RBAC consistency with existing routes. What only execution can prove: detector accuracy on real repos, verify timings, the consumer first-verify outcome (green vs honest blocker) — the plan already gates on those live.

## Findings

### R1 — CRITICAL: SQLite cannot DROP the migrated columns; the plan says "drop"

- Location: Data model, migration M-next: "drop the columns after both rows exist"
- Evidence: SQLite `ALTER TABLE … DROP COLUMN` exists but fails when the column is referenced by any index/trigger/view, and this codebase's migration style is guarded `ALTER TABLE … ADD COLUMN` only (`schema.ts` M3 loop, lines 234–335). No DROP appears anywhere in `schema.ts`.
- Consequence: the step as written either fails at migration time or forces a table rebuild (risky) — and dropping breaks every existing reader of `projects.build_scheme` (`builds.ts:147` `regScheme`, the projects PUT route, the web Projects page) until they are all rewired in the same instant.
- Correction: keep the columns, mark them deprecated in code comments, make `recipes` the single source of truth at the READ layer (engine reads recipes only). Optionally backfill recipes FROM the columns on first read (lazy migration) instead of a one-shot import. Remove "drop" from the plan.
- Verify fix: plan text names the columns as deprecated-not-dropped; engine resolution test proves recipes wins over stale column values.

### R2 — HIGH: prepare-script move (S2.4) breaks the intl build before the store is proven

- Location: S2 step 4: "prepare-sim.sh — MOVED from the target repo"
- Evidence: intl's green builds (#21–23, and the 308s compile-gate drill) ran `.lionidas/scripts/prepare-sim.sh` from the target repo, referenced by `.lionidas/lionidas.yml` (`prepare: - run: .lionidas/scripts/prepare-sim.sh`). The identifier flow's worktree overlay ALSO depends on that file (`worktree.ts` overlay carry). The plan moves the script while the identifier flow still uses the overlay path until "one full drill proves store-recipe worktrees" (Rollout).
- Consequence: two sources of truth during the transition window; an edit to the moved script does not reach the overlay copy, and vice versa — the exact drift that burned six days in October.
- Correction: COPY, don't move, during S2 — `server/recipes/ios-consumer-intl/prepare-sim.sh` is the canonical copy the store recipe points at; the in-repo `.lionidas/` stays untouched for the overlay/identifier flow until the Rollout drill retires it. Delete the repo copy only in the Rollout stage, after the drill.
- Verify fix: S2.4 text says "copy (canonical) — repo copy retired in Rollout after the identifier-flow drill"; Rollout already contains that drill — reference it explicitly.

### R3 — HIGH: registration gate fires on a route that doesn't exist yet / wrong hook

- Location: S3 step 1: "Clone/registration flow calls detectRecipe post-clone"
- Evidence: `POST /api/projects` (`routes.ts:52`) only creates the row; cloning is a separate explicit call `POST /api/projects/:id/clone` (`routes.ts:115`). There is no "registration flow" that clones. Also `detectRecipe` on the main workspace cannot see worktree-only realities — fine — but it MUST run on the cloned workspace, and the clone route is the only hook.
- Consequence: as written, an implementer could hang detection off project-create (workspace absent → everything reports `NOT_CLONED`) — the gate never actually gates.
- Correction: detection runs (a) at the end of the clone route when the clone succeeds, and (b) on demand via `POST /api/projects/:id/recipe/detect` (re-run; also serves existing projects). Persist report on the project row. NOT_CLONED remains a valid state for the create-only case.
- Verify fix: S3.1 names both hook points explicitly.

### R4 — HIGH: canary "recipe used" signal is asserted but not wired — `resolution` JSON must gain a store marker

- Location: S3 step 3 ("last-build-used-recipe") and acceptance ("status canary shows manifest/source per project")
- Evidence: the existing FALLBACK_LIED check reads `builds.resolution` (`{"scheme":"manifest"|"registry"|"discovered", ...}` — `builds.ts:164`). Recipes-as-data introduces a fourth source ('recipes') that the resolution JSON never records, and `readBuildManifest` checks root + `.lionidas/` (`manifest.ts` post-fix) but not the store.
- Consequence: after migration, a store-recipe build records `scheme: "manifest"` (if the engine injects it) or `"discovered"` (if not) — the canary can't distinguish store-recipe green from discovery green; FALLBACK_LIED semantics silently rot.
- Correction: S2.3 must specify the resolution contract: `{scheme: 'recipes', recipeId, revision}` recorded on every store-driven build row; canary treats 'recipes' as used-recipe. Add a resolution-contract test.
- Verify fix: S2.3 text includes the resolution JSON shape; S3.3 canary reads it.

### R5 — MEDIUM: `derive` route auth says admin; Projects-page verify/derive buttons imply operator visibility mismatch

- Location: S3.2 (derive = admin) and S4 (verify = admin) vs existing `/api/builds` RBAC ("builds READ is overview-class (viewer ok); TRIGGER stays gated" — `routes.ts:190`)
- Evidence: project routes are all `requireRole('admin')` today; builds trigger is admin. The plan's choice is consistent with the codebase, but the Projects page is admin-facing today too — no mismatch in fact. Downgraded after check: keep admin, but say so in the plan explicitly so the UI doesn't grow viewer-visible buttons pointing at admin routes.
- Correction: one line in S3.4: buttons render only for admin-role sessions (page already admin-gated — assert in the web test).

### R6 — MEDIUM: fixture "tuist/spm-app" archetypes promise more than detection can honestly claim

- Location: S1.2 fixture matrix
- Evidence: detection for Tuist/SPM-app is pattern-presence + `xcodebuild -list`; an ungenerated Tuist repo lists nothing (no project), and the plan's own edge list treats list-failure as NEEDS_GENERATION. Fixtures "derived from real repo shapes" (D2) — but we have NO real Tuist/SPM-app repo to derive from; inventing them contradicts D2's letter.
- Consequence: fixtures that never ran a real build certify nothing; the detector could "pass" tests on invented shapes.
- Correction: fixtures limited to archetypes we possess (committed-project/pods from consumer, xcodegen from intl, workspace, fastlane-lane from intl's lane detection). Tuist/SPM-app enter as BLOCKED-with-evidence cases in the detector (pattern found + project ungeneratable ⇒ NEEDS_GENERATION + AI-proposal trigger), not as green fixtures. D2 is honored: nothing invented.
- Verify fix: S1.2 matrix revised; a test asserts Tuist-shaped input (Project.swift, no project) reports blocked NEEDS_GENERATION.

### R7 — LOW: verify-build concurrency — "reuses the builds queue running map" is asserted, not designed

- Location: S4.1
- Evidence: `builds.ts` `running` map is module-private; a verify route in `routes.ts` cannot "reuse" it without an export or placing verify inside builds.ts. Trivial but unstated.
- Correction: implement `startVerify(db, projectId)` inside `builds.ts` (shares the map and the serial-per-project lock); route calls it. Mirror of `startBuild`.
- Verify fix: S4.1 names the function and its home module.

### R8 — LOW: recipes table missing `verify` columns the plan later writes

- Location: Data model vs S4 ("verdict + verified_at on the recipe revision")
- Evidence: the CREATE TABLE lists no `verify_state`/`verified_at`/`verify_log`.
- Consequence: S4 invents columns mid-implementation (schema drift — the session's own law).
- Correction: add `verify_state TEXT` ('unverified'|'green'|'failed'), `verified_at INTEGER`, `verify_log TEXT` to the CREATE TABLE in the plan.
- Verify fix: data model lists them; migration test creates and reads them.

## Questions for the human

None blocking. One optional preference (answer only if you care): R2's transition leaves the intl `.lionidas/` copy in the target repo until Rollout — if you'd rather force-retire it earlier, the identifier flow drill must move to the front of S2. Default per plan: copy now, retire after drill.

## Necessary edits to the plan

1. R1: replace "drop the columns" with deprecate-at-read + lazy backfill
2. R2: S2.4 copy-not-move; retire in Rollout after the identifier-flow drill
3. R3: S3.1 detection hooks = clone route success + on-demand detect route
4. R4: S2.3 resolution contract `{scheme:'recipes', recipeId, revision}` + canary reads it
5. R5: S3.4 admin-gating note for the buttons
6. R6: fixture matrix trimmed to possessed archetypes; Tuist/SPM = blocked-with-evidence cases
7. R7: `startVerify` in builds.ts sharing the serial lock
8. R8: verify columns in the CREATE TABLE

## What remains to validate during implementation

Detector accuracy on the two live repos; the first consumer verify (green or honest blocker — either is acceptance); store-vs-root-manifest precedence in a real build; the identifier-flow drill on store recipes before retiring the overlay; migration on a copy of the production DB (never the live file first).
