# Review: Lionidas Visual-Language Exploration Plan

- Verdict: **Ready for concept-preview work, subject to human approval.** Not approval for production UI migration.
- Reviewed plan: `plans/20261014T163146Z-shadcn-vue-hermes-integration-plan.md`, SHA-256 `876bc3b98a35c394d1d9d53dbe08415ffa6e83eff948d9c51da60825d4915db6`.
- Source: `brainstorm/20261014T163146Z-shadcn-vue-hermes-integration.md` (user decision to intentionally replace Axiom; goals of usability, development speed and responsiveness).
- Project evidence checked: `web/src/router.ts`, `web/src/App.vue`, `web/src/styles/layout.css`, `web/src/styles/tokens.css`, `web/src/pages/OverviewPage.vue`, `web/src/components/PageHeader.vue`, `web/package.json`; preview directory inventory in `sketches/` (October 14, 2026).

## Scope and traceability

The plan limits the next authorization to three full-shell-and-Overview **interactive preview** alternatives and a comparison brief. It does not choose a visual language, install project dependencies, edit the current Vue UI, or infer a mobile feature cut. The shell preview directly addresses the verified missing replacement navigation under 768px. The decision brief and human selection gate prevent a brainstorm recommendation from becoming an accepted palette or preset silently.

## Findings

- **No open Critical or High plan defects for this preview-only scope.** The initial draft conflated the preview phase with an accepted design contract, implicitly required both themes, and did not clearly prohibit real run/account mutations in prototype interactions. These were corrected in the exact plan version reviewed; the phase now uses simulated interactions and leaves theme selection to the user.
- **M1 · Medium, disclosed limitation — previews are not measured UX outcomes.** Location: acceptance and risks sections. Evidence: the only verified product input is the current code and the user's broad goals, not observed operator behavior or baseline error/time data. Consequence: an attractive concept could still fail to improve bugs or development speed. Correction already included: compare real task and state coverage, label fixtures, and defer outcome claims to later measured implementation/research. Verify by checking the preview README and later implementation acceptance gates before making outcome claims.
- **M2 · Medium, execution prerequisite — authenticated sample data may be unavailable.** Location: step 1. Evidence: `OverviewPage.vue` describes a live API model but this planning pass did not fetch a live authenticated response. Consequence: the preview may use illustrative records. Mitigation already in plan: validate against page model and label illustrative content rather than inventing a live result. Verify README provenance and equal fixtures across concepts.

## Human questions

No additional product decision blocks **creating alternatives**. The human must approve this limited preview phase before files are created, then select or reject a visual concept before token or production UI work. If the user instead wants a different representative page, amend the plan first.

## What remains to validate later

Browser geometry and keyboard operation at narrow/tablet/desktop widths, actual role-dependent navigation, live data and action behavior, accessibility beyond automated checks, Tailwind/shadcn-vue integration impact, stream identity, and whether real users complete tasks with fewer errors and less time. These are not certified by a paper review or the eventual sketches.
