# Folders — duplicate-in-folder, full-bundle root crumb, edge-case sweep

- Source prompt: "1. Duplicating a test case inside a folder, the duplicate should be created inside that folder too 2. For folder breadcrumbs (root), it's better to show the full text of the app identifier instead 3. Please check more possible unhandled cases"
- Created: 2026-09-28T13:30:00Z
- Status: Direction selected

## Goal and context

Three asks: duplicate inherits the source's folder; breadcrumb root shows the FULL bundle id (not the last segment); a systematic sweep for unhandled folder edge cases before merge.

## Confirmed inputs and decisions

Operator (2026-09-28): duplicate lands in the same folder; root crumb = full app identifier; audit for more unhandled cases.

Verified in code (2026-09-28):
- `duplicate` INSERT (templates.ts:412) omits `folder_id` → copies land at app root today (bug #1 confirmed)
- crumb root uses `bundle.split('.').slice(-1)[0]` (TestCasesPage crumbPath) → `int-dev` instead of the full id (bug #2 confirmed)
- `resolveFolder` on import derives the app from `c.app` only — a case with `folder:` but NO `app:` in yaml imports to root silently (folder dropped) unless app known
- `folderNav`/`listings` are per-bundle; delete-folder resets nav only if `folderNav[bundle] === id` — deleting an ANCESTOR of the current nav folder leaves the nav pointing at a dead id (listing 404s silently → stale view)
- Case move to root (folderId null) is allowed cross-app (null has no app) — fine; but `PATCH appBundleId` changing a case's app while it sits in a folder of the OLD app orphans it from any reachable tree (folder belongs to app A, case now claims app B)
- Selection + navigate: navigating into a folder keeps selection of rows no longer visible (bulk move target ambiguity) — minor
- `+ folder` prompt: no name validation client-side (server trims + 409s dupes — honest but prompt UX)
- Search interplay: `listedCases()` filters `shown()` by listing ids — search inside a folder searches THAT folder only (defensible; root search doesn't descend into folders — a real gap: searching at root hides every filed case)

## Exploration — the fix list (numbered, each verifiable)

1. **Duplicate inherits folder**: add `folder_id` to the duplicate INSERT (copy `row.folder_id`). Test: duplicate a foldered case → copy's folder_id equal.
2. **Root crumb full bundle**: `crumbPath` root name = full `bundle` string.
3. **Delete resets nav for DESCENDANTS**: when deleting folder X, any bundle nav whose current folder is X or UNDER X resets to root (walk listing path client-side, or simplest: after any delete, re-resolve nav id; if missing from fresh path → root).
4. **App-change orphans**: PATCH validates — if `appBundleId` changes and the case has a folder_id, that folder must belong to the NEW app (else 409 named) — or auto-detach (folder_id=null). Decision: 409 (explicit beats silent).
5. **Import folder without app**: if a doc has `folder:` but no `app:`, resolve the folder only when the import body provides a default app; else 422 named ("folder requires app"). Prevents silent folder-drop.
6. **Root search descends**: at root depth, `listedCases` should include ALL the app's cases when the search filter is active (search is a global operation; folder scoping applies to browsing, not finding). Test via UI drill.
7. **Selection cleared on navigation** (enter/leave folder): stale selections can't target invisible rows.
8. **Folder name in prompt**: trim + reject empty client-side before POST (minor UX; server already guards).

## Open questions

None — all defaults are the explicit/honest option.

## Next step

Fold into PR #6 as one commit: fixes 1–2 (operator asks), 3–8 (sweep findings), each with a test where server-side, each drilled where UI.
