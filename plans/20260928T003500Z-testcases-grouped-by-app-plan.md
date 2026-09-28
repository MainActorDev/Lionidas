# Plan — test case list grouped by app; APP → VER column

- Source brainstorm: `brainstorm/20260928T003500Z-testcases-grouped-by-app.md` (decisions folded, 2026-09-28)
- Created: 2026-09-28T00:50:00Z
- Status: **Ready**

## Decision log

- **2026-09-28, operator:** sections **expanded by default**; collapse is the user's act, state not persisted.
- **2026-09-28, operator:** **hide `run filtered`** ("other plans for it") — remove the header button; keep `playAll()` + stop-all code untouched for the future.
- **2026-09-28, operator:** `no app` rows → final collapsible `no app` section (elaborated in the brainstorm; live DB currently has zero such rows, so it won't render until one exists).
- Bundle sections ordered alphabetically; `no app` always last.
- Grouping computed from the POST-FILTER rows (`shown()`): a section whose rows all filter out does not render (operator rule: total empty ⇒ no sections).

## Confirmed facts (verified 2026-09-28)

- Rows carry `appBundleId`, `appVersion` (live-runner-stamped), `udid` (device icon source)
- Env page grouping idiom: `.scope-block`/`.scope-head` + caret + `openSections: Set<string>` (EnvPage.vue:231-238) — the named reference pattern
- thead grid: `case · app(1.2fr) · steps · updated · trend · evidence · verdict · actions` (TestCasesPage.vue:746+)
- APP cell today: device icon + full bundle + `v{version}` ("no app" when bundleless)
- `run filtered` button lives in PageHeader actions with `playingAll` state + `stop all` variant

## Objective

The bundle id moves from every row to collapsible app-section headers; the APP column becomes a narrow VER column (`v{version}` only); `run filtered` disappears from the header. Rows otherwise unchanged. Done when: live list renders sections per bundle + a VER column, collapse/expand works per section, empty-filtered groups drop their headers, checks green, browser-verified.

## Stages

1. **Script** — `groups` computed from `shown()` (`[{ key: bundle|null, label, rows }]`, bundle asc, `no app` last); `collapsed: Set<string>` state; `toggleGroup(key)`; auto-expand INSIDE openYaml (expand the row's group before yamlOpenId flips — no flicker; review F2).
2. **Template** — wrap rows in `v-for g in groups`; section header row (env-page idiom: caret + mono bundle + count, `@click.stop` toggles) spanning the grid; rows render `v-show`/`v-if` on `!collapsed.has(g.key)`; thead `app` → `ver`; header `run filtered` button removed (`v-if="false"` is NOT allowed — delete the element; playAll/stopAll code stays).
3. **VER column** — cell shows `v{{ t.appVersion }}` (mono, steel) with `title="bundle · version"`; `—` when absent; drop the device icon + bundle text from the row; grid track `minmax(0, 1.2fr)` → `minmax(0, 70px)` (space returns to `case`).
4. **Styles** — `.a2-group-head` cloned from the env scope-head rhythm (caret, mono owner, count), hairline top border between sections; IN-FLOW (`grid-column: 1 / -1`, no sticky — the thead owns sticky; review F1).
5. **Verify** — `vue-tsc`; browser drill: sections render per bundle, collapse/expand, VER shows versions, filtered-empty group headers vanish, editor-open auto-expands, no `run filtered`; `pnpm run check` green.

## Acceptance checks

- `/templates` renders one collapsible section per bundle (expanded, rows visible), `no app` section absent (no such rows)
- Collapse a section → its rows hide; header stays; expand restores
- Search that excludes a bundle's every row → that header disappears
- VER column shows `v…` values; tooltip carries bundle·version; APP column/bundle text gone from rows
- Header has no `run filtered`
- `pnpm run check` exit 0

## Out of scope

- Persisting collapse state; bulk-run UI replacing `run filtered` (operator's separate plan); API changes; row internals.
