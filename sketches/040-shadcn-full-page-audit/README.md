# 040 — audit log as a full-shadcn page (demo)

**Question:** what does a migrated page look like when *everything* — sidebar, topbar, page header, controls, table, badges, pagination, detail sheet — is shadcn component vocabulary instead of scoped CSS?

`/audit` is the demo surface because it is the richest migrated page: shell + header + search input + segmented view toggle + facet rail + ledger table + event badges + pagination + right detail sheet.

## What is used (shadcn anatomy, Factory tokens)

- **Sidebar** (`data-slot="sidebar"`): brand row, grouped nav with disclosure (aria-expanded), active item, footer — mobile becomes an overlay via the same Sheet mechanism as production.
- **PageHeader** as the shadcn composition (title + description + actions slot) rather than the scoped `.ph` header.
- **Input** (search with leading icon + kbd suffix), **Tabs** as the day/continuous toggle (`role="tablist"`, `data-state`), **Table** (`Table/Head/Row/Body` slots, sticky header, responsive column hiding), **Badge** (event classes), **Button** (pagination, sign out, sidebar trigger), **Sheet** (detail dialog: overlay, focus, Esc, scroll lock, close affordance).

All colors/sizes come from the Factory theme registered as Tailwind theme vars — no `#hex` outside the token sheet. Zero scoped CSS: every rule is a utility or a component slot convention.

## Interactive

Row click/Enter opens the detail sheet; search filters; facets filter with counts; day/continuous toggles grouping; mobile (<768px) nav opens as an overlay; Esc closes overlays.

## What this demo is NOT

Not an approved visual change and not production code — a mechanism demo on top of the already-approved `/audit` composition. If picked, "shadcn-everywhere" becomes a real phase: extract shared components, migrate page-by-page with the QA gate, regenerate baselines per route. The composition itself should stay as approved in 037-A.
