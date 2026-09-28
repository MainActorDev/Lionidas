# Network page round 2 — six fixes from the live session

- Source prompt: user's 6-point feedback on the shipped network page (2026-09-28 17:53, post-PR #7 live use), invoked with /hms-brainstorm-rough-ideas
- Created: 2026-09-28T10:55:00Z (approx)
- Status: Direction selected (pending operator confirmation of #3 model)

## Goal and context

The rebuilt network page (PR #7) went into real use and the operator returned six findings. One is a real BUG (root list shows foldered scenarios), the rest are UX refinements in the house direction (icons, pagination, disclosure depth, keyboard parity).

## Confirmed inputs and decisions

- User-confirmed (verbatim points 1–6): duplicate-looking scenario rows; replace duplicate/delete text buttons with icons "follow test cases"; presets list "going to explode" — wants a better display/manage model; paginate network log at 25/page; the doc panel renders poorly (stray checkbox, endless used-by, etc.); Esc collapses the expanded scenario "just like the test case".

## Evidence gathered (DB + code, 2026-09-28)

1. **NOT two scenarios** — `s_6062b5db` exists ONCE (`countries-empty`, folder `sfld_941d19e7`). The ROOT list showed it because ForgePage's `loadScenarios()` only appends `?folderId=` when inside a folder; at root (`curFolder === null`) it sends NO filter → server returns ALL scenarios (incl. foldered). **Bug: root must filter `folder_id IS NULL`.** (ForgePage.vue:145)
2. Icons: the test-cases page already settled the idiom — `.ibtn` inline-SVG icon buttons (16px glyph in 28×28 hit box, pewter→paper hover, ember accents) with the shared `#rowtip` fixed tooltip, driven by delegated hover. Reuse verbatim.
3. Presets: 3 presets today, all `exact` GET on the SAME path (`/v1/algo-shipment/route/tariff/destination-recommendation`) with different bodies — the operator's "one API, 10 cases" concern is real: the grouping key that matters is (method, path).
4. Traffic: 12,779 rows; API already takes `?limit=` (server caps, default query returns up to `limit`); no offset/cursor param yet.
5. Panel issues (vision-verified): the member checkbox sits unlabeled mid-row (it toggles enabled, but nothing says so); `used by` renders ALL references (22 for countries-empty: 1 variant + 21 case versions) as a flat unbounded list that pushes the layout; per-preset rows duplicate the page-level preset list's info.
6. Esc: test-cases collapses the yaml editor on Esc (house pattern).

## Exploration (proposals — not accepted)

### Fix 1 — root filter (bug)
At root, send `?folderId=` (empty = root, server already treats `''` as `folder_id IS NULL`). One line + drill.

### Fix 2 — icon actions (settled idiom)
Replace `duplicate`/`delete` text buttons on scenario rows (and `edit`/`delete` on preset rows) with `.ibtn` SVGs + `#rowtip` tooltip, exactly the test-cases implementation. No new design decisions needed.

### Fix 3 — presets: group by endpoint (the real question)
The preset entity is "one canned response", but the OPERATOR mental model is "one endpoint with N variants". Options:
- **a) Group rows by (method, path_pattern)** — a group head row `GET /v1/.../destination-recommendation · 3`, member rows indented (status/body/scenarios-used). Flat list stays flat per endpoint; 10 variants of one API = 1 group with 10 rows, not 10 scattered rows. Matches the house grouped-list anatomy (screens page groups by bundle).
- **b) Master-detail: click an endpoint group → side panel lists its variants.** More depth but adds a surface; the doc panel already owns depth.
- **c) Fold presets into the scenario document entirely** (no standalone presets section). Too far — presets exist without scenarios (capture→preset flow lands here).
**Recommendation: (a)** — grouped list, same idiom as screens-by-bundle; a group row is NOT a folder (no nesting, derived at read). The scenario doc's member picker also groups by endpoint.

