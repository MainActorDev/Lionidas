# Platform-Level State Management (State-Coupled Tests)

- Source prompt: "Then, what needs to be done or added?" → "Let's not talk specific about Foodiary. I meant for Lionidas as a testing platform" — followed by the directive: "This has to be done correctly. I don't want to oversimplify or overcomplicate things or the workflows."
- Created: 2026-10-16T09:04:42Z
- Status: Direction selected (proposal)

## Goal and context

A live case exposed the class: `tpl_7ff78cd3` (Foodiary onboarding) passes only when the app has no persisted state; a dirty install makes the setup wait time out regardless of app health. The user's question moved deliberately from the single case to the platform: **what must Lionidas have so state-coupled tests are handled correctly as a platform concern, not per-case heroics?**

The standing constraint is the user's own: the solution must neither oversimplify (pretend launch-arg injection is the whole answer) nor overcomplicate (build a state-machine engine nobody asked for). It must fit the existing workflows — case YAML grammar, screens registry, recipe tables, playback engine, batch orchestrator — not replace them.

Framing: Lionidas today manages **screens** (registry, refresh, arrival) and **runs** (verdicts, evidence, trends) but not **state**. Nothing in the platform can name an app state, detect it, reach it, or prove a case started from it. That is the gap.

## Confirmed inputs and decisions

Verified against the live tree (2026-10-16):

- **Convergence verbs already exist for one domain**: `ensureLogin` / `ensureLogout` are first-class step actions in the grammar (`manual/playback.ts:87`). `ensureLogin` is idempotent — no-op when a session indicator is already visible — and resolves its recipe in precedence order: app-level procedure (`app_login` table) → legacy screen-level block → inline selectors; incomplete recipes fail loudly, never silently skip. `ensureLogout` mirrors this (`app_logout`, `recipe: 'app'`). This is the proven in-house pattern: **probe → recipe → verify, idempotent, honest failures.**
- **Launch-arg plumbing exists end-to-end**: `alloy/runner.ts` carries `spec.launchArgs` (persisted on the run row, passed to `alloy_apps open`); playback already launches with `['-uitest-live-refresh']` hardcoded (`playback.ts:665`); Forge scenarios carry `launchArg` with run-scoped pinning. So "relaunch the app with a reset argument" needs wiring, not new machinery.
- **The runtime-signal seam exists**: screen registry `refresh_json` → `com.crucible.refresh.<screenId>` (Bellwether), gated on `-uitest-live-refresh`. Mid-session actuation is real but is NOT a boot-state actuator — a signal arrives after the view graph exists.
- **Recipe-as-data is an established pattern**: `app_login`/`app_logout` rows, `app_screens` registry, scenario/network recipes — the platform already stores "how to do X to this app" as data with provenance.
- **Verdict honesty precedents**: status is always computed, never stored; `evaluated_json` already carries out-of-band execution facts (e.g. `sweep.stats`) — a place provenance can ride without schema upheaval.
- **Standing product decisions that constrain design**: manual runs never roll up to AC status; runs are immutable; UI vocabulary stays plain-English; batch lanes are a contract for the chain.

From the earlier discussion (user-accepted, chat 2026-10-16):

- The actuator is per **state dimension**: boot-persisted state needs launch-arg/pre-first-frame reset; mid-session state fits the Bellwether seam; identity already has ensure* verbs; arbitrary "arrived" states need **seeding**, not wiping; device-level state (permissions, locale) belongs to the harness, not the app.
- Prior-test state is a legitimate fixture **only** when the state transition itself is under test (the relaunch-skips-onboarding case).

## Exploration

### The real problem

Order-dependence is a symptom; the disease is that preconditions are **invisible**. Today a case's required starting state lives implicitly in its first `wait:`. No tool can see it, check it, or satisfy it — so correctness rests on tribal run order. The platform fix is to make preconditions first-class data, then make the engine converge to them idempotently. Everything else is actuator selection and bookkeeping.

### Option A — Grammar-first: generalize the `ensure*` verb family

Add `ensureState: <state-id>` as a setup-phase step. A new `app_states` registry (sibling of `app_screens`) declares per app, per state: **probe** (how to detect "already in it"), **recipe** (how to reach it — arbitrary steps, relaunch-with-args, or a runtime signal), **verify** (post-recipe assertion). The engine plays probe → skip-if-true → recipe → verify, exactly the `ensureLogin` shape lifted from the login domain to any state.

