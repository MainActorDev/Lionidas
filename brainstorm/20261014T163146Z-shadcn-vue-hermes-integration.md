# shadcn-vue knowledge and Hermes integration

- Source prompt: “Learn everything about this UI library for Vue @url:`https://www.shadcn-vue.com/docs/introduction` And install the agentic skills and MCP server to Hermer after”
- Follow-up prompt: “@url:`https://www.shadcn-vue.com/docs/directory` Can you also install the ai-element from this directory”
- Revamp prompt: “I want to fully revamp Lionidas UI” for less UI/UX hassle or bugs, faster development, responsiveness; prioritize pages easiest to hardest and report the list.
- Visual-direction decision: “Intentionally replace that visual language.”
- Design-reference decision (2026-10-14): user supplied a Linear style reference (`LINEAR.md` attachment — midnight dark, near-black surfaces, Inter Variable, single acid-lime action accent, hairline borders, compact density) and stated “I still prefer the sidebar menu.” Round 036's three invented concepts are superseded: the new visual language is **Linear-based**, and navigation keeps a **sidebar**.
- Phase-1 approval (2026-10-14): user approved **Phase 1 (Factory Design System Foundation, CSS-only)** — Option A. shadcn-vue integration is deferred to the Phase 2 opener ("shadcn foundation" task: Tailwind v4 + components.json + Factory-mapped theme vars), so the two verification surfaces stay separated.
- Standing workflow directive (user, 2026-10-14): **every phase from Phase 2 onward must run brainstorm → plan → review → implement.** No phase may skip straight to implementation.
- Fourth-round correction (2026-10-14): the brightness rejection **includes the white hero verdict card**. The verdict card is now a carbon panel (`#1d1a18`, ash border, bone word, orange pulse); the dialog confirm was also darkened. Verified: zero bright-background elements remain anywhere in the mockup. **factory-sidebar is the approved visual language — all-dark chrome, Geist/Giest Mono type, status-only orange/green accents.**
- Created: 2026-10-14T16:31:46Z
- Status: Questions open

## Goal and context

**User-confirmed:** Understand the linked Vue UI system, then install its agent-facing skill and MCP server in Hermes (“Hermer” interpreted as Hermes). The later goal is a **full Lionidas UI revamp** to reduce UX hassle/bugs, speed development, and improve responsiveness, ordered easiest page to hardest. The user has **explicitly decided to replace** the existing Axiom visual language; its old palette, mono-first typography, hard corners and composition rules are not requirements for the new design. **Interpretation, not yet approved:** Use the installed libraries as composable building blocks rather than blindly replacing every page; “responsiveness” may mean layout across widths, UI reaction speed, or both. No production UI migration has been authorized in this brainstorm turn.

## Confirmed inputs and decisions

- The linked introduction describes shadcn-vue as a code-distribution approach, *not* a conventional imported component package. The CLI copies accessible, composable Vue component source into each project so it can be changed locally. Source: official introduction.
- The official Skills page provides one `shadcn-vue` skill and describes project context, CLI, theming, registry patterns, and MCP usage. Its source bundle includes `SKILL.md`, `cli.md`, `customization.md`, `mcp.md`, and four files in `rules/`. Sources: official Skills page and `unovue/shadcn-vue` repository.
- The official MCP page exposes a stdio server through `shadcn-vue mcp`, with registry discovery, search, examples and view. Current source code exposes seven tools; its “add command” tool **returns a command**, rather than installing by itself. Source: official MCP docs and CLI source.
- This repository is a pnpm workspace containing a Vue 3 / Vite web app (`web/package.json`) but no `components.json`. Source: local manifest and repository scan, 2026-10-14. No current shadcn-vue project configuration can be inferred.
- **Follow-up, user-confirmed:** The user asked to install “ai-element” from the directory linked at `https://www.shadcn-vue.com/docs/directory`. The directory identifies **AI Elements Vue**, a registry/integration rather than one single component. Source: directory entry and AI Elements Vue documentation.
- **Verified runtime discovery:** The already-installed `shadcn-vue@2.8.2` CLI searches `@ai-elements` successfully; a read-only query showed 137 registry entries and the first results (`agent`, `artifact`, `attachments`, `audio-player`, `canvas`). The current repo still has no `components.json`. Source: CLI output and local scan.
- **Verified Hermes integration:** Registered AI Elements Vue's official remote MCP endpoint (`https://registry.ai-elements-vue.com/mcp`) under `ai-elements-vue`, no authentication. `hermes mcp test` discovered its two tools (`get_ai_elements_components`, `get_ai_elements_component`); calling the list tool through an independent MCP client returned component names without error. `hermes mcp list` and config readback confirmed it is enabled. Source: Hermes CLI and live MCP result.

