# Review — Agent config-author expansion plan

- Plan reviewed: `plans/20261001T181820Z-agent-config-write-scope-plan.md` (Ready, 2026-10-02, commit `6521420`)
- Evidence: plan + brainstorm `20261001T181820Z-agent-config-write-scope.md` + operator decisions (verbatim in plan); route sources read 2026-10-02: `server/src/routes/suites.ts` (create 125–161, patch 163–191), `server/src/forge/routes.ts` (presets 23–204, scenarios 206–422), `server/src/routes/templates.ts` (patch 505–530, duplicate 395–420), `server/src/forge/state.ts` (forgeStateService), live DB probed (scenarios table).
- **Verdict: Ready for implementation (rev 2)** — F1–F6 all applied to the plan (commit `abec1e1`): F1 name pre-check + observation #2; F2 syncPresets wiring + stamp mirroring; F3 read shapes; F4 tx-catch mirroring; F5 revise name-flow pinned; F6 folder-kind semantics. Original findings retained below for traceability.
- *(Original verdict, superseded: Needs revision — one High (F1), one Medium (F2).)*

## Traceability

Operator decisions → plan: activation human-only → condition 5+6 ✓; no deletes → condition 6 + "no `*.delete` tool names" negative check ✓; activate = act-class → condition 6 ✓. Brainstorm Option B → stages S1–S5 ✓. The plan's `immutable_since` correction verified true (stamp at `forge/routes.ts:408`, no PATCH check).

## Findings

### F1 — HIGH — Scenario name-reuse silently MUTATES an existing scenario (plan S3 misses it)

- Evidence: `POST /api/forge/scenarios` derives the id deterministically from the name (`s_` + sha256(name)[:8] — verified live: `countries-sg` → `s_c1265727` matches), uses `INSERT OR IGNORE` (no-ops on existing name), then **unconditionally `INSERT OR REPLACE`s the preset members onto that id** (`forge/routes.ts:206–216`). No name-collision check exists anywhere in create.
- Consequence: an agent (or human) "creating" `payment-error` when one exists silently rewrites the existing scenario's members. Violates the house invariant (nothing silent) and the plan's own edge-case section, which pins name 409s for scenarios via *PATCH* only.
- Correction: `scenario.draft.save` pre-checks the name (SELECT by name) and refuses verbatim — mirror PATCH's 409 text: `a scenario named "X" already exists`. Record the route-level bug as a second observation (like `immutable_since`), not silently fixed.
- Verify: test creates scenario "x" with members A, then attempts `scenario.draft.save` name "x" members B → refusal; row still has members A.

### F2 — MEDIUM — Preset tools must sync the live forge proxy or DB/proxy diverge (plan S3 misses it)

- Evidence: preset create AND patch both end with `syncPresetsToMitm()` → `forgeStateService({db, forgeState}).sync()` (`forge/routes.ts:49,65` and end of PATCH — verified present after full read; patch also stamps `created_by='editor'` and a fresh `sha256`). Scenario activation re-reads rows from the DB (self-healing there), but the standalone serving set / addon state file used by intercept-mode matching goes stale until the next sync.
- Consequence: agent edits a preset in-process; DB says one thing, the MITM matcher serves another; manual runs get wrong stubs with no signal.
- Correction: `config-tools.ts` receives a `syncPresets: () => void` from `buildAgentContext` (wired in `index.ts` where `forgeState` exists); every preset save/edit calls it. Mirrors PATCH's `created_by`/`sha256` stamps.
- Verify: unit test asserts the sync callback fires (spy) after `preset.draft.save`/`edit`.

### F3 — MEDIUM — Read tools must mirror route shapes, incl. joins the agent reasons from

- Evidence: `GET /api/forge/scenarios/:id` returns `{scenario, members}` where members join presets (`method, path_pattern, status`); `GET /api/forge/presets` does direct-children folder filtering (cPanel fix comment); suites list embeds per-suite verdict/playState rollups computed by route helpers.
- Correction: `scenarios.get` includes joined members (else the agent drafts scenarios blind to their presets); suite/scenario/preset reads skip the play-verdict rollups (agent doesn't need them — note the omission in the tool descriptions, don't half-copy helpers). Folder list semantics: direct children, like the routes.
- Verify: seeded-DB tests assert members arrays and folder filtering match route output for the same seed.

### F4 — MEDIUM — Suite create collision handling is a tx-catch, not a pre-check

- Evidence: suite create wraps INSERT+members in one transaction and maps ANY tx failure to `409 'suite name already exists'` (`suites.ts:155–156`); PATCH re-validates members against the immutable `app_bundle_id` and also 409s the whole tx on rename clash.
- Correction: tool mirrors exactly — same transaction, same try/catch → verbatim 409 string; don't invent a pre-check that could race differently than the route.
- Verify: duplicate-name suite save → verbatim 409; members not partially written (count unchanged).

### F5 — LOW — `case.draft.revise` = duplicate + edit composition; name flow needs stating

- Evidence: the duplicate route lands `(copy)`/`(copy 2)` names via a collision-loop (`templates.ts:404–410`); revise then applies the yaml through the validator, whose name-collision check runs against the FINAL yaml name.
- Correction: plan S4 states: revise copies first (duplicate semantics), then `case.draft.edit`-style validation applies to the copy with the user's yaml name; the intermediate `(copy)` name is irrelevant unless the yaml omits `name` (then it stays — say so).
- Verify: revise on an active case with yaml name "X v2" → new id, status draft, name "X v2"; revise without `name` key → keeps "(copy)" name (test pins the choice).

### F6 — LOW — `folders.tree` kind param: three different tables, two scoping models

- Evidence: case folders are app-scoped (`folders`); scenario/preset folders are GLOBAL single-root trees (`scenario_folders`, `preset_folders` — header comments in their route files).
- Correction: S1 spells out per-kind behavior (kind=cases keeps app scoping and case counts; kind=scenarios|presets returns the global tree with entity counts), descriptions say which is which so the agent doesn't ask for `app:` on a global tree.
- Verify: per-kind seeded tests.

## Questions for the operator

None blocking. Branch choice (continue `feat/butler-integration` vs follow-up branch) remains an execution-time decision as the plan states.

## Required plan edits for rev 2

1. S3: scenario name pre-check guard + route-bug observation entry (F1).
2. S3: `syncPresets` dependency + PATCH stamp mirroring (F2); `buildAgentContext`/`index.ts` wiring noted in Interfaces.
3. S1/S3: read-shape requirements — scenario members join, direct-children folders, rollup omission (F3).
4. S2: tx-catch → verbatim 409 mirroring (F4).
5. S4: revise name-flow + the no-`name` pin (F5).
6. S1: per-kind folder semantics (F6).

## What remains for implementation to validate

Everything execution-shaped: the route-mirroring claims above were read from source and probed on the live DB, but each guard's verbatim string equality and the MCP-visible schema shapes land in the stage tests + the S5 Hermes drill (which this review did not run).
