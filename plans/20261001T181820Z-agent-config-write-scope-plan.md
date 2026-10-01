# Agent config-author expansion — plan

- Source: `brainstorm/20261001T181820Z-agent-config-write-scope.md` (2026-10-02)
- Decision log (operator, this session, verbatim): "1. Human only for now" (activation) · "2. agent never deletes" · "okay" (scenario activate = act-class, invisible)
- Status: **Ready (rev 2 — review F1–F6 applied)**
- Baseline: `feat/butler-integration` @ `243ad58` (agent v1 shipped; 1171/1171)

## Objective

Extend the agent tool surface from case-author to config-author: read everything (suites, scenarios, presets, folder trees); create/edit those entities in-process with route-faithful validation and verbatim errors; edit-active-cases via a new draft copy, never in place. Activation, deletion, and device operations stay human — no new permission tier (all inside `draft`).

## Correction to the brainstorm (verified against source)

`scenarios.immutable_since` is stamped on activate (`forge/routes.ts:408`, `COALESCE`) and used only for change-reporting; **no route refuses edits to an immutable scenario** (PATCH body has no check — verified 2026-10-02). Therefore the scenario edit TOOL adds its own guard (refuse verbatim + suggest the existing duplicate route). Fixing the route itself is out of scope; flagged as an observation for a separate decision.

## Completion conditions

1. **Read tools** return real data through the buildApp harness: `suites.list/get`, `scenarios.list/get`, `presets.list/get`; `folders.tree` gains a `kind` param (cases|scenarios|presets; default cases).
2. **Suites**: `suite.draft.save` / `suite.draft.edit` mirror the routes — member validation (templateId exists, pinned variantIds belong to that case's variants vocabulary, max 64), bundle scoping (explicit `appBundleId` or first-member's bundle; mixed packs → the 400 verbatim), name-collision 409 verbatim; `appBundleId is immutable` on edit.
3. **Scenarios**: `scenario.draft.save` / `scenario.draft.edit` (+ members set) mirror the routes; name 409 verbatim; **tool-side immutable guard**: if `immutable_since IS NOT NULL`, refuse verbatim ("scenario is immutable (referenced by runs) — duplicate it and edit the copy") and name the duplicate tool.
4. **Presets**: `preset.draft.save` / `preset.draft.edit` mirror the routes (pathPattern+status required; method/match/headers/delay/seq/failure/throttle/guards optional); sha-stable ids preserved.
5. **Case lifecycle**: `case.draft.edit` now REFUSES when target status ≠ draft (verbatim). New `case.draft.revise`: for an active/deprecated case, copies it (duplicate-route semantics: fresh id, full field copy, status=draft) then applies the yaml edit through the same validator chain — returns the new id. New `case.deprecate`: sets status=deprecated (the only status transition the agent may perform; never sets active).
6. **Act-class unchanged**: `scenarios/:id/activate`, all deletes — NO tools exist for them; `providerTools(V1)` continues to exclude act tools (pinned by existing test).
7. **Prompt + instructions**: system prompt gains a config-author section (what it may edit, the publish/deletion lines, the immutable-duplicate dance); MCP `instructions` carries it (smoke: initialize contains the new section).
8. **Gates + drill**: full server suite green; one live Hermes drill logged in `docs/agent-drills.md` (e.g. "add the LP-1042 draft + a scenario for payment-error and a suite containing both") with template/suite/scenario ids.

## Route-level observations (recorded, NOT fixed here — separate decisions)

1. `scenarios.immutable_since` is stamped but no route enforces it (activate stamps; PATCH/PUT-members never check).
2. `POST /api/forge/scenarios` same-name create silently mutates the existing scenario's members (deterministic id + INSERT OR IGNORE + unconditional member REPLACE).

## Out of scope

- Any delete tool; any activation (cases, suites, scenarios); device ops; live Jira.
- Route-level enforcement of `immutable_since` (observation recorded; separate decision).
- Web UI for agent turns (`agent.turn` events only).

## Interfaces

