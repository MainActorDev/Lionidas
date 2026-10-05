# Sidebar menu regroup (Lionidas)

- Source prompt: "I want to revamp the sidebar menu in Lionidas. Regroup the menu for better UI/UX. We can use nested menu. Provide the sketches as usual. Run the local server for the sketches" (with /hms-design-evidence-based-ux)
- Created: 2026-10-05T03:57:16Z
- Status: Direction selected — A (collapsible tree) picked 2026-10-05

## Decisions

- Variant **A — collapsible tree** picked by user (2026-10-05). Taxonomy confirmed
  as sketched: testing / library / system, with `monitoring` under system.
- Collapse state: expanded by default, no persistence — parity with the house
  `.a2-group-head` idiom (which never persists either). Agent decision, low stakes.
- Routes/path names frozen — nav-only change in `App.vue` + `layout.css`.

## Goal and context

The app-shell sidebar (`web/src/App.vue` + `web/src/styles/layout.css`) is a flat
220px rail of 11 destinations in 5 labeled groups. The user wants a regrouping
that improves scannability and hierarchy; nested menus (collapsible or flyout)
are explicitly allowed. Deliverable for this round: ≥3 interactive sketch
variants on real Axiom tokens, served locally, user picks one.

Interpretation (not user-confirmed): this is a navigation-IA change only — no
new routes, no route renames, no new pages. Route paths and names stay frozen.

## Confirmed inputs and decisions

- Current groups/items (read from `App.vue:39-66`):
  - testing: overview, suites, devices, runs
  - quality: test cases, screens, env, monitoring
  - access: users (1 item)
  - network: network (1 item, label repeats the group)
  - help: guide (1 item)
- Routes (read from `web/src/router.ts`): 15 routes; `/login` public, `/cockpit`
  fullscreen (entered from the devices wall "drive" button), `/runs/:id` child of
  runs, `/tickets/:key` (matrix) deep-link only. None of these four are nav items.
- User-confirmed: nested menus are acceptable; sketches + local server wanted.
- House constraints (crucible-web-ui skill, standing): Axiom terminal minimal,
  real `tokens.css` verbatim in sketches, anti-bloat (no captions/count noise),
  next free sketch number 025.

## Exploration

Observed problems with the current flat rail:

1. Three single-item groups (`access`, `network`, `help`) — label overhead with
   zero grouping value; `network` under group `network` is redundant.
2. The taxonomy mixes verbs and nouns: "testing" holds overview (a dashboard)
   and devices (infrastructure), while "quality" holds authoring assets
   (test cases, screens) and runtime config (env) and telemetry (monitoring).
3. 11 flat items + 5 labels = 16 rows of chrome before content.

Candidate taxonomy (shared by all variants, varying only in nesting mechanism):

- `testing` — overview, suites, runs, devices (the daily execution loop)
- `library` — test cases, screens, env, network (the assets tests consume)
- `system` — monitoring, users, guide (telemetry, access, help)

Directions sketched (025-sidebar-regroup):

- **A — collapsible tree**: 3 groups as caret sections (house `.a2-group-head`
  idiom), children indented, groups toggle. Nesting as disclosure.
- **B — index + flyout**: rail shows only 4 rows (overview + 3 group heads);
  children fly out on hover as a graphite panel. Nesting as hover reveal.
- **C — flat merged (control)**: no nesting at all; the same 3-group regroup
  rendered flat. Tests whether regrouping alone fixes the UX.

Not in scope (proposals, not accepted): moving cockpit into the nav (it is
deliberately wall-entered); adding matrix; collapsing the rail to icons.

## Open questions

1. Taxonomy call — does `monitoring` belong under `system` (telemetry) or stay
   with test quality? Variants encode the proposed split; the pick answers this.
2. Should the flyout/tree remember collapsed state per user (localStorage) if a
   nested variant wins? Build-time decision, does not block the sketch round.

## Next step

User picks a variant (or asks for a refinement round); then plan → review →
build in `App.vue`/`layout.css` on a feature branch.
