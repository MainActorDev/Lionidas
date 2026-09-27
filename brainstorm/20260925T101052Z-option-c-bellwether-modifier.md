# Option C — Bellwether as a SwiftUI modifier, loud naming, zero runtime/perf risk

- Source prompt: "Brainstorm the Option C solution + loud naming. I don't really want any runtime or performance issues in the future."
- Created: 2026-09-25T10:10:52Z
- Status: Direction selected (pending operator sign-off on two design details)

## Goal and context

The user wants the Bellwether UI-test seam composed as a **custom SwiftUI ViewModifier** (Option C) with **loud Bellwether naming** (Variant A naming — harness-only code says Bellwether), and holds a hard constraint: **no runtime or performance issues in the future**. This follows a long iteration where every prior composition was rejected: #383's boolean threading, the Decorator's cache-class bloat (and its accidental double-cache over Core/Network's existing `CachingShipmentService`), and A/B's residual `let` on the view struct.

Interpretation (not user-confirmed): "no runtime issues" includes (a) no memory leaks from the Darwin observer, (b) no main-thread stalls, (c) no behavior coupling to SwiftUI view identity quirks, (d) no battery/CPU cost in production builds.

## Confirmed inputs and decisions

User-confirmed:
- Option C (ViewModifier) is the composition vehicle.
- Loud naming (Variant A: `.bellwetherRefreshRequested` intent, `bellwether…` symbols) — protection by naming.
- No runtime/performance issues, present or future.

Verified facts (repo/library, 2026-09-25):
- Bellwether 0.2.0 (public, MainActorDev): `subscriptionsAllowed` default-deny gate, `activate()`, `subscribeRefresh(for:handler:) -> RefreshSubscription?`, deinit-detach lifetime, `launchArgumentOverride` test seam. Zero dependencies, iOS 16+.
- `HomeFeature.Intent` is an enum — cases cannot be added by extension; the dispatch-target case must live in `HomeFeature` under ANY composition. The once-guard (`hasLoadedCountries`) is production logic and stays in the reducer.
- `HomeSwiftUIView` currently holds class refs (`adapter`, `balance`) — precedent for stored-property lifetime, which Option C removes entirely.
- Crucible contract is name-stable: `com.crucible.refresh.<screenId>` + `-uitest-live-refresh` launch arg; playback already passes the arg; the device daemon's terminate-on-args-carrying-open fix (`e95cf4a`) is committed. No server-side work for any app-side composition.
- The Decorator commit on the branch (`060a7104`) must be reverted before landing C.
- Prior live drills prove the signal path end-to-end (8/8, in-place swaps, preset-matched traffic).

## Exploration

### The Option C shape (library-side modifier + one attachment line)

**Library (Bellwether 0.3.0 — ships in the library, every app/screen gets it):**

```swift
public struct BellwetherRefreshModifier: ViewModifier {
    let screenId: String
    let handler: @MainActor () -> Void
    @State private var subscription: RefreshSubscription?

    public func body(content: Content) -> some View {
        content.onAppear {
            if subscription == nil {
                subscription = Bellwether.subscribeRefresh(for: screenId, handler: handler)
            }
        }
    }
}

extension View {
    /// UI-test seam: subscribe this screen's refresh signal. No-op in
    /// production (gate closed → nil subscription → zero cost).
    public func bellwetherRefresh(screenId: String, handler: @escaping @MainActor () -> Void) -> some View {
        modifier(BellwetherRefreshModifier(screenId: screenId, handler: handler))
    }
}
```

**App side — the ENTIRE seam footprint:**

| File | Footprint under C + loud naming |
|---|---|
| `HomeFeature.swift` | 1 intent case `bellwetherRefreshRequested` + reducer arm (~4 lines) — irreducible (Swift enum rule) |
| `HomeStoreAdapter.swift` | **ZERO** — pristine |
| `HomeSwiftUIView.swift` | **ZERO** — pristine (no `let`, no param) |
| `HomeSwiftUIComposition.swift` | **ONE trailing line** at the construction site |
| `HomeBellwetherBinding.swift` | **DELETED** (no protocol, no conformance, no binding class — the closure replaces `BellwetherRefreshable`, the LPFeatureSwiftUI extension, everything) |

