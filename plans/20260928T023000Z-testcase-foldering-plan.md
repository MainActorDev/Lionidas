# Plan — test case foldering (cPanel model, app-scoped, multilevel)

- Source brainstorm: `brainstorm/20260928T023000Z-testcase-foldering.md` (rev 2, decisions folded)
- Created: 2026-09-28T03:10:00Z (rev 2 — review F1–F4 folded)
- Status: **Ready**

## Decision log

- **2026-09-28, operator:** folders **app-scoped**; **multilevel** (real directories); **multi-select + bulk move** possible; create/rename, delete refused while non-empty (extended: any descendant non-empty); folder-level run; **navigation not disclosure** (cPanel); impact audit required.
- Design consequences accepted with the plan (from brainstorm rev 2 "model consequences", formalized here): path derived at read time via parent chain (no stored paths); folder rows above case rows; bulk toolbar on selection.

## Confirmed facts (verified 2026-09-28)

- `templates` has no folder column; schema evolves via guarded ALTERs (schema.ts:235-239 pattern)
- `selectTemplates` (templates.ts:48-63) is the single matcher behind lists/plays (tags/app/status/excludeDeprecated) — folder filtering slots here
- `POST /api/templates/play-all` (manual.ts:738) → `runBatch({tags, app, udid, …})` — folder run reuses runBatch with a folder selector
- `PATCH /api/templates/:id` (templates.ts:472) is the case-update seam — grows `folderId`
- TestCasesPage ships app-grouped sections + segmented tabs + search + icon row actions (PR #5); the single `.a2-table.a2-list` box with one sticky thead is the container
- Export/import (`POST /api/templates/import`, plan 20260927T164000Z) round-trips case YAML through parseCaseYaml/caseToYaml — `folder:` rides the same pipeline
- EnvPage usage scan, SuitesPage member pickers read templates; Overview/RunDetail read runs only

## Objective

App-scoped multilevel folders over test cases with cPanel navigation, bulk move, folder-level run, and tree-safe delete. Done when: folders CRUD (rename, guarded delete) + navigation + move + run-folder work end-to-end in the browser; folder filter flows through selectTemplates consumers; YAML export/import carries folders; all checks green.

## Data model

```sql
CREATE TABLE IF NOT EXISTS folders(
  id TEXT PRIMARY KEY,
  app_bundle_id TEXT NOT NULL,
  parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_sibling ON folders(app_bundle_id, IFNULL(parent_id,''), name);
-- guarded: ALTER TABLE templates ADD COLUMN folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL
```
- Root = NULL parent; a case outside folders = NULL folder_id (stays visible at the app root)
- Move validation: target folder must belong to the SAME app as the case (app-scoped rule, enforced at the API)
- Rename never rewrites descendants (no stored paths); cycle guard on create (parent must exist in same app; depth cap 8 — named error past it)

## API

- `POST /api/folders` `{ appBundleId, parentId?, name }` (operator) → row; sibling-unique 409
- `PATCH /api/folders/:id` `{ name }` → row (sibling-unique 409)
- `DELETE /api/folders/:id` → 409 with named counts if the folder OR ANY descendant holds cases or subfolders; empty chains may cascade (parent_id ON DELETE CASCADE) but the UI confirm NAMES it: "delete 'a' and its 2 empty subfolders" (review F4)
- `GET /api/folders?app=<bundle>&parentId=<id|null>` → children (folders first, name asc) + `caseCount` per folder (subtree count)
- `PATCH /api/templates/:id` grows `folderId: string | null` (same-app check → 409 named)
- `POST /api/folders/:id/run` → resolves the subtree's case ids server-side, filters deprecated at the route, passes runBatch's existing `cases: [{templateId}]` (manual.ts:622 — Phase D T3; NO runBatch change); returns runIds/count/batchId (review F1)
- NO selectTemplates change (review F2): the folders children endpoint returns subtree case ids once; the UI filters rows from them — the shared matcher stays untouched
- Case YAML: `folder: <path string>` (`a/b/c`) — emitter resolves chain; **import** resolves/creates the chain inside its transaction (all-or-nothing bar unchanged); the **PUT save path accepts-and-ignores** `folder:` with a grammar comment (review F3 — DB rows are the one write path for moves; the yaml doc never moves cases)

## UI (TestCasesPage)

- **Breadcrumb row** above the table (inside each app section header area): `int-dev / login / regression` — root crumb = the app root view. Navigation state: `{ bundle, folderId | null }` per app (multiple apps each remember their position? NO — one global navigation ref `currentFolder: { bundle, id, path }`; switching app section resets to that app's root — simplest honest model)
- **Folder rows above case rows** in the current folder: folder glyph + name + subtree case count; click = descend; `⋯` per-folder actions (rename, delete guarded, run folder)
- **Case rows**: gain a checkbox (first column, 28px) — multi-select; toolbar (above table) grows on N>0: `move to…` (folder picker modal: same-app tree, + new folder inline) and `run selected` (runs the selection via runBatch ids); selection is view-state only (navigate away = cleared)
- `+ folder` header action (per current app + current folder as parent)
- Editor panel unchanged (folder moves happen from rows/toolbar, not the yaml document)

## Stages

1. **Schema + folders API** — table, guarded ALTER, CRUD + guarded delete (subtree count), children listing; tests: sibling 409, rename, guarded-delete counts incl. nested, cycle/depth guard, cross-app move 409
2. **Case seam** — PATCH folderId (same-app check), folder in YAML round-trip (emitter + import resolve-or-create; PUT ignores `folder:`); bulk-move route: N folderId updates in ONE transaction (partial failure = none applied); tests incl. export→import preserves folders
3. **Run** — `POST /api/folders/:id/run`: resolve subtree ids, drop deprecated, pass runBatch `cases`; test: only subtree cases run, deprecated excluded (F1)
4. **UI navigation** — breadcrumb, folder rows, descend/ascend, per-folder actions (rename inline, delete with named counts, run folder); `+ folder`
5. **UI selection** — checkboxes, select-all, bulk move modal (tree picker + inline new folder), run selected; folder labels on export manifest
6. **Impact sweep** — SuitesPage member picker labels gain folder prefix (optional polish); env usage scan unchanged (keys not folders); guide mentions folders; `pnpm run check` + full browser drill (create tree 3 deep, move cases in/out, guarded delete attempts, folder run, export/import round-trip)

## Acceptance checks

- Folder tree 3 levels deep under one app; second app gets its own disjoint tree; same name at same level in different apps OK; duplicate sibling name → 409
- Move case (single + multi) into/out of folders; cross-app target refused named
- Delete: empty leaf OK; folder with case → 409 naming counts; folder whose DESCENDANT has cases → 409
- `run folder` runs exactly the subtree's non-deprecated cases (verified via returned runIds)
- Breadcrumb navigation matches cPanel behavior (no expand/collapse anywhere)
- YAML export carries `folder:`; import into empty DB recreates folders + membership
- `pnpm run check` exit 0

## Out of scope

- Drag-and-drop moving; folder-level tags/suites interplay changes; plans API folder-sourcing (tags/suite stay); cross-app folders; persistence of navigation/selection across reloads.

## Rollout

Branch `feat/testcase-folders` off `origin/main`; PR after the full drill; human merges.
