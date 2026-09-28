# Review — test case foldering plan (cPanel, app-scoped, multilevel)

- Reviewed plan: `plans/20260928T023000Z-testcase-foldering-plan.md` (Ready, 2026-09-28T03:10:00Z)
- Evidence: plan + brainstorm rev 2; manual.ts:613-625 (runBatch accepts explicit `cases` — Phase D T3), templates.ts:472-484 (PATCH), :48-63 (selectTemplates), schema.ts guarded-ALTER pattern, sqlite 3.54.0 (expression indexes OK), case-yaml.ts:53-63/556-559 (YamlCase + emitter top-level fields), TestCasesPage current anatomy (PR #5)
- Verdict: **Ready for implementation** — one High folded (folder-run transport), mediums folded as edits. No operator questions.

## Traceability

Operator decisions → stages: app-scoped (schema UNIQUE + same-app move check → stage 1/2), multilevel (parent_id chain, depth cap, tree delete guard → 1), multi-select (checkbox + bulk toolbar → 5), create/rename/guarded-delete (1), folder run (3), cPanel navigation (4), impact audit (6). No commitments beyond the brainstorm.

## Findings

### F1 — High · folder-run transport underspecified (now resolved by evidence)
Plan stage 3 says "runBatch with the folder's subtree case ids" — verified: runBatch ALREADY accepts `cases: [{templateId}]` (manual.ts:622-625, Phase D T3, with ghost-check → honest 400). So the folder-run route resolves subtree ids server-side and passes `cases`; **no runBatch change needed** and deprecated-exclusion happens at id-resolution time (filter subtree ids by status before passing). Folded into stage 3: pass `cases`, filter deprecated at the route, and the acceptance test pins "deprecated excluded" against real status values.

### F2 — Medium · selectTemplates subtree filter is redundant surface
Stage 2 adds `folderSubtree?: string[]` to selectTemplates, but with F1 the ONLY consumer needing subtree filtering is the LIST route (navigation view), which can filter rows in the route/UI directly — `shown()` already filters client-side. Adding a parameter to the one shared matcher for a single consumer widens a hot interface for nothing. Correction (folded): drop the selectTemplates change; the folders children-listing endpoint returns the subtree case ids once, and the UI filters its rows from them. Simpler, zero drift risk on the matcher every play path shares.

### F3 — Medium · `folder:` in YAML vs save-path validation
Emitter adds `folder: <path>`; but the PUT-yaml save path (resolveCaseRefs) does NOT resolve it — a hand-edited `folder:` in the editor document would be silently ignored on save (document owns truth ≠ stored state). Correction (folded): `folder:` is read-only in v1 — the emitter writes it, the parser ACCEPTS but ignores it on PUT (documented in the grammar), and only IMPORT (the bulk path) resolves/creates folders. Editor moves stay row/toolbar-only. This keeps one truth (DB rows) and avoids a second write path through the yaml doc.

### F4 — Medium · delete guard vs ON DELETE CASCADE on parent_id
Schema has `parent_id … ON DELETE CASCADE`: deleting a folder cascades its SUBFOLDERS. The guarded-delete route checks descendants first (refuses non-empty), so cascade only fires on empty subtrees — correct, but the cascade makes "delete empty folder with empty children" delete the children silently. Operator rule says folders are organizational; deleting an empty chain is acceptable cPanel behavior (delete confirms). Folded: the UI delete confirm names it ("delete 'a' and its 2 empty subfolders") — no silent surprise.

### F5 — Low · navigation state resets on app switch
Plan picks one global currentFolder ref (switch app → that app's root). Fine; noted as accepted design, drill covers it.

### F6 — Low · UNIQUE index expression portability
`IFNULL(parent_id,'')` in a unique index requires expression-index support (sqlite ≥3.9; local 3.54 ✓, better-sqlite3 bundles its own modern sqlite ✓). Verified safe; noted.

## Required plan edits (all folded above)

1. Stage 3: folder run passes runBatch `cases` (no runBatch change); deprecated filter at the route
2. Stage 2: drop selectTemplates change; subtree ids from the folders endpoint drive UI filtering
3. Stage 2: `folder:` YAML is emitter+import only; PUT ignores it (grammar comment)
4. Stage 1/4: delete-confirm names cascaded empty subfolders

## What remains to validate during implementation

- Subtree resolution correctness at depth (recursive CTE vs JS walk — test pins 3-deep)
- Bulk move transaction (N PATCHes → one route doing N updates in one tx; test partial-failure = none applied)
- Browser drill items in stage 6
