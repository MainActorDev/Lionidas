# Step 3 — Draft + act-registered tools (TDD)

- **Status:** Ready
- **Plan:** rev 2, Stage 2; completion condition 3 (and finishes 2)
- **Review:** F4 carried — folder/app-scope and name-collision 409s surface VERBATIM
- **Depends on:** Step 2 (registry, policy, storage)

## Outcome and boundaries

`case.draft.save` validates through the REAL validator and creates a REAL `status='draft'` template; `case.draft.edit`, `note.save`, `sources.ingest` land; the three act tools register and REFUSE under V1_POLICY. Out of scope: mounting anything (Step 4).

## Implementation instructions

### 3a. The ground-truth path (in-process, no HTTP self-call)
The PUT route at `templates.ts:874` does: `parseCaseYaml(yaml, {hasLoginRecipe, hasLogoutRecipe})` → `resolveCaseRefs(db, case, row.app_bundle_id)` → 422/409 → UPDATE. For the tool, replicate the CALLS, not the route:
```ts
import { parseCaseYaml } from '@crucible/shared/case-yaml';
import { resolveCaseRefs } from '../routes/templates.ts'; // export it if module-private (one-word diff, same pattern as renderTemplateYaml)
```
`hasLoginRecipe/hasLogoutRecipe(bundle)` — read from `app_login`/`app_logout` tables (same lookups the route uses).

### 3b. `case.draft.save` (draft-class)
Input schema: `{ yaml: string }`. Flow:
1. `parseCaseYaml(yaml, hooks)` → on failure return `INVALID: <errors with line numbers>` **verbatim** as the tool result (the loop does one repair round — Butler-proven).
2. `resolveCaseRefs` → conflict → return the 409 message verbatim.
3. Name-taken check (`SELECT id FROM templates WHERE name=?`) → return the collision message verbatim (F4).
4. INSERT with `status='draft'` — reuse the duplicate route's INSERT shape (templates.ts:396-413 pattern: fresh `tpl_` id, `steps_json` from parsed case, folder resolve-or-create from `case.folder` when `case.app` set — import-sweep parity, see templates.ts:445-470).
5. Return `JSON { templateId, status: 'draft', name }`.
No shadow store (I5/F1-carry).

### 3c. `case.draft.edit` (draft-class)
Input `{ idOrName, yaml }`: resolve → run the same validate+refs against the EXISTING row's app → on success `UPDATE templates SET name/steps_json/…` mirroring the PUT route's UPDATE (templates.ts:887-895). App/folder scope 409s verbatim (F4).

### 3d. `note.save` (draft-class)
Input `{ scopeKey, kind, content, sourceRef }` — butler's `insertNote` enforces provenance (blank sourceRef rejected); scope keys documented: `app:<bundle>/screen:<id>`, `app:<bundle>/flow:<name>`.

### 3e. `sources.ingest` (draft-class)
Input `{ sourceId? , kind: 'file'|'repo', root? }`: build `fileConnector`/`repoConnector` (butler exports both) → `ingest(conn, storage, { artifactsDir: <CRUCIBLE_ARTIFACTS_DIR> })` → register returned chunks into the shared `StorageRetriever` → return the document summary JSON.

### 3f. Act tools — registered, refused
`case.play` (input `{ idOrName, udid? }` — handler intentionally unreachable under V1), `run.abort` `{ runId }`, `device.power` `{ udid, action }` — all `permission: 'act'`, bodies throwing `new Error('unreachable under v1 policy')` defensively.

### 3g. Tests (`server/test/agent-draft-tools.test.ts`)
- valid yaml → save → row exists `status='draft'`; renders in list; GET-by-id returns steps.
- invalid yaml (bad step kind) → tool result contains the validator line-numbered errors; NO template row created (assert count unchanged).
- name collision → verbatim message; app-scope change while foldered → verbatim 409 text (seed folder + case first).
- `case.play` under V1_POLICY → `PolicyRefusal` with `permission: 'act'` and tool name; registry listing for the PROVIDER excludes act tools (`providerTools`-equivalent filter — butler's `providerTools(V1_POLICY)`).
- `note.save` blank sourceRef → rejection message.

## Verification

```bash
cd server && pnpm vitest run test/agent-draft-tools.test.ts test/agent-tools.test.ts
pnpm typecheck && pnpm vitest run   # full suite
```
Failure path check: temporarily flip a case's app while foldered → 409 text appears in the tool result (test does this).

## Completion gate

- [ ] validator errors (422 + line numbers), ref conflicts, name/app/folder 409s all surface verbatim in tool results
- [ ] drafts are REAL templates (query `status='draft'`); no shadow table anywhere
- [ ] act tools refused + provider-invisible under V1_POLICY
- [ ] full suite green
