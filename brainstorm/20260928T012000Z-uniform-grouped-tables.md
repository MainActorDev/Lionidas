# Uniform app-grouped tables across suites, env, screens

- Source prompt: "Can you do the same grouping to the 'suites', 'env', 'screens' page? And table appearance follow the test cases page for uniform"
- Created: 2026-09-28T01:20:00Z
- Status: Direction selected

## Goal and context

Extend the test-cases page's new anatomy — collapsible app sections + the shared table look — to the three other bundle-bearing surfaces, so every list page reads as one system. "The same grouping" = the `.a2-group-head` pattern (caret + mono bundle + count, expanded by default, sections vanish when empty); "table appearance … for uniform" = the a2 table idiom (sticky uppercase thead, hairline rows, same head styling) across all of them.

## Confirmed inputs and decisions

Operator (2026-09-28, verbatim intent): same grouping on suites, env, screens; table appearance follows the test-cases page for uniformity.

Verified in code (2026-09-28):
- **TestCasesPage** (the reference, shipped `887b64e`): `.a2-group-head` in-flow section rows inside the scroll region; groups from post-filter rows; `collapsed: Set`; thead `case·ver·steps·updated·trend·evidence·verdict`; track widths per column need
- **SuitesPage**: flat `.su-table`/`.su-thead`/`.su-row` grid (`suite · members · drift · updated · verdict · actions` — 1.4fr/1fr/150px/92px/1.2fr/170px); suites carry `app_bundle_id` (suites.ts:13); live DB: 1 suite, 1 bundle
- **EnvPage**: ALREADY grouped by scope with `.scope-block`/`.scope-head` + `openSections` Set — its app groups match the pattern in spirit but not in table anatomy (it's a cards/rows hybrid, not a table with thead)
- **ScreensPage**: ALREADY grouped by bundle via `.section-label bundle-row` headers, non-collapsible; own thead grid (`screen·entry·refresh·states·used by` — house idiom already)
- `no app` handling precedent from test cases: sentinel trailing section

## Exploration

Per-page reality check — the three pages are NOT the same shape, so "the same" means the same GROUPING MODEL + TABLE IDIOM, not identical columns:

### Suites (real change)
Flat list → grouped by `suite.app_bundle_id`, collapsible heads, empty⇒no-section rule. Members' cross-bundle drift already surfaces as a chip (SuitesPage:97) — the group is the SUITE's bundle, members keep their drift marks. `no app` suites (app_bundle_id NULL — possible today) get the trailing section. Column anatomy unchanged (it's already the house row idiom).

### Env (grouping exists; uniform the table look)
Keep its scope structure (global/app/plan IS its domain model — not bundles-only; plan groups have no bundle). Align the APP group heads to the `.a2-group-head` anatomy (caret+mono+count, same spacing/hover) and the var rows to the hairline-row idiom. No bundling change beyond visual: global + plan sections stay as they are (they're scopes, not apps — collapsing the env page into app-only groups would delete its domain model).

### Screens (grouping exists, not collapsible; uniform heads)
`.section-label bundle-row` heads gain the caret + count + collapse behavior (`collapsed` Set keyed by bundle; header actions `+ screen`/`yaml`/`login flow` stay on the head row with stopPropagation). Rows/thead already the house idiom — minor: match head spacing/hover to a2-group-head.

### Shared piece (proposed, keeps uniformity DRY)
Extract `.a2-group-head` styling to a GLOBAL class (components.css) used by all four pages — test cases retargets to it, the other three adopt it. Per-page collapse state stays local (different keys, different data). This prevents the four pages drifting apart again — the exact drift the user is asking to eliminate.

## Open questions

1. Env page: align only the APP scope heads + rows to the idiom (proposal), or restyle global/plan blocks too for one look end-to-end? (Proposal: restyle all three scope kinds to the same head anatomy — uniformity is the ask; plan/global heads just carry their own labels.)
2. Suites group counts: head shows suite count per bundle (proposal) — any want for member counts too? (Proposal: no — one number per head, like test cases.)
3. Screens: collapse remembers nothing (same as test cases) — fine?

## Next step

`hms-plan-from-brainstorm`, then build per page (suites grouping → screens collapsible → env alignment → shared class extraction LAST so the reference stays stable), browser drill each.