- **Revamp intent, user-confirmed:** Reduce UI/UX hassle and bugs, accelerate development, and improve responsiveness. The requested deliverable now is an easiest-to-hardest page order, not implementation.
- **Visual language, user-confirmed:** Intentionally replace the existing Axiom visual language (user reply, 2026-10-14). This answers the previous preserve-versus-replace question; it does **not** approve a particular color palette, preset, layout, typeface, or implementation.
- **Repository evidence:** `web/src/router.ts:27-47` declares 21 routed pages. `web/src/App.vue:39-151` owns shared navigation, role visibility, header and route shell; `/guide` remains routed but is hidden from navigation. `web/src/styles/tokens.css:1-76` defines the existing Axiom visual language. `web/src/styles/layout.css:113-117` hides the sidebar below 768px, while `App.vue` shows no replacement mobile navigation. This is a shell-wide navigation issue to address before claiming mobile readiness, not a reason to alter page order by itself.
- **Framework baseline:** `web/package.json:14-38` contains Vue 3, Vite and Pinia, but no shadcn-vue components or Tailwind integration; the repository scan found no `components.json`. A real project integration would need a separate dependency/theme decision. Source: local manifest and file search.

## Exploration

**Library model.** A project-specific `init` creates `components.json`, sets aliases, CSS/theme tokens and dependencies; `add` copies individual component source. Vue frameworks include Vite and Nuxt (also Astro and Laravel integrations). Components use composable APIs, Reka UI primitives, Tailwind CSS, and semantic CSS variables (e.g. `--primary`/`--primary-foreground`, `--radius`) for light/dark themes. The config controls framework, icon library, style, import paths and registry namespaces. The CLI supports `init`, `add`, `search`, `view`, `docs`, `info`, `apply`, `build`, and migrations. Presets and registries are opt-in choices. The official skill prefers existing components, correct composition/accessibility, semantic colors, and checking docs before use. Sources: introduction, installation, theming, CLI, components.json, Skills, and official skill source.

**Option A — agent tools only (proposed and chosen for this request).** Install the upstream skill bundle into the active Hermes profile and register a pinned-version shadcn-vue MCP server. Benefits: future agent knowledge and registry queries without changing project code or lockfiles. Constraint: the MCP server uses its process working directory for project-specific `components.json`; global registration does not magically select whichever repository is later discussed. This repo's project-registry query may therefore say “not configured.” The follow-up extends this direction: AI Elements Vue has a separate hosted, read-only component-docs MCP (two tools), now installed in Hermes. The `@ai-elements` registry was already accessible to the shadcn-vue CLI; neither action copies components into the Vue app.

**Option B — initialize shadcn-vue inside this Vue app (not chosen).** Enables direct project-aware component operations but changes the project's dependencies, Tailwind/theme architecture, CSS, and generated components. This is a design and migration decision, not part of the explicit installation request.

**Security/validation (verified outcome).** The official upstream skill was installed through Hermes's scanner as `software-development/shadcn-vue`; it contains all eight upstream files and passed a SAFE scan. The npm package metadata names the official `unovue/shadcn-vue` repository and has no package-level install hooks; `shadcn-vue@2.8.2` was installed in isolated `~/.hermes/tools/shadcn-vue` with scripts disabled. There is **no evidence from these checks that the skill or package is malicious**; this is not a guarantee of absence. `npm audit --omit=dev` reports **11 affected package entries (6 high, 5 moderate)**, cascading from **two underlying advisories**: `braces@3.0.3` (GHSA-vfj7-8cjw-p6xm, high, deeply nested patterns can crash Node, unpatched at check time) and `decode-uri-component@0.2.2` (GHSA-vcc3-ghjq-m6fr, medium, excessive CPU on malformed input, patched upstream at 0.5.0 but the parent requires `^0.2.0`). They concern denial of service, not known malicious behavior, code execution, or credential theft. The user clarified that their question was **malice**, not whether the audit was vulnerability-free; the original install request therefore proceeded, without treating the advisories as resolved. `hermes mcp add shadcn-vue` enabled all seven tools; a separate `hermes mcp test` reconnected and discovered all seven, and `hermes mcp list` confirmed enabled status. No repo dependencies or UI were changed; restart or start a new Hermes session to load tools.

## UI revamp: provisional strategy and page order

**Ordering method (proposal, not a user decision):** rank *migration risk and testing effort*, not source-file length alone. A route with streams, write actions, security, device control, or many child panels is harder than a read-only route. This is a code-inventory assessment, **not** a usability study or time estimate. All 21 routed pages are listed below; `Guide` is intentionally hidden in navigation, while Login/Setup are public and Cockpit owns its fullscreen chrome.

