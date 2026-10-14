# shadcn-vue knowledge and Hermes integration

- Source prompt: “Learn everything about this UI library for Vue @url:`https://www.shadcn-vue.com/docs/introduction` And install the agentic skills and MCP server to Hermer after”
- Created: 2026-10-14T16:31:46Z
- Status: Direction selected

## Goal and context

**User-confirmed:** Understand the linked Vue UI system, then install its agent-facing skill and MCP server in Hermes (“Hermer” interpreted as Hermes). **Interpretation:** Install in the active, default Hermes profile for future work; do not migrate this repository's existing UI or add components without a separate request.

## Confirmed inputs and decisions

- The linked introduction describes shadcn-vue as a code-distribution approach, *not* a conventional imported component package. The CLI copies accessible, composable Vue component source into each project so it can be changed locally. Source: official introduction.
- The official Skills page provides one `shadcn-vue` skill and describes project context, CLI, theming, registry patterns, and MCP usage. Its source bundle includes `SKILL.md`, `cli.md`, `customization.md`, `mcp.md`, and four files in `rules/`. Sources: official Skills page and `unovue/shadcn-vue` repository.
- The official MCP page exposes a stdio server through `shadcn-vue mcp`, with registry discovery, search, examples and view. Current source code exposes seven tools; its “add command” tool **returns a command**, rather than installing by itself. Source: official MCP docs and CLI source.
- This repository is a pnpm workspace containing a Vue 3 / Vite web app (`web/package.json`) but no `components.json`. Source: local manifest and repository scan, 2026-10-14. No current shadcn-vue project configuration can be inferred.

## Exploration

**Library model.** A project-specific `init` creates `components.json`, sets aliases, CSS/theme tokens and dependencies; `add` copies individual component source. Vue frameworks include Vite and Nuxt (also Astro and Laravel integrations). Components use composable APIs, Reka UI primitives, Tailwind CSS, and semantic CSS variables (e.g. `--primary`/`--primary-foreground`, `--radius`) for light/dark themes. The config controls framework, icon library, style, import paths and registry namespaces. The CLI supports `init`, `add`, `search`, `view`, `docs`, `info`, `apply`, `build`, and migrations. Presets and registries are opt-in choices. The official skill prefers existing components, correct composition/accessibility, semantic colors, and checking docs before use. Sources: introduction, installation, theming, CLI, components.json, Skills, and official skill source.

**Option A — agent tools only (proposed and chosen for this request).** Install the upstream skill bundle into the active Hermes profile and register a pinned-version shadcn-vue MCP server. Benefits: future agent knowledge and registry queries without changing project code or lockfiles. Constraint: the MCP server uses its process working directory for project-specific `components.json`; global registration does not magically select whichever repository is later discussed. This repo's project-registry query may therefore say “not configured.”

**Option B — initialize shadcn-vue inside this Vue app (not chosen).** Enables direct project-aware component operations but changes the project's dependencies, Tailwind/theme architecture, CSS, and generated components. This is a design and migration decision, not part of the explicit installation request.

**Security/validation.** Use the official `unovue/shadcn-vue` skill bundle rather than a lookalike package. The npm CLI package is maintained by the upstream repository; installing the CLI pulls a large dependency tree, so pin the audited version and avoid install scripts. Register through `hermes mcp add`, not a direct config edit. Verify skill contents, MCP handshake, discovered tools, and read back the Hermes registration. The agent skill and MCP should be usable without running `mcp init`, which would change unrelated editor/project config.

## Open questions

- **For a later, separate project integration:** Should the existing `web/` app adopt shadcn-vue, and if so which preset/theme and which components? This matters because `init` changes production CSS, dependencies and UI assumptions. It does not block installing Hermes tooling.
- **For project-aware MCP behavior:** Which future Vue project should be the MCP server's working directory? A global server inherits its Hermes process CWD, so registries and config are not automatically routed by chat context. This does not block registry exploration.

## Next step

Install the official skill bundle and pin/register the MCP server in the active Hermes profile, test registry access without modifying this repository, then decide separately whether to adopt the library in a specific Vue app.

## Sources

- https://www.shadcn-vue.com/docs/introduction
- https://www.shadcn-vue.com/docs/skills
- https://www.shadcn-vue.com/docs/mcp
- https://www.shadcn-vue.com/docs/cli
- https://www.shadcn-vue.com/docs/theming
- https://www.shadcn-vue.com/docs/components-json
- https://github.com/unovue/shadcn-vue/tree/dev/skills/shadcn-vue
- https://github.com/unovue/shadcn-vue/blob/dev/packages/cli/src/mcp/index.ts
