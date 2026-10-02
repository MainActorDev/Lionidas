# Step 3 — Scenario + preset write tools (name guard, immutable guard, proxy sync)

- **Status:** Ready
- **Plan:** rev 2, Stage S3, conditions 3, 4; review F1 (silent mutation), F2 (syncPresets)
- **Repo:** Step 2 head
- **Depends on:** Step 2 (config-tools.ts write patterns established)

## Outcome

`scenario.draft.save`, `scenario.draft.edit`, `scenario.members.set`, `preset.draft.save`, `preset.draft.edit`. Out of scope: scenario activate (act-class), deletes, route-level bug fixes (observations #1/#2 recorded in the plan, NOT fixed here).

## Implementation

### scenario.draft.save — mirrors `forge/routes.ts:206-216` PLUS two tool-side guards

```ts
// GUARD A (F1 — the route is dangerous, the tool is not): name pre-check.
// Route: id = 's_' + sha256(name)[:8], INSERT OR IGNORE, then unconditional
// member REPLACE — same-name create silently mutates the existing scenario.
// Tool: SELECT id FROM scenarios WHERE name = ? → if hit:
//   return `INVALID: a scenario named "${name}" already exists` (mirrors the
//   PATCH 409 wording, forge/routes.ts:290).
// THEN mirror the route: deterministic id, INSERT, members
// (INSERT OR REPLACE scenario_overrides × presetIds, enabled=1).
// GUARD B fires in edit; create on a fresh name can't hit immutability.
// presetIds each must exist → route's PUT-members 400 wording:
//   `unknown preset ${pid}` (forge/routes.ts:391).
```

### scenario.draft.edit — mirrors PATCH (`forge/routes.ts:281-304`) + immutable guard FIRST

```ts
// GUARD B (immutable_since, plan correction): route never enforces the stamp —
// the tool does, BEFORE the name-409 (order matters for honest messages):
//   if (row.immutable_since !== null)
//     return 'INVALID: scenario is immutable (referenced by runs) — duplicate it and edit the copy (scenario.duplicate semantics: POST /api/forge/scenarios/:id/duplicate)';
// Then mirror PATCH: name trim/409-clash wording verbatim, folderId 409
// (`folder "X" not found`), launchArg/description partial, 'nothing to update'
// when no fields provided.
```

### scenario.members.set — mirrors PUT members (`forge/routes.ts:379-402`)

Same immutable guard first; members array `{presetId, enabled?}`; `unknown preset X` 400 verbatim; wholesale replace in one transaction.

### preset.draft.save / preset.draft.edit — mirrors `forge/routes.ts:23-52` / `113-204` + F2 sync

- save: `pathPattern` + `status` required (`pathPattern and status required` verbatim); id = `p_` + sha256(body)[:8]; INSERT OR REPLACE — NOTE: preset ids are content-addressed, same body → same id is a NO-OP overwrite of identical content (safe, unlike scenarios — members don't attach). Document in the description.
- edit: partial-update col list EXACTLY as route PATCH (method/name/folderId+409/pathPattern/match/headers object-check/status/delayMs≥0/throttleKbps≥0/seq non-empty check); `no updatable fields provided` verbatim.
- **F2 (both save & edit):** after write → `syncPresets()` callback + mirror PATCH stamps: `created_by='editor'`, `sha256 = sha256(id|Date.now())` (fresh, like the route).
- `ConfigToolDeps` gains `syncPresets: () => void`; `buildAgentContext` (`context.ts`) accepts and passes it; **`index.ts` wires it**: `buildAgentContext(db.raw, { ..., syncPresets: () => forgeStateService({ db: db.raw, forgeState }).sync() })` — forgeState exists at the mount point (`index.ts:96-97`). Tests inject a spy.

## Verification (TDD)

- F1 regression (the money test): create "pay-err" members [A]; save name "pay-err" members [B] → refusal; row still members [A].
- Immutable: stamp `immutable_since` on a scenario → edit AND members.set refused with the duplicate-pointer message; name-409 never reached (order pinned).
- Preset round-trip: save with seq+headers; edit pathPattern only → seq/headers intact; sync spy fired both times; stamps updated.
- Route parity probe: same seed → `/api/forge/scenarios` list shape equality for the created rows.

```bash
cd server && pnpm vitest run test/agent-config-tools.test.ts && npx tsc --noEmit -p tsconfig.json && pnpm vitest run
```

## Completion gate

- [ ] F1 regression green (silent mutation impossible via agent)
- [ ] immutable guard order pinned; sync spy asserted; stamps mirrored
- [ ] no partial writes; full suite green; commit pushed