- Fits: extends a pattern the engine already executes; visible in YAML (`setup: [ensureState: fresh_install]` reads as English); recipes stay data with provenance; the `wait`-step precedent shows grammar additions land cleanly.
- Costs: a new registry to author per app; per-case setup steps are still per-case (N cases each declaring the same ensure).
- Fails to fix by itself: batch-level waste (reset per case when one reset could serve many).

### Option B — Metadata-first: `requires:` on the case, engine-side resolver

Cases carry `requires: [fresh_install]` as metadata; the engine resolves and converges before step 1, invisibly to the YAML steps.

- Fits: cleanest authoring for case writers; the natural hook for batch grouping (group cases by `requires`, reset once).
- Costs: convergence is invisible in the case body — the exact tribal-knowledge failure mode in new clothes ("why did the app reboot before step 1?"); a second resolution mechanism to maintain beside the step player; harder to narrate as evidence.
- Rejected as the *primary* shape — but its one good idea (batch grouping key) is salvageable.

### Option C — Full state-machine model (states, transitions, graph search)

Model every app as a state graph; the planner derives paths to satisfy preconditions.

- Explicitly **overcomplicated** (user's word): path planning is an LLM/agent job, not a platform job; graphs rot; verification of "the app is in state X" is the hard part no graph solves. Rejected.

### Recommendation — A, with B's scheduling idea as a later phase

**Phase A (the correct minimum):**
1. `app_states` registry — per app: `state_id`, `probe` (identifier/tree check or "app freshly relaunched with arg"), `recipe` (steps / relaunch-with-launchArgs / signal), `verify` (expect-shaped), plus provenance fields in the established style.
2. `ensureState` grammar verb + engine support — the `ensureLogin` loop generalized; probe-hit = narrated no-op; recipe failure = honest step failure; verify binds to the existing expect machinery.
3. Reset actuator = **relaunch with launchArgs** wired as a recipe primitive (reuses the runner seam; one hardcoded list becomes declarative).
4. Two seed states per app are expected conventions: `fresh_install` (reset) and whatever "arrived" states cases actually need (e.g. `onboarded`) — seeded via recipe, reached once, verified.

**Phase B (orchestrator/verdict, rides after A proves out):**
5. Batch grouping by declared precondition — wipe once, run the fresh-install group; ordering becomes performance, never correctness.
6. Verdict provenance — `evaluated_json` records "precondition enforced (probe→recipe→verify)" vs "already satisfied (probe-hit)"; UI shows it as plain-English text on the run/step.

**Deliberately out of scope** (the don't-overcomplicate list): state graphs/planners; auto-inference of preconditions from waits; conditional branching inside cases; device-level state management (permissions/locale) beyond what recipes can express with existing verbs; multi-app state choreography.

**The cooperation contract, stated honestly in-registry:** a state entry is only authorable if the app exposes an actuator for it (launch arg, signal, or reachable UI path). Apps without one get an explicit authoring error — "state `fresh_install` not satisfiable: app defines no reset hook" — not a silent fallback to uninstall. Uninstall/reinstall as a blunt actuator is a policy question (see open questions), not a default.

## Decisions (2026-10-16 chat)

- **Q1 — DECIDED: harness-level actuators allowed.** Recipes may reference device/harness actuators (uninstall/reinstall, privacy grants, cache wipes) — no honest-block ceiling. Design implication (from the parallel-lane hazard): a case whose recipe fires a DEVICE-SCOPED actuator must serialize against other lanes on that device (the existing busy-guard seam), so the blast radius is contained by scheduling, not by refusal.
- **Q2 — DECIDED: mid-steps allowed.** `ensureState` may appear in setup AND in the steps body (transition-under-test cases stay single cases; no cross-case state coupling). Chat also connected this to AI test breakdown — see "State-aware breakdown" below.
- **Q3 — DECIDED: rebuild.** `ensureLogin`/`ensureLogout` get re-expressed as `app_states` registry entries — one state system, not two. Schema implication: the registry recipe format must support what the login domain needed — env-resolved credentials (`${env.X}`, the `template-env.ts` seam), `verify.via` (tap a control before polling state), and entry objects (tab/deepLink/navigate). Migration: existing case YAML with `ensureLogin` keeps parsing (translated to registry-backed convergence, then re-authored over time).

## State-aware breakdown (user-raised, 2026-10-16)

The user's point: on complex screens with many states, the **planning/breakdown step is where test quality is decided** — and the state system is a prerequisite for doing it well. The registry is not just a playback concern; it is the AI's **vocabulary at breakdown time**:

- **State coverage matrix**: for a complex feature, breakdown enumerates states (from `app_states` + source analysis) and proposes cases per state and per transition — visible coverage, not vibes. A state nobody can name is a state nobody tests.
- **One case per transition**: mid-case `ensureState` lets the AI keep "state X → action → state Y" as a single self-contained case instead of splitting into cross-case chains (the search-history-on-logout shape). Breakdown decides case boundaries BY state transitions, not around them.
- **Preconditions are declared at birth**: cases authored by the AI carry `ensureState` from day one, so the suite never accumulates implicit-fixture debt while nobody's watching.
- Sequencing note: this argues for the registry landing FIRST in the build order — playback convergence (engine) and breakdown consumption (agent) both depend on it.

## Deep navigation — reaching screens many taps away (user-raised, 2026-10-16)

Question: what's the strategy when the screen under test sits behind a long journey? The state system answers most of it — **"being on screen X" is itself a state** — but arrival has its own decision ladder:

1. **Direct entry (deep link / launch-into) is an OPTIONAL ACCELERATOR, not a registration duty** (corrected 2026-10-16: no per-screen deep-link registration). Deep links are an app-level inventory — most apps expose only a handful of routes; the registry records what EXISTS where it exists. Valid only when the screen's state contract doesn't depend on how you got there (a deep-linked checkout with an empty cart behind it is the wrong world). **The universal default is the walk (2)** — every UI-reachable screen has one, zero app-side support needed. Practical hybrid: deep link to the nearest routable ANCESTOR + short walk for the last screens; the registry recipe expresses that as one arrival.
2. **Journey-as-recipe: "on screen X" as a registry state.** Recipe = the canonical walk (or runFlow composition); probe = "is X frontmost"; verify = screen identity. Deep cases converge idempotently — a case that already sits on X skips the walk. Failure of the walk is a named setup failure, not a mysterious case failure. Shared journey = single point of repair: one UI change breaks the recipe once, one fix heals every deep case (vs. copy-pasted walks rotting N times).
   **Authoring is LAZY and machine-assisted** (corrected 2026-10-16): the registry is NOT an up-front map of the whole app — a state gets registered when a case actually needs it. Sources: promote a recorded QA flow to the arrival recipe (the recorder already produces flows; `arrive:` already stores registry paths), or AI-draft the walk from the screen registry at breakdown time. Coverage grows with the suite, not ahead of it.
3. **Batch grouping amortizes the walk** (Phase B): cases grouped by deep destination walk once — first case pays the journey, the rest probe-hit. Ordering as performance, never correctness, exactly as with reset grouping.
4. **The journey itself under test = the journey IS the case** (steps, not setup). Breakdown decides this: coverage belongs to the transition chain only when the chain is the feature.

Anti-patterns: pasting the walk into every case (N rotting copies), and depending on the previous case ending up deep (order coupling — the original disease wearing a navigation costume).

Relation to existing seams: `arrive:` already plays registry-stored paths; `runFlow:` composes a recorded flow inline; entry objects (tab/deepLink/navigate) exist in the login domain. The state registry generalizes these into one arrival vocabulary instead of three ad-hoc ones.



## Open questions

1. ~~Blunt actuator policy~~ — **DECIDED 2026-10-16: harness-level actuators allowed** (see Decisions). No open schema question remains on this.

## Next step

Approve the direction (Phase A: registry + `ensureState` verb + relaunch/harness-actuator primitives, deep-navigation arrival states included; Phase B deferred until A is live). All three open questions are now DECIDED (harness actuators allowed; mid-steps allowed; ensureLogin/Logout rebuilt onto the registry). Next concrete step: `hms-plan-from-brainstorm` turns this into a task-broken plan with the edge-case table — ready on the user's go.
