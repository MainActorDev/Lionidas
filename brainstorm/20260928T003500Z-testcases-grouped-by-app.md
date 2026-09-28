# Test case list — group by app, APP column → VER column

- Source prompt: "To save space, I want to remove the app bundle identifier from the APP column in the test cases table. Later the app column will be replaced with 'VER' column that will show only the app version. But The test case list is now grouped by section with their corresponding app identifier. such as in the 'env' page. When test cases is total empty, no test cases related to any app, then no app identifier section will show. Make it also expandable/collapsible. The list UI is still the same"
- Created: 2026-09-28T00:35:00Z
- Status: Direction selected

## Goal and context

Restructure the test-cases list: the app bundle id moves OUT of every row (space) into app GROUP SECTION HEADERS (the env page's pattern), each section expandable/collapsible. The freed APP column is repurposed as a VER column showing only the app version per row. Rows themselves keep the exact same UI. The "later" phrasing on VER is read as: do it in the same change (the column exists; filling it with version is trivial and it's what the user asked the column to become).

## Confirmed inputs and decisions

Operator statements (2026-09-28, verbatim intent):
- Remove bundle id from the APP column (save space)
- APP column → VER column showing only the app version
- List grouped by app identifier sections, like the env page
- Zero test cases → zero app sections (no orphan headers)
- Sections expandable/collapsible
- "The list UI is still the same" — rows unchanged

Verified in code (2026-09-28):
- Current: one flat `a2-table` grid; thead `case · app · steps · updated · trend · evidence · verdict · (actions)`; APP cell = device icon + full bundle + `v{version}` (TestCasesPage.vue:764-773)
- Env page pattern (the named reference): `.scope-block` + `.scope-head` (caret ▾/▸ + owner label + count + per-section actions), `openSections` Set state (EnvPage.vue:231-238)
- Screens page also groups by bundle with `.section-label` headers + header actions — two in-house precedents for grouped lists
- `t.appVersion` already ships on rows (live runner context stamps it; recorded fallback exists — crucible-web-ui skill: version from LIVE runner context, playback stamps it back)
- Row grid: `.a2-thead` grid-template-columns pins 8 tracks incl. `minmax(0,1.2fr)` app track
- Filter/search interplay: `shown()` filters rows; grouping must respect the filter (sections whose rows all filter out disappear — same as the empty rule)

## Exploration

### Grouping model (proposed)

- Compute groups from `shown()` (post-filter): `[{ bundle: string|null, rows: Template[] }]`, ordered by bundle asc, `null`/no-app cases in a final `no app` group (they exist today as "no app" rows; they still need a home).
- Section header: env-page idiom — caret + bundle id (mono, full, ellipsized w/ title) + case count. Not a new design surface; clone the env page's `.scope-head` classes (or the screens `.section-label`) — pick whichever matches the table's visual rhythm (proposal: env-page style with caret, since expand/collapse is required).
- Collapsed = rows hidden; header row keeps its own hover/click (click toggles, stopPropagation so it doesn't open an editor). Default state: **expanded** (lists are the working surface; collapsing is the user's choice). State kept in a Set keyed by bundle, surviving filter changes; NOT persisted (no storage noise).
- thead: shows once at top (sticky) as today — sections live INSIDE the scroll region between header and rows. The VER column replaces APP in the same track; version-only content is narrow → shrink the track (`minmax(0, 1.2fr)` → ~`minmax(0, 70px)`), giving the space back to `case` (the stated goal).

### VER column (proposed)

- Cell: `v{appVersion}` alone (mono, steel). No icon (the bundle's device icon belongs to the section now). Rows without version: `—`. Tooltip: full `bundle · version` for context.
- The column header reads `ver`.

### Edge cases

- Filter empties everything → no sections (matches "total empty → no section").
- All rows in one bundle → one section; collapsing it hides everything.
- A case with no app → `no app` group at the end (collapsible like the rest).
- Editing a case (yaml panel) while its section is collapsed → auto-expand that section when `yamlOpenId` targets a hidden row (otherwise the editor opens "invisibly").
- `run filtered`/play-all operate on `shown()` — must respect collapsed sections (proposal: still play collapsed rows — collapse is a VIEW state, not a selection; note in tooltip).

### What stays untouched

Row internals (case cell, steps, updated, trend, evidence, verdict, icon actions), the toolbar, duplicate/export/import, the editor panel, all API.

## Decision log

- **2026-09-28, operator:** sections **expanded by default**.
- **2026-09-28, operator:** **hide `run filtered`** for now ("I have other plans for it") — the playAll plumbing stays in code but the header affordance is removed; the collapse-vs-selection question dies with it.
- **2026-09-28, operator:** elaboration of the no-app choice (below) — default = a final `no app` section.

### The "no app" case, in plain English

A test case can exist without any app attached (its `app` field is empty — e.g. a case recorded before apps were tracked, or a draft not yet bound to a bundle). In today's flat list such a row shows the text "no app" in the app column. Once the list is grouped by app, that row belongs to no group, so it needs a home: the proposal is one extra collapsible section at the very bottom titled `no app`, holding exactly those rows — same look, same rules as the bundle sections. Right now the live DB has **zero** such rows (verified: all 6 cases carry a bundle), so this section simply won't render — it exists so the design never breaks if a no-app case appears later. The alternative (such rows floating ungrouped between sections) reads as a bug; that's why a trailing section is the default.

## Next step

`hms-plan-from-brainstorm` with the three answers (or defaults accepted), then build: grouping computed + section headers + collapse state + VER column swap + live drill.
