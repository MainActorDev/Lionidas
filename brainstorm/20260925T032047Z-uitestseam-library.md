# UITestSeam as a library: extraction from LPHome's forced wiring

- Source prompt: "Seeing the implementation in ios-consumer-intl, I'm certain that this will easily get messy in the future. Because they're tightly-coupled and the implementation seems to be forced. I'm thinking what if we can create a dedicated (plug-and-play) iOS library (SPM) to setup this launch-args configurations without having code smells. With better architecture and design concept. Either a new library or simply part of the Construkt library (that we also owned) where the Runtime systems live there."
- Created: 2026-09-25T03:20:47Z
- Status: Direction selected (pending operator pick between two placements)

## Goal and context

The shipped seam (PR #383, commits `70d0f306` + `224c59c8`) works but the user finds its shape wrong: the launch-arg read lives at `AppScreenBuilder` (app target), the flag threads through `makeSwiftUIView → makeStoreAdapter → makeStore` as a boolean parameter, and the Darwin bridge (`HomeUITestRefreshSignal`) is a home-specific class with a **static last-writer-wins handler hop**. Replicating that per screen is N copies of forced wiring — the user wants a plug-and-play SPM library (new, or inside Construkt where the Runtime lives) that any feature adopts in one line without code smells.

## Confirmed inputs and decisions

- User-confirmed: current implementation is tightly coupled and "forced"; wants a library (SPM); open to **new standalone** OR **inside Construkt** (both repos owned).
- Verified facts (repo, 2026-09-25): Construkt ships `ConstruktKit` (Core/Runtime holds FeatureStore/FeatureRuntime/FeatureSpec); LPHome imports ConstruktKit already; the app's `Core/Helpers/UITestConfiguration.swift` reads ProcessInfo once; registry-flip/runner side (Crucible) is gesture-agnostic and needs NO change for any app-side reshaping.

## Exploration

### What's actually smelly (naming the smells sharpens the fix)

1. **Boolean threading**: `liveRefreshOnAppear` passed through 3 layers that don't care about it (parameter pollution — middle layers exist only to ferry the flag).
2. **Static handler hop**: `HomeUITestRefreshSignal`'s static `handler` is process-global, last-writer-wins, one-name-one-listener — breaks silently if two home stores ever exist (tests already share the static across suites).
3. **App-target ProcessInfo read**: the seam's *configuration* lives outside the module system, so each app must hand-wire it; nothing discoverable.
4. **Screen-specific naming**: `com.crucible.refresh.home` string literal + class named `Home...` in a shared-destiny pattern.

### Option A — standalone `UITestSeam` SPM library (recommended)

A tiny (4-file, ~150 line) library with an explicit pipeline — no threading, no statics:

```
UITestSeam config:    UITestSeam.isLiveRefreshEnabled        // one ProcessInfo read, injectable for tests
       │
signal names:         UITestSeam.refreshSignal(for: "home")  // canonical com.crucible.refresh.<id>
       │
ownership:            RefreshSignalSubscription              // value returned to the OWNER (adapter);
       │               deinit removes observer — lifetime tied to holder, no static hop
       │
dispatch bridge:      feature registers a handler closure per screen id;
                       the subscription keys handlers by id (multiple screens coexist)
```

App adoption becomes **two lines per screen** (replace the whole current wiring):

```swift
// HomeStoreAdapter init
self.refresh = UITestSeam.subscribeRefresh(for: "home") { [weak store] in
    store?.dispatch(.loadData)
}
// …that's it. No AppScreenBuilder read, no makeStore param, no composition threading.
```

- `liveRefreshOnAppear` bool in State, the AppScreenBuilder/Composition threading, and `HomeUITestRefreshSignal` all get **deleted**; the once-guard stays (it's correct domain logic, seam-agnostic).
- Testability: `UITestSeam.override(enabled:)` for unit tests (no ProcessInfo games); subscription returns a token whose deallocation unsubscribes.
- Crucible contract unchanged: same notification names, same launch arg — zero server-side work.

**Tradeoffs:** one more repo/version to pin (Scipio prebuild question below); but it's the honest home — the seam is cross-app infrastructure, not home logic.

### Option B — fold into Construkt (`ConstruktKit/Core/Runtime`)

Add `UITestSeam.swift` beside `FeatureStore.swift`. Argument for: "Runtime systems live there"; the subscription could even integrate with `FeatureStore` lifecycle later (auto-dispose with store).

**Tradeoffs against:** Construkt is a *UI/feature-runtime* DSL; a test-harness signal channel is a different concern (SRP at library level). Construkt is Scipio-prebuilt and shared with `ios-consumer` (the non-intl app) — any change ripples into both apps' build graphs and cache rebuilds. The seam is only "runtime-shaped" by coincidence; coupling it to Construkt couples it to Construkt's release cadence.

### Recommendation

**Option A (standalone)** — reasons: (1) the seam is app-agnostic infrastructure used by Crucible-driven apps; any app adopting Crucible picks the library without dragging Construkt's cadence; (2) keeps Construkt's surface unchanged (no ripple into `ios-consumer`); (3) the library is small enough that its own repo is cheap; (4) extraction can be done mechanically from the current working code — low risk, tests already exist to pin behavior (7/7 Home suites + Crucible drill as acceptance).

**Open sub-question (Scipio):** should the new library also be Scipio-prebuilt like the others, or consumed as source? Source-first is simpler (it's tiny, no binary-compat concerns); prebuild only if the repo's build law requires it for consistency.

## Open questions

1. **Placement**: standalone repo (Option A, recommended) vs inside Construkt (Option B)?
2. **Scope**: extraction only (mechanical, keeps current behavior), or also add the multi-screen keying + test-override API now (small, included in A's sketch)?
3. **Repo/location**: if standalone — where does the repo live (same org as Construkt? name `UITestSeam`? `CrucibleSeam`?)?
4. **PR shape**: rework PR #383 in place (it's unmerged), or land #383 and refactor in a follow-up PR? (Rework-in-place keeps history clean — one seam story.)
5. **Scipio**: prebuilt binary like siblings, or source dependency?

## Next step

Operator answers 1–5 (or just 1 + "your call on the rest"); then a plan (hms-plan-from-brainstorm) for: library skeleton → LPHome rewires to subscription API → delete the threading + static hop → tests adapted (same behavioral pins) → drill re-run as acceptance.
