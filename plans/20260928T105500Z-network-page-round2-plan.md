# Network page round 2 — six fixes + preset foldering (plan)

- Source brainstorm: `brainstorm/20260928T105500Z-network-page-round2.md` (all decisions recorded there)
- Status: Ready (fix round on the approved 021-c2 design; folder anatomy already sketched/approved three times — no new sketch round)

## Stages (each lands with tests/drills)

**1. Root filter bug (fix1)** — `loadScenarios()` sends `?folderId=` at root too (server already treats `''` as `folder_id IS NULL`). Drill: foldered scenario invisible at root.

**2. Icon actions (fix2)** — scenario rows (duplicate/delete) + preset rows (edit/delete) become `.ibtn` SVG buttons with the shared `#rowtip` fixed tooltip (test-cases idiom verbatim: 16px glyph, 28×28 hit box, pewter→paper hover, ember accents).

**3. Preset foldering + endpoint grouping (fix3, user model)** — presets live in a manual cPanel folder tree (user organizes by app); within a folder view they render grouped by endpoint `(method, path_pattern)`; matcher/serving unchanged (folders are pure organization).
- schema: `preset_folders` table (clone of scenario_folders) + guarded `presets.folder_id`
- refactor `scenario-folders.ts` into a generic folder-route factory; register `/api/preset-folders` (same CRUD, subtree counts, delete-empty 409 both counts, depth cap)
- `GET /api/forge/presets` gains `?folderId=` ('' = root, subtree filter otherwise); `PATCH /api/forge/presets/:id` accepts `folderId`
- UI: presets section gets breadcrumb + folder rows + select-mode move (scenario pattern); rows under an endpoint group head `METHOD path · n`; ScenarioDocPanel's add-preset picker groups options by endpoint (optgroup)
- tests: preset folder CRUD clone + folder filter; drill: create folder, move preset, grouped render, picker groups

**4. Traffic pagination (fix4)** — server: `GET /api/forge/traffic` gains `?page=` (offset) and returns `total` for the current filter; UI: 25/page, footer pager (‹ page ›), live reload refreshes current page, search resets to page 1. Test: page slicing + total.

**5. Doc panel composition (fix5)** — `used by` collapses to a one-line summary (`used by 22 — variant \`empty\` · 21 case versions`) with disclosure toggle and capped scroll; member rows show checkbox + on/off chip (explicit enabled state); form column capped (420px, inner scroll) so the yaml panel never gets pushed off.

**6. Esc collapses (fix6)** — window keydown closes the open scenario document; scoped to "no modal open (PresetEditorModal), no input/select focused" (test-cases pattern).

## Acceptance

Suite green (existing 1057 + new preset-folder/pagination tests); build clean; live drill: root filter, icons+tooltips, preset folder create/move/navigate + endpoint groups, pagination walk, used-by collapse, Esc. Known model limitation documented (matcher ignores host — folders don't scope serving).
