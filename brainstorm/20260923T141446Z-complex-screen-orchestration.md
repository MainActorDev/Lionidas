# Complex-Screen Orchestration — Rethinking the Runner Model

- Source prompt: "instead of focusing on those scopes only. I need you to really analyze the possible cases of a complex screen. See the bigger picture. And how is the best possible way we can compose or orchestrate those cases? Maybe we need to rethink about the runner itself (YAML)."
- Created: 2026-09-23T14:14:46Z
- Status: Direction selected (proposal — pending acceptance)

## Goal and context

Zoom out from the two prior questions (multi-API mocks, no-relaunch swaps) to the whole: what does testing a **complex screen** actually require, and does the current runner model — a flat, linear YAML step list — compose those cases well? The user suspects the YAML itself may be the ceiling.

**Interpretation (not user-confirmed):** goal = a runner model analysis grounded in what complex Lion Parcel screens demand (home feed, shipment tracking, check-rates — multi-API, multi-state, multi-entry), then an orchestration proposal.

## Confirmed inputs and decisions (verified 2026-09-23)

- Runner today: `YamlStep { action: tap|scroll|type|runFlow|expect|alert|location }` — **strictly linear array**, exactly one action key per step, `optional`/`when` guards per step, `runFlow` references named flows (the only reuse mechanism). `YamlCase { name, app, alerts, setup[], steps[], variants }` — setup + steps are two linear lists.
- Assertions are **positional**: an `expect` mid-list asserts "at this point in time". No notion of "screen state", only of list position.
- Variants = `{id, networkScenario, env}`; env substituted into selectors at runtime (`${env.X}`). One scenario per variant (prior brainstorm's A1 proposes sets).
- Device/simulator state changes (location, alerts) are steps — interleaved into the same list.
- Real cases are short: `privacy policy` = setup 1 + steps 5; `Maps` = 4 steps including a location step; `intl drill` = 1 expect step + 3 variants.
- runFlow exists for AC-era flows; modern cases barely use it (authored cases inline everything).

## Exploration

### What a complex screen actually is (the case space)

Take "shipment tracking" as the reference: 3–5 APIs (shipment detail, events, ETA, pricing, ads), 4+ visual states (loading, loaded, empty, error, cached-stale), 2 entry points (deep link, tab navigation), cross-screen dependencies (login state, selected address), and timing realities (skeleton → content transition, retry with backoff). Enumerating the **case classes** a tester needs:

| # | Case class | Example | Current model handles it? |
|---|---|---|---|
| 1 | Happy path per world | sg rates render | ✅ variant lanes (with relaunch tax) |
| 2 | Per-API failure isolation | events API 500s, rest OK — what renders? | ⚠️ needs mega-scenario per failure (A1 fixes) |
| 3 | Composed failures | events 500 + cached data — stale banner? | ❌ same, worse combinatorics |
| 4 | State transitions | loading → empty (no data) → retry → loaded | ⚠️ possible as one linear script but asserts-on-transitions are awkward; a flicker mid-list can fail positionally |
| 5 | Entry-point parity | deep link vs tab nav land on same screen state | ❌ two near-duplicate cases (shared tail, different head) |
| 6 | Cross-screen state | change address on screen A, verify prices on B | ⚠️ one long linear case spanning screens — brittle, no screen boundaries |
| 7 | Timing/async | skeleton ≤2s, content eventually; race-prone | ⚠️ `expect` has settle budgets, but "assert transient then assert final" is two positional expects hoping the transition is catchable |
| 8 | Retry/backoff | mock 500 → 200 on 2nd call — app recovers | ❌ current presets are static per scenario; no per-request scripting |

The pattern: **classes 2–8 are all composition problems.** The linear list makes every combination a new hand-written script; reuse (runFlow) is textual, state (class 6) is implicit, transitions (4, 7) are races against list position, and dynamic responses (8) don't exist.

### Option R1 — Enriched linear YAML (evolve in place)

Add steps: `world:` (scenario set swap, prior B1), `assertEventually`, `deepLink` entry, conditional `when:` on *state* not just selectors. Keep the flat list.

- **Wins:** smallest change; every existing case stays valid; the two prior brainstorms slot in as steps.
- **Costs:** classes 5/6 stay duplicated/brittle (linearity is the ceiling); step vocabulary grows until YAML reads like an assembler program.

### Option R2 — Screen-state model (phases + shared screens) ✅ PROPOSED

Restructure the case around **screens as first-class blocks**, not steps:

```yaml
name: shipment tracking — events api failure
app: com.lionparcel…
worlds: [shipment-ok]           # scenario SETS (A1)
on:
  entry: deepLink shipments/CR-123   # entry-point parity: swap entry, reuse body
screens:
  tracking:                       # a named screen = entry route + state asserts
    route: shipments/{id}
    states: [loading, loaded, empty, error]
steps:
  - arrive: tracking              # navigate (any entry), settle
  - world: [shipment-events-500]  # swap mocks mid-run (B1)
  - refresh: tracking             # gesture from the screen's declared refresh
  - expect screen: tracking.state = error
  - expect screen: tracking.state != loading   # transition assertion
  - world: [shipment-ok]
  - refresh: tracking
  - expect screen: tracking.state = loaded
```

- **Mechanics:** `screens[]` is *metadata* (route, deep-link, declared refresh gesture, named states as selector-sets) — the app registry Crucible lacks today; `arrive`/`refresh`/`expect screen` are the only new runner verbs; `world` composes with everything (A1+B1 inside this model).
- **Wins:** class 5 = swap `entry`, reuse body; class 6 = `arrive: other-screen` sequences screens explicitly; classes 4/7 = state assertions are *declarative* (poll to state, assert transition, assert not-transient) instead of positional races; class 2/3 = scenario sets (A1). Cases become **orchestrations of screens and worlds** rather than tap-scripts — which is how the failures were being described all along ("events API down on tracking screen → error state").
- **Costs:** biggest change: schema v2 + screen-registry authoring + runner state machine (poll-to-state, transition windows). Back-compat by *lifting* v1 cases (linear list ⇒ one implicit screen, steps unchanged) — the intl/privacy/maps cases lift mechanically.

### Option R3 — Behavior-driven (Given/When/Then, Gherkin-ish)

Cases as scenarios referencing a shared step dictionary.

- **Rejected for now:** indirection layer without new power — class 8 (dynamic responses) still missing, and the tap-level detail has to live somewhere; Gherkin just moves it. Revisit only if non-engineers start authoring.

### The missing piece in ALL options: scripted responses (class 8)

Retry/backoff and transient-failure cases need **per-request behavior**, not static payloads: `respond: 500 twice, then 200`. Forge presets gain a tiny script (sequence per matched endpoint, or stateful `n-th call` selector). Without this, "app recovers when API recovers" is untestable — and it's orthogonal to R1/R2, shippable into forge independently. **Proposed regardless of runner choice.**

### Orchestration across cases (suites, ordering)

Already good: suites/plans/batch ids exist. The gap is *dependency* between cases (class 6 across runs) — deliberately out of scope: cross-case state is what made the AC-era flows brittle; keep cases self-contained, sequence via suites.

## Decisions (user, 2026-09-23 round 2)
1. **R2 (screen-state model) — accepted. "Production-grade by any means necessary."** Direction locked; next stop: plan → review → staged implementation.
2. Screen-registry question answered by elaboration — see R2 addendum below (app-level registry recommended, plain-English rationale delivered in chat).
3. **Scripted responses — accepted into scope** ("Why not" = yes, and no objection raised to shipping it independently/early).

## Next step

Decide R1 vs R2 (and Q3). If R2: plan the schema v2 + lift-v1 migration + screen registry; A1 (scenario sets) and B1 (world step) become the first two bricks of it rather than standalone patches.
