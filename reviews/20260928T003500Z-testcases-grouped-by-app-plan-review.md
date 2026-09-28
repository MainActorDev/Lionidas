# Review — test case list grouped by app; APP → VER plan

- Reviewed plan: `plans/20260928T003500Z-testcases-grouped-by-app-plan.md` (Ready, 2026-09-28T00:50:00Z)
- Evidence: plan + brainstorm (decisions folded); TestCasesPage.vue:740-775 (thead + APP cell), EnvPage.vue:231-238 (scope-head idiom), live DB (6 cases, 1 bundle, 0 no-app rows); `shown()`/`filter` wiring; playAll in PageHeader actions
- Verdict: **Ready for implementation** — one Medium, one Low, both folded as notes below; no operator questions.

## Findings

### F1 — Medium · sticky thead vs section headers inside the scroll region
Section headers render as rows inside `.a2-table` whose thead is `position: sticky; top: 0`. Group heads must NOT be sticky (they'd stack under the thead and read as a second header row); they must scroll WITH content. Plan stage 4 should say: `.a2-group-head` is a normal in-flow grid row (`grid-column: 1 / -1`), no position tricks. Verified risk: the thead has z-index 2; group heads stay z-auto.
→ Folded into stage 4.

### F2 — Low · `openYaml` row-toggle + group auto-expand ordering
`openYaml(t)` toggles `yamlOpenId`; if the row's group is collapsed the editor mounts hidden. Plan already handles via watch on `yamlOpenId` — note the watch must expand BEFORE the panel opens (flush: 'sync' or expand inside openYaml itself) or the first open of a collapsed row flickers. Simplest: expand in `openYaml` directly (find row's group key) — folded into stage 1.

### F3 — Low · deprecated dimming interplay
Rows carry `:class="{ deprecated: ... }"`; grouping must not break that (rows keep their own classes — plan keeps row internals verbatim). No action; noted.

## Traceability
Operator decisions → stages: expanded-by-default ✓ (stage 1), hide run-filtered ✓ (stage 2), no-app trailing section ✓ (stage 1), post-filter grouping ✓ (stage 1), VER swap ✓ (stage 3). No extra commitments beyond the brainstorm.

## What remains for implementation to prove
Browser drill items in stage 5 (collapse, filter-empty headers, auto-expand, no run-filtered) + checks green.
