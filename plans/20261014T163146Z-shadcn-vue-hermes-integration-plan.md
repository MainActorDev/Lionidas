# Lionidas Visual-Language Exploration Plan

- Status: Ready **for concept-preview work only**; not approved for implementation or a full-site migration.
- Source brainstorm: `brainstorm/20261014T163146Z-shadcn-vue-hermes-integration.md` (updated October 14, 2026).
- Decision log:
  - User: “I want to fully revamp Lionidas UI” to reduce UX hassle/bugs, speed development and improve responsiveness (conversation, October 14, 2026).
  - User: “Intentionally replace that visual language” (conversation, October 14, 2026). The current Axiom visual style is **not** a design constraint; no replacement style, preset, colors or page layout have been selected.
  - User correction: the mobile-use-case question did not lead to a decision. Do not make a speculative mobile-only feature cut; show responsive options and escalate only a concrete conflict (conversation, October 14, 2026).

## Objective and boundary

Create inspectable, interactive alternatives for the **new visual language**, then obtain a human selection. The immediate deliverable is three working previews and a comparison brief; only **after** the user's choice is there a chosen direction to document as a token/layout/component contract. This is not production UI or installed project dependencies. Product task outcomes, authorization, data semantics, and existing actions remain unchanged while concepts are explored. There is no agreed delivery date or performance target.

In scope: shell/navigation, a representative existing page, information density, typography, semantic color and status hierarchy, light/dark treatment **as a concept choice rather than a presumed requirement for both themes**, narrow/desktop layout, hover/focus/keyboard states, loading/empty/error affordances. Out of scope: migrating all 21 routes, changing backend contracts, making a theme selection without the user, adding shadcn-vue/Tailwind/AI Elements dependencies to `web/`, or silently restricting mobile actions.

## Verified project context

- `web/src/router.ts:24-49` registers 21 routes; `web/src/App.vue:39-151` supplies shared sidebar, RBAC-aware nav, topbar and route shell. `/cockpit` renders outside that shell; `/login` and `/setup` are public.
- `web/src/styles/tokens.css:1-76` and `web/src/styles/layout.css:1-117` implement the current Axiom system. At <=768px, `.sidebar` is hidden (`layout.css:113-117`), and `App.vue` has no replacement nav. This is an observed layout risk, not proof of any particular replacement design.
- `web/src/pages/OverviewPage.vue:16-23,149-219` provides a real build-verdict, coverage, attention and recent-run information model with actions; `web/src/components/PageHeader.vue:12-21` is the current shared title component. Use these sources to structure a representative preview, not to retain old styling.
- `web/package.json:14-38` is Vue 3/Vite/Pinia without Tailwind or shadcn-vue components; no repository `components.json` was found during the inventory. The Hermes-side skills/MCP registrations are **not** project installation.
- Existing preview conventions live under `sketches/` (most recent observed numbered round: `035-model-picker`). Choose the next free number **at execution time**, because another worker may create one meanwhile. The current project's UI skill requires at least three interactive options before a UI revamp and human selection before implementation.

## Concept-phase work

1. **Establish the comparison contract.** Inspect the live current shell and Overview's data/actions, including role-dependent navigation, error and empty states, so each preview represents the same operator task and information. If a live authenticated state is unavailable, use explicitly labeled illustrative content shaped by the verified page model—never claim it is measured user behavior or a live API result. Record the comparable task, viewport states and controls in the round README.
2. **Prepare three genuinely different concepts.** Explore the brainstorm's *unaccepted* ideas—calm operations, monitoring studio and dense workbench—as starting hypotheses, changing navigation, hierarchy and density as well as palette. Do not lock their names or visual details before inspection. Each variant is a complete shell with representative Overview content and **simulated, locally working preview interactions** (never real run or account mutations), not a disconnected card mockup or three recolors. Give each its own coherent candidate tokens; do **not** carry Axiom tokens forward as a requirement.
3. **Write preview artifacts only after human approval of this plan.** Use `sketches/<next-free-NNN>-lionidas-visual-direction/<variant>/index.html` for three variants and `sketches/<next-free-NNN>-lionidas-visual-direction/README.md` for the comparison. Keep project production files untouched. Each variant demonstrates a desktop width and a narrow phone width, functional nav/menu, primary action affordance, selected status, focus, and one empty/error state; a theme toggle may be included if needed to compare paired themes. Use the same content/roles in all variants for a fair comparison.
4. **Verify the previews, not just their markup.** Serve the round locally and inspect interaction and geometry at narrow, tablet and desktop widths (e.g. 375, 768 and 1440 CSS px). Check main navigation remains reachable, no clipped key actions/horizontal document scroll, keyboard focus order and visible focus, semantic status text plus color, and reduced-motion behavior. The browser checks are preview validation; do not present them as production accessibility or usability proof. If a prototype fails, fix it before requesting a choice.
5. **Present a decision brief.** Show all three working previews side by side with their real differences, best-fit tasks, responsiveness trade-offs, and a reasoned recommendation. Ask the user to choose, combine or reject the concepts. Do not substitute the model's recommended direction for that choice.
6. **After the choice, separate the next gate.** Record the user's accepted direction and create a follow-on plan for tokens, reusable primitives, responsive shell, and the smallest existing-page pilot (matrix if usable with real ticket data; otherwise audit). Review that implementation plan before installing project dependencies or changing production code. The earlier 21-page difficulty inventory guides later migrations but is not itself approval to modify those routes.

## Acceptance of this phase

- At least three separately inspectable interactive concepts cover the **same** shell and representative task, differ materially in structure, and use genuinely new visual languages.
- A narrow and desktop view are observable for each; nav and primary actions remain reachable, with no silent feature removal. Any constrained action is called out explicitly for user decision.
- Each concept has working interactions and inspectable loading/empty/error or permission feedback as appropriate, visible focus, and text/icon accompaniment for status colors.
- README states verified inputs versus invented illustrative fixture content, concept trade-offs, and unresolved risks.
- Human selects or rejects the direction. Until that selection, the full implementation plan remains unapproved; no success claim about reduced bugs, faster development or responsive performance is made without later measurement.

## Risks and gates

- A generic shadcn-vue preset is a component starting point, **not** a visual-language decision. Project installation is deliberately excluded here.
- AI Elements Vue is a candidate for `/agent`, not a reason to recast tables, device previews or run evidence as chat components.
- A preview can hide difficult permissions/live-stream behavior. Preserve the API/role/stream contracts when planning the later implementation; verify those through tests and live drills then.
- Concurrent repository edits already exist outside these documents; do not overwrite them or commit/push as part of concept planning.

## Human gate

Review this concept-phase plan first. Approving it authorizes **preview artifacts only**, not production UI changes, dependency installation, or migration of the ranked routes.