- New module `server/src/agent/config-tools.ts` (suite/scenario/preset + revise/deprecate), registered in `buildToolRegistry`'s flow (context.ts unchanged — registry assembly calls it).
- `buildAgentContext` gains an optional `syncPresets?: () => void` (from `index.ts`'s forge wiring); preset tools require it (context construction passes it; tests inject a spy).
- All tools: `permission: 'draft'`, JSON schemas in the registry (real schemas already flow to MCP via the step-6 fix), errors prefixed `INVALID:`/verbatim route strings, nothing half-written on failure (transactions where the routes use them).
- In-process mirroring ONLY (no HTTP self-calls) — established pattern.

## Stages

- **S1 Read tools** (`suites.list/get`, `scenarios.list/get`, `presets.list/get`, `folders.tree` kind param) + tests against seeded buildApp DB. → condition 1
  - **F3 shapes:** `scenarios.get` includes members joined to presets (method/path_pattern/status) — the route's shape; suite/scenario/preset reads OMIT play-verdict rollups (tool descriptions say so). Folder filtering = direct children (cPanel semantics).
  - **F6 folder kinds:** kind=cases → app-scoped tree with case counts (today's behavior); kind=scenarios|presets → GLOBAL single-root trees with entity counts; descriptions name the scoping so the agent never asks for `app:` on a global tree.
- **S2 Suites write** + tests (mixed-bundle 400, variant-pin 400, name 409, immutable appBundleId). → 2
  - **F4:** mirror the route's transaction-catch EXACTLY (same tx scope, any failure → verbatim `suite name already exists`) — no pre-check that races differently; test asserts members count unchanged on failure.
- **S3 Scenarios + presets write** + tool-side immutable guard + tests (409 name, immutable refusal, preset round-trip incl. seq/headers). → 3, 4
  - **F1 guard (route bug worked around tool-side):** scenario create derives id from name and INSERT OR IGNOREs, then REPLACEs members onto that id — same-name create silently mutates the existing scenario. `scenario.draft.save` pre-checks the name and refuses verbatim: `a scenario named "X" already exists`. Route bug recorded as observation #2 (fixing routes is out of scope).
  - **F2 sync:** preset save/edit call a `syncPresets()` callback (wired from `index.ts` where `forgeState` lives; `buildAgentContext` accepts it) and mirror PATCH's `created_by='editor'` + fresh `sha256` stamps. Test: sync spy fires.
- **S4 Case lifecycle**: edit-guard + `case.draft.revise` + `case.deprecate` + tests (active edit refused, revise lands draft through validator, deprecate transition). → 5, 6
  - **F5 name flow:** revise = duplicate-route copy (`(copy)` collision-loop name) THEN the yaml edit validates+applies with the user's `name`; if the yaml omits `name`, the `(copy)` name stands — pinned by test.
- **S5 Prompt/instructions + suite + drill + docs** (`docs/agent.md` tool table update). → 7, 8

Each stage: TDD (tests fail → implement → green), commit per stage, full suite before push. Ordering is dependency-linear (S4's revise reuses S1's none; S3 guard needs nothing from S2 — S2/S3 parallelizable but sequenced for review clarity).

## Edge and failure cases (pinned)

- Mixed-bundle suite members: first-member scope resolution must match the route EXACTLY (scope derived BEFORE validation) or the 400 text lies.
- Scenario rename colliding while immutable: immutable guard fires FIRST (before name 409) — order matters for honest messages.
- Preset edit changing `pathPattern` alone must not clobber seq/headers (partial-update semantics per route PATCH).
- Revise on a case whose `runFlow` refs now dangle: validator decides at save (existing behavior, no special-casing).
- Deprecate on an already-deprecated case: idempotent ok (route PATCH allows same-status set).
- Empty-name / whitespace guards on every save/edit (route 400s verbatim).

## Validation

- Per-stage vitest files (`agent-config-tools.test.ts`, extended `agent-draft-tools.test.ts` for revise/deprecate).
- Negative checks: act-class invisibility re-pinned; no `*.delete` tool names exist in the registry at all.
- Live drill through Hermes MCP after S5, logged with ids and the surviving trace.
- Repo gates: server suite + web build + cli suite (F5 skip pattern intact for butler-dependent files).

## Rollout

Branch: continue on `feat/butler-integration` (same PR #14 stream) or a follow-up branch off it — operator choice at execution; commits pushed per stage; PR already open, human merges.
