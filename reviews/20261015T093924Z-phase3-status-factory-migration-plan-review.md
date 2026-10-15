# Review — Phase 3 Factory system status migration

- Plan reviewed: `plans/20261015T093924Z-phase3-status-factory-migration-plan.md` (Ready revision after the user's “C” selection, 2026-10-15)
- Evidence: updated brainstorm; selected `sketches/038-status-factory/c-system-board/index.html`; `server/src/routes/status.ts`; `web/src/pages/StatusPage.vue`, `router.ts`, `App.vue`; current status and visual-harness tests. A live browser probe confirmed the light-capture issue (pre-mount removal leaves `.dark` on after `App.vue` mounts).
- Verdict: **Ready for human approval, not yet approved for execution.** The plan is sufficiently specific; no material design question remains. This review checks the proposal and test seams, not implementation behavior.

## Traceability

- User decision **C** → responsive tile board, selected observations, mobile tile-to-detail transition, and both states in reviewed screenshots. A/B are excluded.
- Earlier status decisions → operator gate, table-derived signals, existing thresholds and visibility-aware 15s polling remain; no live probes or new monitoring policy.
- Factory and QA decisions → dark-first tokens, unchanged shell, status-only accents, local Playwright route addition, axe/keyboard/vision gates and no paid CI dependency.

## Findings and corrections

- **H1 · Corrected in Ready plan — C needs data not in the API.** `StatusCard` currently has only `summary` and raw `detail`; neither supplies a canonical per-tile cause or per-system rule. Client-side prose would duplicate health policy and drift. The plan proposes *additive* required `signal` and `rule` fields emitted from the same server branches that compute health, with tests for all six systems, the conditional canary, no raw error/secret leakage and unchanged state transitions. This is the main scope increase to approve; if rejected, revise the C sketch/data contract rather than hiding depicted information.
- **H2 · Corrected in Ready plan — light suite false-green.** `visual.spec.ts` removes `.dark` before mount, while `App.vue:onMounted` adds it again. Browser measurement after mount: `dark=true`, background `#101010`; removal afterward: background `#fafafa`. Stage 0 explicitly moves the test toggle after route readiness, asserts the computed token and reviews new light baselines for existing migrated routes. A green test without this assertion is not evidence of light parity.
- **M1 · Bounded trade-off — mobile C details below the fold.** This is visible in the chosen sketch. The plan preserves the full board rather than collapsing its contents, scrolls pointer selections to details under the sticky topbar, and provides keyboard focus/announcement on selection. Verify at 375px including reduced-motion and long values; do not declare it visually solved from DOM geometry alone.
- **M2 · Conditional seventh subsystem and selection churn.** Server appends `build-recipe` only when `projects` exists; the old page selects first id and can leave a blank detail if that id disappears. Plan covers six/seven arrays, severity-first initial selection, stable selection on poll, and fallback when a selected card disappears. Unit and E2E cases are named.
- **M3 · Error honesty and race.** Plan distinguishes 403 (clear previously authorized data) from network/5xx after prior success (retain but label stale), pins `checkedAt` to the server observation and prevents late responses from overwriting newer ones. Tests use deferred responses and fake timers; no new server cache behavior is assumed.

## Verification limits

The sketches had browser geometry and vision checks at 375/1440, with axe WCAG 2 A/AA reporting zero violations. This does not certify the Vue implementation, all screen-reader behavior, or a real API drill. The Ready plan names those as execution gates. Targeted server status tests do not equal the full server suite; Node 24 and bounded Vitest are available, but no implementation tests have been run for this revision.

## Human gate

Approve **C with the additive server `signal`/`rule` contract and the light-harness correction**, or request a plan revision. No production code change, push, PR or merge is authorized by the design pick alone.
