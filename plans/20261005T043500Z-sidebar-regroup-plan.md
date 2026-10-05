# Sidebar regroup plan (A — collapsible tree)

- Source: brainstorm/20261005T035716Z-sidebar-regroup.md (variant A picked), sketches/025-sidebar-regroup/a-collapsible-tree/
- Status: Ready
- Scope: nav-only regroup in the app shell. No route/path/name changes, no new pages.

## Objective

Replace the 5-group flat sidebar (3 single-item groups, duplicated `network`
label) with 3 collapsible groups — testing / library / system — using the
caret-toggle idiom, expanded by default, auto-expanding a group when the active
route lives inside it.

## Changes

1. **Branch**: `feat/sidebar-regroup` from `main` (fresh concern; the in-flight
   cockpit branch stays untouched).
2. **`web/src/App.vue`** — replace the five `.nav-group` blocks with three
   collapsible groups:
   - state: `collapsed = reactive<Record<string, boolean>>({})` (absent = expanded);
   - group head: `<button class="nav-grp-head" @click="toggle">` with caret span
     (`▾`/`▸` via CSS rotate) + uppercase label — a button, not a div, for
     keyboard/a11y;
   - children: existing `.nav-item` RouterLinks, indented (`padding-left: 30px`
     via a `.nav-grp .nav-item` rule), hidden when collapsed (`v-show`);
   - route→group map drives `isActive` for heads (head reads as active-context
     when a child route is active) and a `watch(route.name)` auto-expands a
     collapsed group the moment navigation lands inside it;
   - group membership exactly as picked:
     - testing: overview, suites, runs, devices
     - library: test cases (templates), screens, env, network (forge)
     - system: monitoring, users, guide
3. **`web/src/styles/layout.css`** — replace `.nav-group`/`.nav-group-label`
   styles with: `.nav-grp` (margin), `.nav-grp-head` (caption-styled clickable
   head: uppercase 12px steel, hover→fog, caret 12px steel rotating 90° when
   collapsed, `border-left: 2px transparent` aligned with nav-item geometry),
   `.nav-grp .nav-item { padding-left: 30px }`. All values from tokens.
4. **Tests**: extend/confirm existing App shell test (if present) for: 3 group
   heads render; toggling hides children; auto-expand on in-group navigation;
   nav still hides < 768px. If no App test exists, add a minimal vitest for the
   three assertions above.

## Out of scope

CmdPalette, topbar, mobile drawer (sidebar is display:none < 768px today and
stays so), route renames, cockpit/matrix entries.

## Verification

- `pnpm --filter web check` (vue-tsc + oxlint) and `pnpm --filter web test`.
- Dev servers up; browser drill: groups render, caret toggles collapse/expand,
  active item indented + ember bar, navigating to `/monitoring` auto-expands
  `system` if collapsed, `/runs/:id` keeps `runs` active under testing, no
  horizontal scrollbar, 1280px + 1440px widths.
- `git diff` review; commit; push; PR (create-only, no merge).
