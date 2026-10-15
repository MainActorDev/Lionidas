# Phase 3 — Factory migration of system status

- Source prompt: “create a new branch and commit. then go to the next phase” (after the `/audit` sticky-header QA cycle).
- Created: 2026-10-15T09:39:24Z
- Status: Questions open — Factory composition not yet selected

## Goal and context

Move the existing `/status` page into the approved Factory design language and extend the local visual/accessibility QA gate to this migrated route. The operator's task is to answer **what is broken, why, and how recent the observation is** without inspecting a database. This is a UI migration, not a new monitoring backend.

## Confirmed inputs and decisions

- The Phase 2 plan explicitly ranks `/status` next and requires a fresh brainstorm → plan → review chain (`plans/20261015T044600Z-phase2-shadcn-foundation-pilot-plan.md`, Task 5). The user has now asked to proceed.
- Factory dark is the approved visual source: `web/src/styles/tokens.css` and `theme.css`; sidebar/topbar belong to the app shell. No bright fills, shadows, weight above 500, or decorative orange/green. Light values are registered but not activated.
- `/status` and `GET /api/status` already exist. The server returns `checkedAt`, `cached`, and an array of `{ id, name, state, summary, detail }` systems. It reads tables, not live simulator/provider probes (`server/src/routes/status.ts`). A build-config canary is present when the projects table is available; never assume there are exactly six cards.
- User decisions from the original status plan: operator-only access, status under the `system` nav group, table-derived engine state, honest degraded thresholds. The earlier Axiom-era design choice was split master–detail (sketch 034-C); that choice is evidence about the desired diagnostic journey, not a blanket approval for a new Factory layout.
- Existing client behavior: refresh every 15 seconds while visible, reload on tab return, show `cached` and age, retain selected system (`web/src/pages/StatusPage.vue`). Keep that contract unless a specific defect is fixed and tested.
- QA is local-first/self-hosted. The current harness covers `/` and `/audit` at 375/1440 in dark/light, with scroll/open states where applicable (`web/e2e/`). Add `/status` only with deterministic status data and reviewed screenshots; no GitHub Actions dependency.

## Exploration

Three **proposed** compositions, all using the real Factory palette and shell, with representative—not live—status values:

1. **Diagnostic workspace (split).** Narrow list of systems and their states at left, selected system's reasons/metrics at right; freshness and thresholds remain visible. Best for diagnosing one incident and closest to the previously chosen C layout. Trade-off: scanning all reasons requires selecting systems; mobile must stack list and detail without losing the active context.
2. **Signals ledger (rows).** One dense row per system with state, summary, and the most important reason; clicking expands its full facts/thresholds inline. Best for seeing several problems at once. Trade-off: a long detail list can make the page taller and less stable under polling.
3. **System board (cards).** A compact severity summary followed by a responsive set of system tiles; selecting a tile reveals the full details below. Best for at-a-glance monitoring. Trade-off: cards can waste space and push explanations below the fold; must avoid decorative accent panels.

**Proposal, not a decision:** start from diagnostic workspace because the user previously picked a split for the status task. Compare the three rendered variants before choosing; do not implement the proposal on that inference alone. Treat external design-guide palette suggestions as hypotheses; they do not override the locked Factory tokens.

### Risks and acceptance direction

- `cached: true` must never look like a fresh live probe. `checkedAt` must label the actual observation, not just the latest poll. A failed refresh must remain visibly an error even if prior data remains on screen.
- Dynamic detail keys include long values, booleans and null. Preserve the full value (wrap or reveal); no secrets or invented diagnostics.
- State is text plus shape/label, not color alone. Verify keyboard selection, focus visibility, reduced motion, 375/768/1024/1440 fit, light contrast, loading/empty/403/error states and the 15-second hidden-tab pause. Axe is a floor, not the whole accessibility check.
- The normal route screenshot must use fixed `checkedAt` and `page.clock.setFixedTime(ANCHOR)` so relative age labels do not rot. Changes to the shared shell are out of scope unless required by a verified defect.

## Open questions

1. Which Factory composition should be the implementation contract: split diagnostic workspace, expanding signals ledger, or system board? This changes the information hierarchy and component structure. The existing C choice for an earlier visual system is not silently carried forward.

## Next step

Render three complete, interactive shell-inclusive sketches and inspect them at desktop and mobile. Ask the user to pick a direction. Then write the confirmed implementation plan, self-review it, obtain the normal human gate, and implement plus extend the Playwright route table.