| # | Route / page | Why this position |
|---:|---|---|
| 1 | `/tickets/:key` — acceptance matrix | 53-line, one-fetch read-only table; lowest behavior footprint. It is a deep link, so validate with a real ticket. |
| 2 | `/audit` — audit log | One paged/filterable table and one endpoint; exercises reusable list/filter/responsive patterns. Requires supervisor access. |
| 3 | `/guide` — guide **(defer while hidden)** | Largely static navigation/content, but long and currently deliberately hidden; easy technically, low rollout value. |
| 4 | `/status` — system status | Read-only master/detail with one API, but 15-second polling, cached/stale labeling and visibility transitions must survive. |
| 5 | `/settings` — configuration | Admin-facing readiness/config controls; limited page scope, but protect writes and error feedback. |
| 6 | `/` — overview | Summary/read-heavy front door; live refresh and “run all” actions make it riskier than passive pages. |
| 7 | `/runs` — run history | Filters, pagination, live updates and abort action. |
| 8 | `/projects` — projects | Create/edit and package associations; reusable form/table patterns, validation and permissions. |
| 9 | `/suites` — suites | Grouped lists and suite editor/member ordering, more interaction than Projects. |
| 10 | `/builds` — builds | Build triggering, logs and asynchronous progress/failure states. |
| 11 | `/env` — environment | Variable editing, scope/precedence and sensitive values raise error cost. |
| 12 | `/users` — users | RBAC and account/token actions; security-sensitive despite modest page size. |
| 13 | `/login` — sign in | Small form but public auth/Jira flow and redirect behavior must not regress. |
| 14 | `/setup` — first-run setup | Small form but one-time admin provisioning and unclaimed-instance handling make failure expensive. |
| 15 | `/runs/:id` — run detail | Evidence/triage, media and live state depend on several child panels. |
| 16 | `/screens` — screens | Large registry editor plus screen/login/logout panels and state workflows. |
| 17 | `/devices` — device wall | Live device preview/control, device sidebar and stream/layout constraints. |
| 18 | `/agent` — agent chat | Chat streaming, composer, queue, markdown, attachments and permissions; AI Elements Vue fits selectively here. |
| 19 | `/templates` — test cases | 1,341-line page plus editors, run panel, evidence, package picker and many write/play paths. |
| 20 | `/forge` — network control | Proxy, captures, scenarios and presets with many coordinated endpoints and failure modes. |
| 21 | `/cockpit` — cockpit | Fullscreen live device workspace with many panes, gestures, streaming and session ownership; hardest to regress safely. |

**Two sequencing choices.** A big-bang restyle might make pages look consistent quickly but multiplies behavior regressions and obscures where bugs arose. **Proposed direction:** one small real-data pilot (matrix first for literal easiest-first, or audit if an accessible representative table is more useful), then a shared shell/token/responsive contract, then migrate in the order above, one approved page at a time. A shell-only first pass fixes mobile navigation but does not exercise form/table primitives; a pilot before shell finds those integration issues without changing every page. Keep `/guide` deferred unless its visibility changes. Preserve endpoint payload semantics, live stream identities, keyboard/focus, permissions and loading/error/empty states. Shadcn-vue provides source-owned Vue primitives; AI Elements Vue is useful for `/agent`, not for every route. Neither library alone fixes product UX.

**Validation proposal:** before the first production page, review at least three **structurally distinct** interactive variants, each with its own coherent candidate tokens (not the retired Axiom palette), and choose one (standing Lionidas UI rule). For each approved page, compare task outcomes and regressions against the existing page, test narrow/tablet/desktop widths, keyboard/focus and screen-reader semantics, empty/error/permission/loading states, and run `pnpm run check` and `pnpm run build`. For the shell, demonstrate reachable navigation below 768px; for streaming pages, demonstrate uninterrupted stream/canvas identity across panel changes. Measure time to implement repeated patterns and real task errors rather than treating a library install as proof of faster delivery or fewer bugs.

## New visual language — proposal, not yet selected

**Candidate north star:** *calm operations*: the product should make the current run, problem and next safe action legible immediately, with enough data density for experienced testers. This **replaces** black/ember/mono-everywhere Axiom rather than recoloring it. A local design-system search for “developer tooling QA testing dashboard modern accessible responsive data-dense” suggested a data-dense operations style and light/dark support; that is a design hypothesis, not observed user research or an accepted palette.

**Three concept directions to test in real, interactive previews (different structure as well as styling):**

