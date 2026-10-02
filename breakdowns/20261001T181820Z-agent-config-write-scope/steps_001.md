# Step 1 — Read tools: suites/scenarios/presets + folder trees by kind

- **Status:** Ready
- **Plan:** `plans/20261001T181820Z-agent-config-write-scope-plan.md` rev 2 (Ready), Stage S1, conditions 1; review F3 (read shapes), F6 (folder kinds)
- **Repo:** `feat/butler-integration` @ `5895c22`
- **Depends on:** nothing (first step)

## Outcome

Six read tools registered and MCP-visible: `suites.list`, `suites.get`, `scenarios.list`, `scenarios.get`, `presets.list`, and `folders.tree` extended with `kind`. Out of scope: any write tool (Step 2+).

## Implementation

New module `server/src/agent/config-tools.ts` (this step: reads only), exported `registerConfigTools(deps: ConfigToolDeps)` where `ConfigToolDeps = { db, registry }`. Called from `buildToolRegistry` (`tools.ts`) after `registerDraftTools` — same flow, context.ts untouched this step.

### tools (grounded shapes)

```ts
// suites.list — SELECT * FROM suites ORDER BY updated_at DESC + members
// (suite_members ORDER BY position, joined to templates for names).
// NO verdict/playState rollups — description says: "structure only, no play verdicts"
// (review F3: don't half-copy tplMap/suiteOut/playState; those are module-private in
// routes/suites.ts and stay there).
registry.register({
  name: 'suites.list',
  description: 'list suites with their members (case ids+names). Structure only — no play verdicts.',
  permission: 'read',
  parameters: { type: 'object', properties: {} },
  async execute() { /* rows + members, JSON.stringify */ },
});

// suites.get — one suite by id or name + members with variantIds.
// scenarios.list — SELECT * FROM scenarios ORDER BY rowid DESC; optional folderId
//   (direct children only — cPanel semantics, forge/routes.ts:218-227).
// scenarios.get — F3 REQUIRED SHAPE: { scenario: row, members: [...] } where members
//   is the route's join (forge/routes.ts:366-377):
//   SELECT so.preset_id, so.enabled, p.method, p.path_pattern, p.status
//   FROM scenario_overrides so JOIN presets p ON p.id = so.preset_id
//   WHERE so.scenario_id = ? ORDER BY p.created_at DESC
// presets.list — SELECT * FROM presets ORDER BY created_at DESC; optional folderId
//   with the same direct-children rule (forge/routes.ts:69-91). Include: id, name,
//   method, path_pattern, match, status, folder_id — omit body_path internals.
```

### folders.tree kind param (F6)

Extend the existing tool in `tools.ts`. Behavior matrix:

| kind (default `cases`) | table | scoping | counts |
|---|---|---|---|
| `cases` | `folders` | app-scoped (unchanged today) | templates per folder |
| `scenarios` | `scenario_folders` | GLOBAL single-root (`parent_id IS NULL` root) | scenarios per folder |
| `presets` | `preset_folders` | GLOBAL single-root | presets per folder |

Description must state: "kind=scenarios|presets trees are global (no app scoping)". Reuse the recursive `attach` builder already in `folders.tree`, parameterized by table+count subquery.

## Verification (TDD)

`server/test/agent-config-tools.test.ts` — seeded buildApp harness (pattern: `agent-draft-tools.test.ts`): suite with 2 members; scenario with 2 override members; preset in a preset folder; folders in both global trees.

- `suites.list/get` return members with template names; no verdict keys present.
- `scenarios.get` members array matches the route join shape (probe `/api/forge/scenarios/:id` in the same test for parity on identical seed).
- `folders.tree {kind:'scenarios'}` returns the global tree with counts; `kind:'cases'` unchanged (existing test must keep passing).
- Negative: unknown kind → honest error string; empty DB → `[]`, not error.

```bash
cd server && pnpm vitest run test/agent-config-tools.test.ts test/agent-tools.test.ts
npx tsc --noEmit -p tsconfig.json
```

## Completion gate

- [ ] 6 tools + kind param registered; MCP tools/list shows them with REAL schemas (schemas flow automatically from the step-6 fix — no envelope)
- [ ] scenarios.get parity with route output on identical seed (F3)
- [ ] folder kinds correct per matrix (F6); existing folders.tree test green
- [ ] full `pnpm vitest run` green; commit pushed
