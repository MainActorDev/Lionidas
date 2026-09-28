# Test case foldering system — cPanel file-manager model

- Source prompt: "As a user I want to easily manage my test cases in a way that user can groups testcases into a certain folder/directory (foldering system). 1. create/update folder (rename), no delete when not empty 2. move test cases into a folder 3. run testcases from a folder level 4. behavior like the cPanel file manager. Not expanding/collapsing 5. check impact across pages or features"
- Created: 2026-09-28T02:30:00Z
- Status: Questions open

## Goal and context

A folder/directory layer over test cases for organization + folder-level execution. The cPanel file-manager reference is load-bearing for the UX model: **navigation, not disclosure** — you click into a folder (breadcrumb path, the list shows that folder's contents), you don't expand/collapse tree nodes in place. This is a DIFFERENT interaction than the app-group sections just shipped (those stay; folders nest WITHIN the page as navigation).

## Confirmed inputs and decisions

Operator statements (2026-09-28):
- Create + rename folders; **no delete while non-empty** (safety)
- Move test cases into folders
- Run all cases in a folder (folder-level run)
- **cPanel file-manager behavior: NOT expand/collapse** — navigate in/out
- Audit impact across pages/features

Verified in code (2026-09-28):
- `templates` has no folder column today; schema evolves via guarded ALTERs (house pattern)
- `selectTemplates` (templates.ts:48-63) is the ONE matcher for lists/plays (tags, app, status, excludeDeprecated) — folder filtering belongs here
- `POST /api/templates/play-all` exists (tags-based batch); suites are the OTHER grouping concept (ordered membership for regression packs — a different animal: folders = organization, suites = ordered execution sets)
- Pages consuming templates: TestCasesPage (list/editor), OverviewPage, RunDetailPage, SuitesPage (member pickers), ScreensPage, EnvPage (usage scan), guide
- The plans API (`/api/plans`, currently UI-less) also plays templates by tags — impacted surface
- App-group sections on TestCasesPage are NEW (shipped `887b64e`) — folders intersect: group-by-app THEN folder navigation inside? or folders replace grouping?

## Exploration

### Data model (proposed)

Single flat `folders` table (id, name UNIQUE, created_by/at) + `templates.folder_id NULL` (guarded ALTER). **No nesting** (cPanel has it, but nesting multiplies UI complexity for near-zero value at this scale — a proposal to challenge, not a settled fact). Root = `folder_id IS NULL`. Cases move via PATCH (existing route grows `folderId`). Folder rename = PATCH on folder. Delete refused with a named count while cases reference it ("folder 'login' holds 3 cases — move them first") — matches operator rule exactly.

### UX model (cPanel-like)

- Breadcrumb above the list: `all / login / regression` — click any crumb to navigate up
- The list shows the CURRENT folder's cases; the current folder's header carries `run folder` (the folder-level play)
- Row action or editor: `move to folder…` (select). cPanel also drag-selects + moves — out of scope v1
- Folder management: a `+ folder` header action; rename via the breadcrumb/folder chip; empty-check delete guard
- App-group sections: folders live INSIDE the app grouping (each bundle section lists its cases; the folder filter narrows within) — simplest composition, or folders become the PRIMARY navigation with app sections nested inside. Tension to resolve (open question 1).

### Folder-level run

`POST /api/folders/:id/run` → the existing play-all machinery scoped by folder (reuse `selectTemplates` + batch player; excludeDeprecated on, same as play-all). UI: `run folder` on the folder's view header.

### Impact audit (verified surfaces)

1. **TestCasesPage** — breadcrumb + folder nav + move action + run-folder (primary surface)
2. **selectTemplates** — folder filter added here so EVERY consumer (list, play-all, plans) inherits it consistently
3. **SuitesPage** member pickers — show folder in the case dropdown labels (context) — optional
4. **Overview/RunDetail** — no folder data needed (runs unchanged)
5. **EnvPage usage scan + export/import** — folder_id should round-trip in YAML? Proposal: YES as `folder: <name>` (names unique) so exports carry organization; import resolves name → id, creating the folder if absent (with the import's all-or-nothing bar)
6. **plans API** — leave tag-based; folder run is the new sibling

## Decision log

- **2026-09-28, operator:** folders are **app-scoped** — each app section owns its folder tree; folder names may repeat across apps; a case's folder lives inside its app's tree.
- **2026-09-28, operator:** **multilevel nesting** (cPanel's real directories): folders contain folders to arbitrary depth; breadcrumb navigates the path.
- **2026-09-28, operator:** **multi-select is possible** — cPanel-style select rows + bulk move (and bulk run/delete ride the same selection).

### Model consequences of the decisions (design, not yet accepted)

- `folders(id, app_bundle_id, parent_id NULL→folders.id, name, created_by, created_at)` — UNIQUE(app_bundle_id, parent_id, name) so siblings can't collide but cross-app/different-parent names repeat freely; a case's folder chain always terminates at its app's root
- cPanel navigation: breadcrumb `int-dev / login / regression`, folder rows listed ABOVE case rows inside the current folder (cPanel shows directories first), click to descend, breadcrumb crumb to ascend
- Multi-select: checkbox column per row + select-all; the toolbar grows `move to…` and `run selected` when N > 0 (bulk actions on the selection, not the folder)
- Folder delete: refuse while it OR ANY DESCENDANT holds cases or subfolders ("folder 'login' isn't empty — 3 cases, 1 subfolder") — operator rule extended to the tree
- Folder rename = PATCH; a rename never moves cases (path derives at read time via parent chain — no stored paths to rewrite)

## Open questions

None blocking — all three resolved; the plan formalizes the model above.

## Next step

Answer the three questions → plan (`hms-plan-from-brainstorm`) → review → build.
