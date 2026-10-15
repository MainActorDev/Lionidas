# Phase 4 — Factory overview migration — implementation plan

- Source brainstorm: `brainstorm/20261015T145321Z-phase4-overview-factory-migration.md` (updated with the user's pick)
- Visual contract: `sketches/041-overview-factory/a-band-verdict/index.html` — user chose **A (band verdict)**, with one addition: **latest runs capped at 5 rows** (was 8)
- Status: **Ready for self-review and human approval**

## Decision and outcome

`/` is rebuilt in the migrated-page Factory language (scoped CSS, band verdict): `/status`-style verdict band (17px word + state dot + mono sub-line + right-aligned attention stamp), tightened coverage strip (mono numbers over caption labels), attention + latest-runs as hairline row lists in audit-row grammar, plan chips above the band. The shell, data contracts, live-refresh behavior, and all actions (run-all, plans, deep links, `/?watch=` forwarding) are preserved. `latestTop` slice changes 8 → **5** (user decision this turn; the comment and e2e fixture follow).

## Task list

1. **`web/src/pages/OverviewPage.vue` — template + scoped styles only.**
   - Verdict: replace `.ov-verdict` display block with the A band grammar (`.band`: flex, `padding: 17px 0 15px`, bottom hairline; `.overall` 17px mono-500 word + 8px state dot; `.summary` 12px mono sub-line with the existing `verdictSub` bits; `.stamp` right-aligned attention count — reuse the `/status` page's exact class shapes for cross-page consistency).
   - Verdict color classes map to states: `failed` → orange dot + paper word, `running` → orange word, `no_data`/`passed`/others per current mapping (dot always carries state color; word stays bone except running).
   - Coverage strip: keep 6 cells + responsive behavior; restyle numbers to mono 500 24px, labels 11px mono muted (matches A).
   - Attention + latest runs: audit-row grammar — `76px kind | 1fr name | auto meta` rows, hairline bottoms, carbon hover, cursor pointer. Keep `openAtt`/`openRun` deep links and the empty state ("nothing needs eyes…").
   - Plans chips: keep position (below header, above band); restyle to the A chip shape (mono 11px, hairline, hover border-lighten). Keep `runPlan` behavior + disabled state.
   - Section labels: 10px mono uppercase tracking (`.label` in A).
   - `latestTop` slice 8 → 5; update the "8 rows is a glance" comment to 5.
   - No script logic changes beyond the slice; all existing computed/functions/handlers stay.
2. **Tests.** No existing OverviewPage unit tests (verified — none found). Add a focused `web/src/pages/__tests__/OverviewPage.test.ts`: verdict band renders word + sub-line bits, coverage strip renders 6 cells with alert classes on failed/not-run, **latest runs capped at 5** when fixture ships more, attention rows navigate on click (mock router push), plans chips render + run action fires fetch. Mock `/api/overview` + `/api/plans`; stub `useLiveEvents` (connect/release/watch no-ops).
3. **E2E.** `/` is already in `ROUTES`; the composed page changes, so regenerate the overview baselines (dark+light × 375+1440) in the same commit. Extend the `OVERVIEW` fixture in `web/e2e/routes.ts` to 6 `latestRuns` so the 5-cap is exercised by the screenshot; assert `.runrow` (or the shipped class) count === 5 in the route test is NOT needed if unit test covers it — but the fixture must ship >5.
4. **Verification.** `pnpm --filter web check` green (typecheck/build/lint/unit/e2e). Vision-check the regenerated `/` baselines (dark+light, 375+1440) against sketch A per the ui-qa-gate skill. Drill mobile band + strip wrap at 375.

## Edge cases

| Case | Behavior |
|---|---|
| `status: running` (no pass rate yet) | band word running/orange; sub-line keeps "N running" first bit |
| `passRate: null` / `delta: null` / no previousBatch | sub-line omits those bits (existing `verdictSub` logic unchanged) |
| 0 attention | stamp hidden; "nothing needs eyes" empty state in the list |
| >5 latestRuns | only 5 render (the cap) |
| <5 latestRuns (fresh install) | fewer rows; no placeholders |
| plans empty | chips row absent entirely |
| run-all in flight | button disabled + "starting…" (existing) |
| long case names | ellipsis in the 1fr track (A row grammar) |

## Out of scope

Server/API changes (none — data contract untouched); shell changes; `/status` or `/audit` rework; light-theme activation UI; the wait-step work in the user's tree (untouched).

## Acceptance

- `/` composition matches sketch A at 1440 + 375 (band, strip, chips, two lists); latest runs shows at most 5.
- All existing behaviors preserved: run-all, plan runs, live refresh on run.started/finished, watch-query forwarding, deep links, loading/error/empty states.
- Unit tests for the above pass; full web check green; regenerated baselines reviewed; vision-pass both themes.