```swift
HomeModule.makeSwiftUIView(dependencies: dependencies)
    .bellwetherRefresh(screenId: "home") { [weak store] in
        store?.dispatch(.bellwetherRefreshRequested)
    }
```

### The runtime/performance audit (the user's hard constraint)

Cost inventory — everything the seam can possibly cost, per state:

| State | Cost |
|---|---|
| Production launch | Gate closed → `subscribeRefresh` returns nil → one branch + one nil-check per screen appearance. No observer, no allocation beyond an Optional, no Darwin traffic. Effectively zero. |
| Debug + harness launch | ONE CFNotificationCenter observer registration per screen appearance-with-nil-subscription; after first, guarded to no-op. Observer callback = one `Task { @MainActor }` hop per harness signal (signals only fire during Crucible drills — human-scale frequency, not per-frame). |
| Memory | `@State` holds an Optional class ref. Deinit removes the observer and releases the passRetained box (the passRetained/release pairing is pinned by Bellwether's own tests — 6/6 at 0.2.0). |

**The honest risks (not zero — named and mitigable):**

1. **`@State` + view identity** — SwiftUI owns the storage. Risks: (a) `onAppear` re-fires on tab return → guarded by the nil-check; (b) SwiftUI MAY keep `@State` briefly after a view leaves the hierarchy → observer detaches *eventually*, not instantly. For a harness-only path this is acceptable, but it is the one place where C's lifetime is *less deterministic* than A/B's stored-`let`. Mitigation if strict determinism is required: hold the subscription in the modifier via `@State` AND detach in `onDisappear` guarded by a "same identity" check — at the cost of re-subscribe churn on tab switches. **Recommendation: accept eventual detach; it cannot leak (deinit is guaranteed when SwiftUI drops the storage) and cannot fire spuriously (handler is `[weak store]`).**
2. **Modifier ordering** — `.bellwetherRefresh` must attach where `onAppear` actually fires (on the screen root, not inside a lazy container that never appears). Composition-site attachment (as above) is always the root. Documented in the modifier's doc comment.
3. **Closure retention** — the handler captures `[weak store]`; the modifier holds the handler; `@State` holds the subscription which holds the box which holds the handler. No strong cycle: store does not reference the view. Verified shape; pinned by a library unit test (retain-cycle test added in the plan).
4. **Future-proofing** — the modifier lives in the library, so any Bellwether-level fix (e.g., a SwiftUI lifetime change) ships once for every app. This is C's structural advantage over every per-app composition.

### Why C + loud beats the predecessors (summary ledger)

- vs #383: no threading, no statics, no app-target code.
- vs Decorator: no cache class, no double-cache, no deps lens; scaling to N services = one line in the reducer's refresh arm.
- vs A/B: view struct pristine, binding file deleted, protocol machinery deleted; the seam is a *library capability* (`.bellwetherRefresh`) rather than per-app scaffolding.
- Remaining irreducible cost (same as A): the `bellwetherRefreshRequested` intent case inside `HomeFeature` — Swift enum rule; loud-named per the user's choice.

### Alternatives considered and rejected here (already litigated in-session)

- Decorator (rejected: bloat, double-cache, per-service scaling).
- A/B stored-`let` (superseded by C on view-purity grounds).
- Observable-request-layer (real architectural solution; far beyond this PR's scope).

## Open questions

1. **Detach semantics** — accept eventual detach (recommended; zero leak risk) vs eager detach on `onDisappear` (deterministic, costs re-subscribe churn on tab returns). Affects one library file either way.
2. **Where the one attachment line lives** — composition site (recommended; always screen-root) vs inside `HomeSwiftUIView.body` (keeps composition untouched but puts a Bellwether symbol in the view file — contradicts the user's earlier stance on view purity? The view would be pristine under composition-site attachment).

## Next step

Operator answers the two open questions (or accepts both recommendations), then: revert Decorator commit `060a7104` → Bellwether 0.3.0 (modifier + retain-cycle/lifetime tests, tagged) → app branch: delete binding file, pristine view/adapter, one attachment line, loud intent case → full suites + live drill as the acceptance bar → evidence to PR #385.