### Fix 4 — traffic pagination (25/page)
Server: `GET /api/forge/traffic` gains `?page=` (offset-based; data is ts-DESC, newest first, append-only in practice — offset is adequate and simpler than cursor for a log view; counts are cheap). UI: footer pager `‹ 1 2 3 … n ›` with page size 25; live SSE still reloads the CURRENT page. Search resets to page 1.

### Fix 5 — doc panel composition (from the vision findings)
- **used-by collapsed by default**: one line `used by 22 — variant empty · 21 case versions` with a disclosure toggle (the full list one click down; the anti-bloat rule — rare-fact noise dies, depth demoted behind disclosure). Cap the expanded list's height + scroll.
- **Member checkbox labeled**: the checkbox IS the enabled toggle — give the row an explicit affordance: replace the bare checkbox with the enabled state rendered as the preset row's status pill (`on`/`off` chip with title), or keep the checkbox but add an `enabled` column head. Simplest honest fix: keep checkbox, add tooltip `enabled presets are served when this scenario runs` (exists) AND a visible column label via the row layout (checkbox + `GET /path` + status + on/off chip).
- **Form max-height**: cap the form column (it already has max-height 420px) — enforce + inner scroll so `used by` can't push the panel.
- Panel width: the yaml column collapsed in the screenshot because the form grew; with used-by capped, the two-column split restores.

### Fix 6 — Esc collapses
window keydown while a doc is open → `docOpenId = null` (same as test-cases yaml panel). Careful: PresetEditorModal and inputs must not swallow it — scope to "no modal open, no input focused".

## Open questions

1. **#3 model** — group presets by endpoint (recommendation a), or a different shape the operator prefers?
2. **#5 enabled toggle** — checkbox with visible labeling vs status-pill toggle (recommendation: keep checkbox + `on/off` chip next to status for explicitness)?

## Decisions log

- 2026-09-28 user (chat): **presets grouped by endpoint — ACCEPTED**, with the multi-app question: "what if we are managing multiple apps that obviously handles different endpoints?" → evidence-checked: presets match `method + path` only (matcher ignores host; `forge/matcher.ts:8-23`), so two apps exposing the same path WOULD collide today — the grouping key carries no app dimension because the MODEL doesn't.
- 2026-09-28 user (chat, superseding the host-gap-defer resolution): **presets ALSO get the foldering system** — "presets is grouped by endpoint but we can still implement foldering system too. User will group them by app manually as they wish. Just like the scenario." → **FINAL MODEL: presets live in a cPanel folder tree (manual, user-organized, e.g. by app); WITHIN the current folder, presets render GROUPED BY ENDPOINT (method, path_pattern).** Two orthogonal axes: folders = operator-chosen organization; endpoint groups = automatic grouping inside a folder view. Schema: reuse a global `preset_folders` tree (clone of scenario_folders) + guarded `presets.folder_id`; the scenario doc's member picker lists folders→endpoint-groups the same way. Matcher behavior UNCHANGED (folders are pure organization — no scoping semantics, no effect on serving; the host-collision fact stays documented as a model limitation).
- 2026-09-28 user (chat): **enabled toggle = checkbox + on/off chip** (agent recommendation accepted: "Do with your recommendation").
- 2026-09-28 user (chat): fixes 1 (root filter bug), 2 (icon buttons), 4 (25/page pagination), 5 (panel composition incl. collapsed used-by), 6 (Esc) — confirmed by listing them in the brainstorm prompt.

## Next step

Light plan (fix round + preset foldering): one stage list — fix1 root filter; fix2 `.ibtn` icons; fix3 preset FOLDERS (global tree CRUD, move via select mode, breadcrumb — scenario-folder pattern) + endpoint grouping inside the folder view + member picker follows; fix4 `?page=` + pager (25/page); fix5 used-by collapse + checkbox/on-off chip labeling + form cap; fix6 window-Esc. Build + drill on the real DB.
