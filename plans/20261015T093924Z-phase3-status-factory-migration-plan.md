# Phase 3 — Factory system status migration — pending plan

- Source brainstorm: `brainstorm/20261015T093924Z-phase3-status-factory-migration.md` (2026-10-15T09:39:24Z)
- Concepts: `sketches/038-status-factory/README.md` and three rendered variants
- Status: **Pending** — composition selection required before prescriptive implementation steps or self-review

## Confirmed scope and evidence

- The Phase 2 plan's next ranked page is `/status` (`plans/20261015T044600Z-phase2-shadcn-foundation-pilot-plan.md:54`). The user has asked to proceed after committing the audit sticky-header cycle (`18df922` on `fix/audit-sticky-qa`). Work for this phase is on `feat/status-factory-phase3`, based on that commit.
- Existing `/status` already fetches `GET /api/status`, polls every 15 seconds only while visible, labels `checkedAt` and `cached`, and renders all returned systems. The API is table-derived, operator-gated and may conditionally include a build-config canary (`web/src/pages/StatusPage.vue`, `server/src/routes/status.ts`). No new server feature is required for the design migration.
- Factory tokens, shell, and shadcn-vue foundation are already present. Do not change the global shell, active dark theme, permission model, endpoint or thresholds without a separately verified reason. No orange/green decoration, bright fills, shadows, or weight >500.
- The local QA gate covers `/` and `/audit` with visual + axe checks at 375 and 1440; `/status` must be added to the route table with deterministic API fixtures and reviewed baselines, plus keyboard and responsive drills (`web/e2e/README.md`, `ui-qa-gate` skill). No paid CI/SaaS dependency.
- The original Axiom-era status page chose a split master-detail composition (sketch 034-C). This is useful evidence of intent, but the new Factory composition has not been approved.

## Decision required

**Choose the Factory composition:**

- A — diagnostic workspace: selected subsystem list + persistent detail pane (closest to prior selection).
- B — signals ledger: all systems' key signals visible, with inline expansion.
- C — system board: glance-first tiles, full selected detail below.

This choice changes the component hierarchy, responsive behavior, keyboard semantics and acceptance screenshots. The brainstorm recommends A as a proposal, not as an accepted requirement. The rendered sketches are available in `sketches/038-status-factory/` and served locally on port 8794.

## Next step

After the human picks a variant (or requests a hybrid), record that decision and turn this same artifact into a Ready implementation plan with a code-path inventory, edge-case table, acceptance checks, self-review, and the normal human gate. Do not implement the production page based only on the recommendation.
