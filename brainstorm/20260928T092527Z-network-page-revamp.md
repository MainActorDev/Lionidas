# Network page revamp — scenario management + page anatomy

- Source prompt: "I want to revamp the 'network' page to improve the UI/UX. Think of better and efficient ways for managing network scenarios and the network page itself as a whole. Overseer the impact and edge cases to the existing test cases scenario. Run the local server for UI sketches." (invoked with /hms-design-evidence-based-ux + /hms-brainstorm-rough-ideas)
- Created: 2026-09-28T09:25:27Z
- Status: Exploring

## Goal and context

The `/forge` page (router title "network") carries three jobs on one screen today: (1) MITM proxy + simulator-routing plumbing (start proxy, route sims, mode: record/hybrid/intercept), (2) **presets** (frozen endpoint responses) and **scenarios** (named preset groups), (3) a live **traffic** log with capture→preset flow. The user wants better UI/UX for managing scenarios specifically, and a rethink of the page as a whole. Constraint from the prompt: changes must overseer impact/edge cases on EXISTING test cases that reference scenarios — and the sketch server must run locally.

Interpretation (not user-confirmed): the scenario manager's inline checkbox/select editor is the primary pain — it renders inside each scenario row, edits are one flat member list with a `<select>` add flow, and the relationship preset↔scenario↔variant is invisible. Also NOT user-confirmed: that presets/traffic need equal redesign weight.

## Confirmed inputs and decisions

- User-confirmed: revamp the network page; scenario management is the focus; run the local server for UI sketches (per skill: python3 http.server on sketches/).
- Verified facts (DB, 2026-09-28):
  - 3 scenarios (countries-sg / countries-my / countries-empty), each 1 member preset, all `immutable_since` set (used by ≥1 run).
  - 3 presets, all `exact` match GET /v1/algo-shipment/route/tariff/destination-recommendation, per-world canned bodies (sg/my/empty). No `seq_json`, no `failure`, no `throttle_kbps`, no guards in use.
  - 12,779 traffic rows captured; latest 2026-09-26.
  - Runs stamp `scenario_id` + `scenario_sha`: 62 sg / 21 my / 21 empty / 789 without. Scenario membership history is replayable (immutable_since).
  - Variants reference scenarios **by NAME** (`variants_json`: `{"id":"sg","scenarios":["countries-sg"]}`); playback resolves id-or-name (`scenarios WHERE id = ? OR name = ?`). Case YAML carries the same name refs.
  - The play-time scenario pick on TestCasesPage is a bare dropdown (fetches /api/forge/scenarios); runs.stamp makes membership immutable AFTER first use (`immutable_since`), so membership edits apply from next play.
  - scenarios table has an unused `launch_arg` column; presets table has unused `seq_json`/`failure`/`throttle_kbps`/`guards_json` capability columns (matcher supports them; UI exposes none).
  - Server surface: `server/src/forge/` (routes 473 LOC, matcher, proxy, sim-routing, state, watchdog); UI = `ForgePage.vue` 455 LOC with PresetEditorModal; router meta.title = "network".

## Exploration

### Measured pain points (evidence-based)

1. **Scenario editor is inline-and-flat**: the membership list renders inside the row, add is a raw `<select>` of non-member presets, enable/disable is a bare checkbox per member. No diff view (what changes next play), no duplicate-as-template, no description/launch_arg editing, no multi-select bulk ops.
2. **Preset↔scenario↔variant triangle is invisible**: the page never answers "which scenarios use this preset?" or "which variants/cases pin this scenario by name?" — delete confirm copy references "saved plans" but shows no names; preset delete has NO confirm at all (raw ✕).
3. **Immutable-after-use is a silent cliff**: `immutable_since` shows a `used` badge, but membership edits to a used scenario are offered with identical affordances as unused ones — the run contract (sha) already stamped can't change, and the UI doesn't make "applies from next play" concrete.
4. **Page anatomy**: three stacked `.card`s (presets / scenarios / traffic) + a detail pane below the fold — the settled house list system (`.a2-list` single box, one sticky thead, group heads) hasn't reached this page. Mode + proxy + routing controls crowd the PageHeader actions row (7 buttons).
5. **Empty-state asymmetry**: traffic empty state is a hand-holding 3-step guide; presets/scenarios empties are one-liners.

### Realistic concepts (axes: information structure & interaction model)

**A — Scenario-workbench (split: library top, workbench right)**
The page becomes a two-pane surface: left = scenarios + presets lists (house list anatomy, group heads by "used/unused"), right = the selected scenario's workbench (member table with per-member enable, diff-from-last-play hint, add-from-presets picker with search, duplicate scenario, description/launch_arg). Traffic moves to its own tab or stays below collapsed.
- Strong at: scenario management depth (the focus ask); answers the triangle by rendering "used by" counts per preset/scenario inline.
- Weak at: traffic live-log loses immediacy; two-pane on a page that also hosts global mode controls needs a control strip rethink.
- Best for: the registry-as-rulebook north star — explicit, complete model surfaces.

**B — Tabs by concern (proxy | scenarios | presets | traffic)**
Split into `.a2-tabs` global: "scenarios" tab (list + inline expansion, house anatomy), "presets" tab, "traffic" tab; proxy/mode/routing live in a status strip under the header (always visible).
- Strong at: clears the header crowding; each list gets full width; least conceptual change from today.
- Weak at: capture→preset flow spans tabs (see traffic row → save as preset → jump to presets); scenario membership still needs a good inline pattern.
- Best for: conservative revamp with low edge-case risk.

