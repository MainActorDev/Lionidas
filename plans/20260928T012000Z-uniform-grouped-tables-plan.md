# Plan — uniform app-grouped tables: suites, env, screens + shared anatomy

- Source brainstorm: `brainstorm/20260928T012000Z-uniform-grouped-tables.md` (rev 2: all questions answered)
- Created: 2026-09-28T01:35:00Z
- Status: **Ready**

## Decision log

- **2026-09-28, operator:** env page — restyle **all three scope kinds** (global/app/plan) to the same head anatomy ("Yes").
- **2026-09-28, operator:** suite heads show the **suite count** per bundle.
- **2026-09-28, operator:** **no persistence** of collapse state anywhere.
- **2026-09-28, operator (new):** "Ensure the header navbar buttons follow the test case too" — every page's header action buttons adopt the test-cases page's button anatomy: the segmented filter-tab toolbar is test-cases-specific, but the HEADER itself must match: PageHeader with actions row using the same `.btn` rhythm, same order convention (primary create left, secondary actions after), and the search/filter toolbar pattern where a page has filters. Concretely: suites + screens + env headers get the same action-button sizing/spacing/classes as test cases (`.btn` standard size, ghost for secondary), and any icon-only affordances use `.ibtn`. No page invents its own button styles.

## Confirmed facts (verified 2026-09-28)

- TestCasesPage reference: `.a2-group-head` (scoped CSS, in-flow, caret+mono owner+count right), `collapsed: Set<string>`, `NO_APP` sentinel trailing group, groups from post-filter rows
- SuitesPage: `.su-table/.su-thead/.su-row` (suites.ts ships `app_bundle_id`; flat v-for over suites; header actions exist)
- EnvPage: `.scope-block/.scope-head` + `openSections` Set + `toggleSec(key)` — collapse behavior ALREADY exists; heads carry caret+owner+count+inline actions
- ScreensPage: `.section-label.bundle-row` heads with actions (`+ screen`, `yaml`, `login flow`), no collapse; rows/thead already house idiom
- All four pages use PageHeader (uniform 18px title row)

## Objective

One grouping + table + header-button anatomy across suites, env, screens, test cases. Done when all four pages render collapsible group heads with identical classes (global), their tables share the sticky-thead/hairline idiom, header buttons match the test-cases rhythm, checks green, and a four-page browser drill passes.

## Stages

1. **Shared class extraction** — move `.a2-group-head` styles from TestCasesPage scoped CSS to global `components.css` (`.a2-group-head`, caret/owner/n rules); TestCasesPage retargets (delete scoped copy). Verify test-cases unchanged (browser diff).
2. **Suites** — groups computed from suites by `app_bundle_id` (post-nothing: suites have no page filter today; groups = all suites, bundle asc, `no app` trailing); collapsible heads (suite count); rows unchanged inside groups; header actions normalized to test-cases button rhythm.
3. **Screens** — heads gain caret + count (screen count per bundle) + collapse (`collapsed` Set keyed by bundle, expanded default); head actions keep stopPropagation; NO_APP not possible (registry is per-bundle by construction) — no sentinel needed.
4. **Env** — all three scope heads (global/app/plan) restyled to `.a2-group-head` (reusing its existing collapse Set/keys); rows to hairline idiom (already close); header actions normalized.
5. **Header buttons uniform** — audit all four pages' PageHeader action slots: same `.btn` classes/sizes, same order (create → export/import-class secondaries → danger last), icon-only affordances via `.ibtn`; no bespoke button CSS left in page scopes (grep `.btn` overrides).
6. **Verify** — vue-tsc; browser drill all four pages: heads render + collapse/expand, counts correct, test-cases untouched visually, headers side-by-side match; `pnpm run check` green.

## Acceptance checks

- All four pages' group/scope heads share ONE global class; caret toggles; counts match rows; empty group ⇒ no head (suites; env/screens derive from data that can't be empty per operator's earlier rule but heads vanish with zero vars/screens)
- Suites grouped by bundle with suite counts; screens collapsible; env scope heads restyled, behavior unchanged
- Header action buttons visually identical rhythm across pages (same classes, no page-scoped button restyles)
- `pnpm run check` exit 0

## Out of scope

- Suite member counts on heads; persistence; new filters/toolbars on other pages; API changes.
