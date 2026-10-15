# Review: Phase 2 — shadcn foundation + /audit pilot plan

- Verdict: **Ready for implementation** after two plan corrections applied during this review (recorded below). One Medium finding remains, disclosed and non-blocking.
- Plan reviewed: `plans/20261015T044600Z-phase2-shadcn-foundation-pilot-plan.md` (initial write, 2026-10-15).
- Sources: brainstorm `20261015T044600Z-phase2-shadcn-foundation-pilot.md` (user gates: /audit pilot, Sheet replacement, light values registered); Phase-1 shipped state (commits 7a81e1d, c415bc0); repo facts verified live (AuditPage.vue script/UI inventory, no Tailwind/components.json in web/, existing alias `@/` in tsconfig).

## Traceability

Every user decision maps to a task: /audit pilot → Task 3; Sheet replacement → Task 2; theming prep → Task 1 theme.css (light registered, dark active, activation UI explicitly out of scope — correctly a prep, not a feature). Accessibility (user's standing note) is Task 4 with measured acceptance, plus free wins from reka-ui primitives in Task 2. Scope discipline holds: server untouched, 5 pre-existing failing server tests excluded, page ranking preserved for Phase 3.

## Findings

- **C1 · Corrected during review — CLI version pin.** Plan said `pnpm dlx shadcn-vue@2.8.2 add …` only in Task 3 but the init step risked floating `@latest`. The audited CLI version is 2.8.2 (braces advisory context); the plan now pins `@2.8.2` wherever the CLI runs. Verify: grep the plan/logs for `shadcn-vue@` — all pinned.
- **C2 · Corrected during review — visual-baseline guard order.** Task 1's "unmigrated pages unchanged" check originally relied on Task 3 not existing yet; the correct moment is immediately after Task 1 (theme.css import) AND after Task 2 (App.vue edit), since both touch global surfaces. The plan's verification steps now state the screenshot-diff runs at both points. Verify: Task 1 step 6 and Task 2 step 4 wording.
- **M1 · Medium, disclosed — light-ramp values are invented.** The `.dark` block is the Factory source of truth, but the `:root` light values in Task 1.4 are my proposal (paper/ink inversions), not user-approved design. Consequence: if light mode is ever activated, its look was never reviewed. Mitigation already in plan: light is registered-only; activation (toggle UI) is out of scope; Task 4 audits its contrast regardless. Follow-up: a light-mode concept round before any toggle ships.
- **M2 · Medium — axe-core is a floor, not proof.** axe catches ~30-40% of WCAG issues; the keyboard walkthrough and contrast math carry the real weight. Already structured that way (Task 4.3 is manual+scripted); reviewer confirms no claim of "fully accessible" beyond what's measured.

## Verification plan soundness

Acceptance criteria are executable as written: check/test commands exist and passed at Phase 1; the screenshot-diff and stubbed-API drill reuse the proven Phase-1 Playwright harness; contrast is computed from rendered pairs, not token files alone. One gap accepted: no dedicated vitest for AuditPage logic — mitigated by keeping the script section byte-identical (Task 3.1) and the browser drill exercising filter/pagination/cursor against stubs.

## Questions for the human

None blocking. Optional preference (does not gate): icon set — plan assumes `lucide-vue-next` (shadcn default; line-art, close to Factory's minimal SVG voice). Say otherwise before Task 1 if you want `tabler`/`hugeicons`.
