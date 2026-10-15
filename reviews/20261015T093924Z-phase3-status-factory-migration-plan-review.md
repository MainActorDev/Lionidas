# Review — Phase 3 Factory system status migration

- Plan reviewed: `plans/20261015T093924Z-phase3-status-factory-migration-plan.md` (Pending version, 2026-10-15)
- Sources: `brainstorm/20261015T093924Z-phase3-status-factory-migration.md`; the three `sketches/038-status-factory/` variants; current `StatusPage.vue`, `server/src/routes/status.ts`, the Phase 2 next-page ranking, and the local QA harness.
- Verdict: **Blocked for implementation** — the plan correctly remains Pending until the human picks a Factory composition. This review checks decision coverage, not implementation correctness.

## Coverage and findings

- **G1 · Blocking decision:** A/B/C genuinely differ in hierarchy and mobile behavior. No earlier statement selects among them for the Factory migration. The old sketch 034-C approval belonged to the previous visual system, so promoting A silently would invent approval. **Correction:** ask the user to choose or request a hybrid; record the answer, then turn the same plan Ready and review the revised version again.
- **G2 · Guard for the Ready revision:** Do not hard-code six systems. The current route conditionally appends `build-recipe` when the projects table exists. The pending plan records this. The implementation plan should test six and seven systems, selected-card disappearance after refresh, empty/error/403, cached-age truth and long/null detail values.
- **G3 · Visual/accessibility proof:** The sketches were loaded at 375/768/1024/1440, inspected by vision at 375/1440, and had zero axe WCAG 2 A/AA violations at 375/1440. This does **not** validate the future Vue implementation or all accessibility behavior. The Ready plan must cover keyboard/focus, both themes, responsive overflow, polling/hidden tab, and reviewed Playwright baselines.

## Human question

Which variant should set the production page composition: **A diagnostic workspace**, **B signals ledger**, **C system board**, or a specified hybrid?

## After the decision

Update the same plan with the selected screen contract, code-path ownership, edge-case table, acceptance checks and task order. Re-review that Ready version; implementation then requires the normal human gate. Do not change production status UI yet.