| Concept | Visual + interaction model | Best fit / cost |
|---|---|---|
| **A. Calm Operations (recommended starting hypothesis)** | Light-first neutral surfaces, one restrained blue/teal action accent, spacious but compact tables; sidebar groups, a clear page heading, status/attention area and inline detail. Dark companion theme. | Balanced daily work and QA triage; needs careful density controls to avoid a bland generic SaaS look. |
| **B. Monitoring Studio** | Dark charcoal (not pure black), restrained surfaces and luminous status signals; wide persistent workspace with strong live-state emphasis and split detail panes. | Long live-monitoring sessions; contrast, screen fatigue and narrow layouts need testing. |
| **C. Dense Workbench** | Neutral high-density table-first canvas, compact toolbars, keyboard-forward commands and adjustable split panes; restrained decoration. | Expert operators authoring cases and investigating failures; higher learning cost and hardest to adapt to touch. |

**Shared system to define *after* a concept is chosen:** semantic tokens (`background`, `surface/card`, `foreground`, `muted`, `primary`, `destructive`, `success`, `warning`, `border`, `focus`) with paired contrast in light/dark; use color **plus text/icon** for run states. Sans-serif as the default reading and control face, monospace only for IDs, YAML, code and logs. A consistent type, spacing, radius, icon and interaction-state scale; explicit density rules for tables versus touch controls. Native-feeling components from shadcn-vue (Reka-based source-owned forms, dialogs, tabs, tables, navigation) only where they reduce custom work; AI Elements Vue only where its chat elements fit `/agent`. Design mobile navigation rather than hiding the desktop sidebar; adapt device controls and test authoring for narrow widths without silently removing existing actions. Favor clear focus/keyboard behavior, recovery states and predictable action feedback over decorative animation. Exact colors, fonts, style preset (e.g. Nova versus Vega), breakpoints and page layouts remain **unselected** until previews and human review.

**Implementation sequence after approval:** (1) Design three complete shell+representative-page concepts at desktop and narrow width using realistic run/status data, not three recolors; (2) user chooses a concept; (3) write one reviewed token/component/shell contract and a small existing-page pilot; (4) integrate Tailwind/shadcn-vue into `web/` only after checking its current styles and dependency impact; (5) migrate pages in the earlier order, preserving real behavior and avoiding mixed old/new styling in any individual page; (6) verify layout, task flows, accessibility and responsive performance with real browser checks. This is a proposal, not an authorization to code or install dependencies now.

## Open questions

1. **Responsive scope (working assumption, not a gate):** Keep every existing action available on phone, tablet and desktop; adapt layout and controls rather than making mobile read-only. Treat interaction speed as part of responsiveness too. If a real preview or test exposes a device-control constraint, bring that specific trade-off to the user then. No speculative phone-use-case decision is needed now.
2. **Pilot data/visibility (execution detail):** `/guide` is currently hidden, and the matrix pilot requires a representative ticket. If no ticket is available, use `/audit` as the first practical pilot. These do not block the visual-language exploration.

## Next step

A **preview-only** plan now exists at `plans/20261014T163146Z-shadcn-vue-hermes-integration-plan.md`, with a self-review at `reviews/20261014T163146Z-shadcn-vue-hermes-integration-plan-review.md`. It is ready for the user's review and approval, not a production implementation approval. If approved, create and verify three structurally distinct full-shell-and-Overview interactive concepts at desktop and narrow widths, show trade-offs, and let the user select or reject the visual language. Only then write a separate implementation plan for tokens, navigation and the first page; no Vue app files or project dependencies have changed under this brainstorm. The earlier Axiom-preservation question is **closed** by the user's explicit replacement decision.

## Security advisory references

- https://github.com/advisories/GHSA-vfj7-8cjw-p6xm
- https://github.com/advisories/GHSA-vcc3-ghjq-m6fr

## Sources

- https://www.shadcn-vue.com/docs/introduction
- https://www.shadcn-vue.com/docs/skills
- https://www.shadcn-vue.com/docs/mcp
- https://www.shadcn-vue.com/docs/cli
- https://www.shadcn-vue.com/docs/theming
- https://www.shadcn-vue.com/docs/components-json
- https://www.shadcn-vue.com/docs/directory
- https://www.shadcn-vue.com/docs/directory/ai-elements-vue
- https://www.ai-elements-vue.com/docs/mcp
- https://www.ai-elements-vue.com/docs/installation
- https://github.com/unovue/shadcn-vue/tree/dev/skills/shadcn-vue
- https://github.com/unovue/shadcn-vue/blob/dev/packages/cli/src/mcp/index.ts
