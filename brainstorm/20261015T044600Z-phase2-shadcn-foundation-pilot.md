# Phase 2 — shadcn foundation + first page pilot

- Source prompt: user approved Phase 1 ("1. It's locked. And do the cleanup 2. Run the full-chain after #1.") with the standing note: "Please ensure the accessibility is good". Standing rule: every phase runs brainstorm → plan → review → implement.
- Created: 2026-10-15T04:46:00Z
- Status: Direction selected (all gates answered; ready for plan)

## Goal and context

**User-confirmed:** Phase 2 = shadcn-vue foundation in `web/` (Option A from the Phase-1 gate) followed by the first page pilot, under the locked factory-sidebar visual language. Accessibility is a first-class requirement, per explicit user instruction. **Interpretation:** Phase 2 delivers (a) Tailwind v4 + shadcn-vue configured with Factory tokens, (b) one real page migrated as the template, (c) accessibility acceptance criteria measured, not assumed.

## Confirmed inputs and decisions

- Visual language LOCKED: factory-sidebar all-dark (`#101010` canvas, `#1d1a18` carbon, ash hairlines, bone text, Geist/Geist Mono, weight ≤500, status-only orange/green, no bright fills, no shadows) — user rounds 1-4, Oct 14 2026.
- Phase 1 SHIPPED on main: token remap + shell + mobile drawer (commit 7a81e1d); lint cleanup (66→0); vitest worker cap (c415bc0). Build green, web tests 104/104.
- shadcn-vue approach verified earlier: `pnpm dlx shadcn-vue init` in `web/`, Tailwind v4 + `@tailwindcss/vite`, Factory tokens mapped into shadcn's CSS-variable theme. CLI/MCP live in Hermes (`~/.hermes/tools/shadcn-vue@2.8.2`); npm audit showed 6 high/5 moderate **in the CLI's own dependency tree** (braces DoS unpatched) — runtime component deps are only `reka-ui` + icon lib.
- **Pilot page DECIDED: `/audit`** — user: "/tickets/:key" not really used anymore; default to /audit (2026-10-15). The audit page is supervisor-gated, filterable (actor/event), paginated (cursor `before`), 118 lines, one endpoint `/api/audit`.
- **Drawer DECIDED: replace** the Phase-1 hand-rolled drawer with shadcn `Sheet` in this phase (user: "Replace", 2026-10-15) — native focus trap + scroll lock serve the accessibility requirement.
- **Theming DECIDED: prepare for theming** (user: "Prepare for theming too", 2026-10-15) — register dark as default AND a light variant in shadcn's theme variables now, so a later light mode is a token flip, not a refactor. Factory reference values stay the source of truth for dark.
- `web/` currently has NO Tailwind, no `components.json` (verified). Vue 3.5, Vite 6, oxlint, vue-tsc.
- Pre-existing on main, NOT in scope: 5 failing server tests / 24 failing files (verified identical on clean main).
- Accessibility baseline risks observed in Phase 1 (facts, to be addressed): `.status` colors carry meaning (orange/green) — need non-color redundancy (symbols exist; verify contrast); focus-visible styles exist on buttons/nav but inputs use border-color change only; drawer has aria-expanded + Esc but no focus trap; Geist Mono at 12px uppercase for labels — verify contrast of `#b8b3b0` on `#101010` (calc: ~7.1:1, passes AA/AAA for normal text; `#8a8380` on `#101010` ≈ 4.6:1, passes AA for normal, fails AAA).

## Exploration

**Option A (proposed): foundation → pilot → a11y audit → gate.** Four-step phase: (1) Tailwind v4 + shadcn init with Factory theme vars, minimal component set (Button, Table, Dialog, Sheet, Select, Badge, Toast/Sonner); (2) migrate the pilot page to shadcn composition, replacing its scoped styles; (3) accessibility drill on pilot + shell (keyboard nav, focus trap in drawer/dialog via shadcn primitives, contrast audit of the token ramp, reduced-motion, screen-reader spot check via axe-core); (4) user sign-off. Benefits: each step verifiable; a11y measured on real code. Risk: two styling systems coexist until pages migrate (scoped CSS + Tailwind) — bounded by migrating the pilot wholesale.

**Option B (not chosen): big-bang Tailwind rewrite of all 21 pages.** Rejected earlier for regression risk; page-by-page in ranked order stands.

**Open sub-questions that shape the plan:** pilot data availability (real ticket vs audit fallback); whether the Phase-1 hand-rolled drawer is replaced by shadcn Sheet now (recommended — it ships focus trap for free) or later; icon library choice for shadcn (`lucide` default vs Factory's line-art minimalism); dark-only vs dark+light theme registration (Factory reference is dark-only — recommend dark-only now).

## Open questions

None blocking — all three gates answered by the user (2026-10-15): pilot = `/audit`; drawer = replace with shadcn `Sheet`; theming = register light variant alongside dark now. Light-mode *activation* (toggle UI, preference storage) remains intentionally out of scope — registering values is the prep, not the feature.

## Next step

Write the Phase 2 plan (`plans/20261015T044600Z-phase2-shadcn-foundation-pilot-plan.md`) covering: Tailwind v4 + shadcn-vue init with Factory-mapped theme variables (dark default + light registered), minimal component set (Sheet, Button, Table, Badge, Select, Sonner), App.vue drawer replacement with Sheet, `/audit` migration as the template page, and the accessibility acceptance drill (keyboard, focus trap, contrast audit incl. light ramp, reduced motion, axe-core). Then plan review, then implement.