**C — Scenario-centric document panel (ScreenDocPanel pattern)**
One document-first editor: scenario list left, selected scenario's live YAML document right (`scenario: countries-sg / presets: [p_1b58…] / launch_arg: …`), form ↔ yaml two-way like the screens page. Presets remain a list; traffic unchanged below.
- Strong at: matches the settled registry direction (machine-readable rulebook, agent-authorable); yaml round-trips through a validator like case/screen yaml.
- Strong at (2): name-pinning edge case becomes visible — the doc literally shows the names variants reference.
- Weak at: biggest build (grammar + validator + panel); scenario model may be too thin today (name + members) to earn a document.
- Best for: if the future AI-agent-authored network scenarios are near-term.

### Impact & edge cases on existing test cases (the prompt's explicit ask)

- **Name-pinned references**: variants_json + case YAML pin scenarios by name; a RENAME re-pins nothing — playback resolves id-or-name so old names in stored cases go dead (resolve to undefined → skip or fail?). Any revamp must either (a) surface referencing consumers before rename (like folder 409 guards), or (b) keep rename but warn with the consumer list. DELETE today warns "saved plans fall back to live traffic" — should name the actual consumers (variants/cases) like the folders delete guard does.
- **Immutable membership**: used scenarios' membership edits apply only from next play (sha stamp). The UI should show the stamped sha vs current sha (a "changed since last play" marker) rather than a bare `used` badge.
- **Play-time pick on TestCasesPage**: the dropdown is scenario-name based; multi-scenario variants (`scenarios: [...]` array in variants_json, playback dedupes by preset id) have NO UI to compose or inspect — editing that array today is raw yaml.
- **Case YAML round-trip**: case yaml carries scenario name refs inside variant blocks; a page revamp must not introduce a second naming scheme (no display-name vs id divergence).
- **Preset delete**: no confirm; deleting a preset that is a member of a used scenario cascades `scenario_overrides` (ON DELETE CASCADE) — the scenario silently loses a member. Needs a guard naming affected scenarios.
- **Traffic table scale**: 12.7k rows — server filter exists (`?q=`), but no time-bounded default window; sketches should not pretend live tail is bounded.
- **Mode is global**: record/hybrid/intercept applies to every request — header copy says so; keep it visible wherever it lands.

### Proposed direction (proposal, not accepted)

**A with B's control strip**: scenario workbench as the page's primary surface (list + workbench split), a persistent status strip for proxy/routing/mode (always visible, not buried in a tab), traffic as a subordinate live feed capped like the overview's glance rule (~recent rows + search), presets folded INTO the workbench (member picker) with the flat presets list demoted to a picker-managed library. Plus the three guards: consumer-aware rename/delete (name the variants/cases), sha-diff "changed since last play" marker, preset-delete cascades named.

Rationale: matches the registry rulebook north star, answers the focus ask (scenario management), and the edge-case guards are cheap server-side (references already live in variants_json + runs).

## Open questions

1. Direction A/B/C — **delegated to the sketch round** (user: "Isn't this exactly where sketches shine?").
2. ~~Traffic's place~~ — **RESOLVED (user): same page, subordinate live feed.**
3. ~~Rename policy~~ — **RESOLVED (user question → agent proposal, pending plan confirmation): id-keyed references.** Playback already resolves `id OR name`; new refs (variant editor, case YAML, agent-authored docs) write the stable `s_…` id; names become freely-editable labels; legacy name refs keep resolving with no migration. Rename hazard dissolves; delete keeps a named-consumer guard.
4. ~~AI-agent weighting~~ — **RESOLVED (user): agent authoring is CLOSE.** The "document" = a per-scenario YAML entry (scenario/presets/launch_arg) the agent reads/writes — same pattern as screen yaml and case yaml. Direction C (document-first) gets full weight in the sketch round.

## Decisions log

- 2026-09-28 user (chat): sketches decide the direction; traffic stays on the page; id-keyed refs acceptable ("can't we use something else for reference key?" — agent answered yes, mechanism verified); agent authoring is close.
- 2026-09-28 user (chat, after sketch round): **PICKED C (document-first) — "document is fine"** with two composition constraints: **(1) the list/UI follows the TestCasesPage anatomy** (single `.a2-list` box, one sticky thead, breadcrumb + folder rows, row click expands the editor inline below the row), **(2) scenarios get the foldering system** (cPanel model) to manage them.
- Agent assumption for the plan (not user-confirmed): scenario folders form a **GLOBAL tree** (root "scenarios") — scenarios have no app binding today (presets match URL patterns, not bundles), unlike app-scoped testcase folders. Flag if wrong.
- Composed variant: `sketches/021-network-page/c2-document-foldered/` (C's document × testcases list anatomy + foldering).

## Next step

Sketch round `sketches/021-network-page/` (served at :8791): A workbench · B tabs · C document-first — all with traffic as a same-page subordinate feed, real DB numbers (3 scenarios, 1 preset each, immutable, 62/21/21 stamped runs), on verbatim Axiom tokens. Pick → `/hms-plan-from-brainstorm` → plan review → build → live drill.
