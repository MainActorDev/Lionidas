# Screens registration end-to-end UX refinement

- Source prompt: "Not just the login recipe. I'm not sure how to add those steps in 'screens' when I want to register a new screen. Please think of everything end-to-end. Refine if we need to refine. Even the UI/UX"
- Created: 2026-09-26T15:05:00Z
- Status: Exploring

## Goal and context

The user reports the screens page's ADD path is not self-explanatory. The login recipe now has
full visible CRUD (add-row / in-place edit / remove), but the SCREEN itself — its "steps"
(entry, refresh, states) — does not read as something you create step-by-step from the UI.
Think end-to-end about registering a screen: what a user must define, in what order, with
what affordances, and refine the UI/UX.

## Confirmed inputs and verified facts (live audit, this session)

- **`+ screen` create dialog offers only**: `id`, `entry` (tab label + point, or deep link),
  `refresh` (gesture + params). The entry's `point` is a raw `71,870` text field.
- **States are added AFTER creation**: expand the row → states sub-table → add-state form +
  the `probe device…` B1 dialog (searchable live tree → selector proposal).
- **Entry steps are limited to three kinds**: `tab` tap, `deepLink`, or `navigate` (a list of
  POINT steps — raw coordinates, the exact thing the project moved away from).
- **The login recipe** (5 identifiers) is separate: dashed add-row on recipe-less screens,
  in-place edit, remove — full CRUD, shipped today.
- The page's own concept: "the registry is the app's map: cases reference screens by id" —
  `arrive`/`refresh`/`expect screen` verbs consume it at play time.
- The screen-state runner resolves `arrive` via tab tap / deep link / navigate, then asserts states.
- **Navigation reality**: entry covers ONE hop (a tab or a link). Multi-hop entries (e.g.
  "home → tap Track → tap a shipment → details") must use `navigate` = raw coordinate taps —
  unusable long-term, identical to the pre-selector era the tap grammar already fixed.

## Exploration — the gaps, end to end (register → use)

1. **Create-time ordering is implicit.** id + entry + refresh first; states only after save,
   only inside the expanded row; login recipe only on the recipe-less screen's dashed row.
   Three surfaces, no guided order. A new user can't tell what a "complete" screen needs.
2. **Entry is coordinate-bound.** `tab` supports `label`/`identifier`/`labelContains`
   selectors already (validated by `validSelector`), but the create dialog only exposes
   "tab label + point". `navigate` is points-only — no selector steps.
3. **States have no create-time path.** The B1 probe (live tree → selector) exists ONLY in
   the states editor, post-creation. Discoverable but buried.
4. **No feedback loop from cases.** Which cases use `arrive home`? The `used by` column
   exists for screens — good — but nothing tells you WHAT a missing state breaks until a run fails.
5. **Login recipe is a parallel mini-language.** Five fixed identifiers; no relation to the
   state/selector model users learn elsewhere on the page.

### Options

**Option A — guided register flow (recommended first move).**
One dialog, staged: (1) identity (id), (2) entry — the SAME selector grammar as taps
(identifier/label/labelContains via the B1 probe, multi-step supported), (3) optional refresh,
(4) optional states (B1 probe inline, "verify live" per state), (5) optional login recipe
(the five identifiers, offered only here). Create writes everything in one save. The row's
expanded view remains the read/edit surface it is today. Kills the three-surface hunt.

**Option B — keep surfaces, fix affordance visibility.**
Cheaper: keep create/edit/states/login where they are but (a) expose selector-based entry in
the create dialog (drop the point field to optional), (b) add an empty-state checklist on a
fresh screen row ("no states yet — add one · probe device"), (c) add `+ state` to the create
dialog as a shortcut. Solves findability; leaves the multi-surface model.

**Option C — probe-first registration.**
The B1 live-tree probe becomes THE registration UX: connect a device, navigate the app
manually, "capture screen" snapshots the current AX tree, proposes id + entry-from-history +
selected states from the live tree. Most powerful; biggest build; depends on a booted device
at register time.

### Risks / constraints

- `navigate` gaining selector steps = grammar + runner change (screen-runner's navigate loop
  is point-only today) — real work, schedule it explicitly, don't smuggle it.
- The registry validator forbids empty registries; multi-app revision guard is per-bundle
  (learned in 019) — the guided flow must key revisions per bundle.
- Sketches + pick (house rule) before any build; the screens page just absorbed the login
  block — one more full redesign risks churn. Recommend Option A as a SKETCH round first.

## Decisions (operator, 2026-09-27)

| # | Decision | Rationale |
|---|---|---|
| D1 | **Multi-hop entry with selectors — NEED IT.** The `navigate` list gains selector steps (`{on: identifier}`), grammar + runner work planned openly. | Screens 2–3 taps deep with no deep link must not depend on raw coordinates. |
| D2 | **Login recipe INSIDE the register flow.** The create dialog offers the five identifiers as a stage. | One session defines everything; the future AI agent authoring cases reads ONE canonical definition surface. |
| D3 | **Manual registration is fine.** No probe-first requirement; live probe stays as the optional states helper it already is. | Big picture: an AI agent will later author test cases from these rules/concepts — a deterministic manual schema is machine-legible by design; probe-first UX complexity is unnecessary now. |

**Direction context (operator):** the registry + grammar are being shaped as the
machine-readable rulebook a future AI agent will use to create test cases. Optimize for
explicitness and completeness of the model, not for interactive convenience.

## Open questions

None — D1–D3 settled the shape. Sketch round next.

## Next step

Sketch round (2–3 variants of the guided register flow on real Axiom tokens): identity →
entry (single-hop OR selector-stepped multi-hop) → refresh → states → login recipe, one save.
Then plan → review → build, the standing chain.

