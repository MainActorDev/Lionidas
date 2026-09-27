# Review — Bellwether scaled composition plan (`20260925T053000Z-bellwether-scaled-composition-plan.md`)

- Reviewed: `plans/20260925T053000Z-bellwether-scaled-composition-plan.md` (as saved 2026-09-25), against the conversation's approved direction (one gate / two-line adoption / zero domain pollution) and live code.
- Evidence sources: Construkt `FeatureStore.swift` + `FeatureSpec.swift` (spm-clones, 2.0.4), `LPFeatureSwiftUI/StoreAdapter.swift:25-27`, `LPCore/Package.swift` admission comment, `App/AppDelegate.swift:1-12`, `Tests/Home/HomeFeatureTests.swift:5-7`, Bellwether 0.1.0 source, `project.yml:45-46,141+,175`, `fastlane/TestSupport.rb:20+`.
- Verdict: **Needs revision** — one High compile-blocking API mismatch (F1), one High testability hole (F2), one Medium ordering hazard (F3). All corrections concrete. Architecture, layering, and the dependency direction are sound and match the approved direction.

## Verified independently

| Plan claim | Check | Result |
|---|---|---|
| `FeatureSpec.Intent` expressible via protocol requirement | `FeatureSpec.swift:29` plain associated type | ✅ |
| `FeatureStore.dispatch` public, callable from an extension | `FeatureStore.swift:65` | ✅ |
| `FeatureStore` is a generic **class** → extension with `where F: RefreshableFeature` works | `FeatureStore.swift:10` `public final class FeatureStore<F: FeatureSpec>` | ✅ |
| `StoreAdapter` is `@MainActor` | `StoreAdapter.swift:25` | ✅ (adapter init calling `bindRefreshSignal` is MainActor — fine) |
| `subscribeRefresh` handler is `@MainActor () -> Void` | Bellwether source:62-66 | ✅ matches |
| AppDelegate `#if DEBUG || STAGING` NFX precedent | `AppDelegate.swift:10` | ✅ |
| Tests import both `LPHome` and ConstruktKit | `HomeFeatureTests.swift:5-6` | ✅ (F2's fixture is reachable) |

## Findings

### F1 — HIGH — `bindRefreshSignal` as sketched cannot compile: the extension is on `FeatureStore`, but `subscribeRefresh`'s closure is `@MainActor` and `FeatureStore` is not MainActor-isolated

**Where:** Task C.2 sketch:

```swift
extension FeatureStore {
    @discardableResult
    public func bindRefreshSignal(screenId: String) -> RefreshSubscription? where F: RefreshableFeature {
```

Two problems:
1. **Syntax:** a `where` clause constraining the generic parameter `F` of the *extended type* goes on the **extension**, not the method: `extension FeatureStore where F: RefreshableFeature { ... }`. As written, `where F:` inside the method signature refers to no generic context — compile error.
2. **Isolation:** the method body (nonisolated, called from a `@MainActor` init — that part is fine) creates a `@MainActor` handler closure capturing `[weak self]` (a non-Sendable class ref) — acceptable under Swift 5 mode (`swiftLanguageModes: [.v5]` in LPHome/LPCore), but if `RefreshSignal.swift` lands in **LPFeatureSwiftUI** (the C.2 fallback home), that package compiles in **Swift 6 mode** (its Package.swift has no `.v5`) — `weak self` capture of non-Sendable `FeatureStore` into a `@MainActor @Sendable`-ish closure context can error there.

**Correction:** write it as:

```swift
extension FeatureStore where F: RefreshableFeature {
    /// …doc…
    @MainActor
    public func bindRefreshSignal(screenId: String) -> RefreshSubscription? {
        Bellwether.subscribeRefresh(for: screenId) { [weak self] in
            self?.dispatch(F.refreshIntent)
        }
    }
}
```
`@MainActor` on the method matches the only legal call site (adapter init) and puts the closure's actor context in the method, not the extension. If placement lands in LPFeatureSwiftUI (Swift 6), verify `dispatch` (nonisolated) is callable from a `@MainActor` closure capturing non-Sendable `self` — it is (dispatch is nonisolated synchronous), but **pin it with a compile** before writing dependents. **Verify:** the file compiles in its chosen home + the adapter call site compiles.

### F2 — HIGH — The signal test as planned cannot run: `HomeStoreAdapter` is constructed via `HomeSwiftUIComposition` with real `Dependencies`, but the plan's test wants `bindRefreshSignal` on a bare store

**Where:** Task C.5 ("construct the adapter (or call `bindRefreshSignal` on a store), post the Darwin notification, expect PASS-2").

**Consequence:** constructing the real adapter needs the full `HomeModule.Dependencies` bag (authSession, remoteConfig, onOpenWhatsApp closures — heavy, and some are app-target types); calling `bindRefreshSignal` directly on a test-built store is the workable path but the plan doesn't say the store fixture is the *same shape the once-guard suites already build* (`makeStore` with mock deps — verified reachable: tests import `LPHome` + ConstruktKit). Without precision here the implementer may wire an integration test that drags app-target types into the module test target and fails to compile.

**Correction (test design, concrete):** the signal suite builds its store with the existing `makeStore` mock fixture (already in the file), calls `store.bindRefreshSignal(screenId: "home")` **with `Bellwether.subscriptionsAllowed = true` + `launchArgumentOverride` set** (same override pattern as the library's own tests — this is exactly why the override API exists), holds the returned subscription in a local `var` (deinit-detach at scope end), posts the notification, expects `PASS-2`. No adapter construction, no app-target types. **Verify:** suite compiles + passes; no `@testable import LionParcelLogisticsINTL` additions.

### F3 — MEDIUM — Stage B ordering: B.1 rewires packages while PR #385's CI (still queued) runs against the current shape; also scipio rebuild must precede the 0.2.0 pin

**Where:** Stage B intro + B.2's buried `[VERIFY]`.

**Consequence:** pushing B onto the branch re-triggers CI (fine) but the plan's B.2 verify note — "rebuild the xcframework after A.5, then bump the root pin" — is easy to execute in the wrong order: bumping `Package.swift` to `from: "0.2.0"` before regenerating `XCFrameworks/Bellwether.xcframework` leaves local builds resolving a *source* Bellwether (public repo, has 0.2.0 tag) while CI's swap map also says 0.2.0 — subtly different artifact provenance than every sibling (which are scipio-prebuilt locally). Not fatal, but it violates the repo's prebuild law silently.

**Correction:** make B.2 an ordered checklist: (1) Bellwether repo tagged 0.2.0 (A.5), (2) `scipio prepare` rebuild → `XCFrameworks/Bellwether.xcframework` refreshed, (3) root `Package.swift` pin bump, (4) lockfiles regen, (5) `xcodegen generate`. Add: "push only after (5)".

### F4 — LOW — C.1 conformance placement: `extension HomeFeature: RefreshableFeature` requires importing the helper's home module in `HomeFeature.swift`

Trivial but unstated: if the helper lands in LPFeatureSwiftUI, `HomeFeature.swift` (currently imports Foundation + ConstruktKit only) needs `import LPFeatureSwiftUI` (already a package dep — fine). Name the import in C.1.

### F5 — LOW — `refreshRequested` naming collision risk un-checked

`HomeFeature.Intent` gains `refreshRequested`; no existing case with that name (checked: loadData, sessionLoaded, recommendedCountriesLoaded/Failed) — clean today. Note only: keep it prefixed in future intents to avoid `refresh` overloading.

### F6 — LOW — plan omits deleting the now-dead `HomeUITestRefreshSignal` path from tests' mental model

PR #385's current branch never had `HomeUITestRefreshSignal` (that was #383) — but the plan's C.5 rewrite should state the Bellwether-signal suite *replaces* the previous `HomeBellwetherSignalTests` (the file's current suite posts via `Bellwether` directly through the adapter-composed path). One sentence; prevents suite duplication.

## Coverage traceability

| Requirement (operator direction) | Plan work | Acceptance |
|---|---|---|
| One gate per app, Debug-only | A.1 activate() + C.4 AppDelegate | Bellwether unit test + code review (single `#if DEBUG` in codebase) |
| Two-line module adoption | C.2 helper + C.1/C.3 home adoption | adapter diff shows 2 lines |
| Zero domain pollution | C.1 unconditional guard + dedicated intent | State diff shows only `hasLoadedCountries` |
| ConstruktKit wiring pattern | B.1a vend + B.2 map | `swift package resolve` + CI swap-map entry |
| Crucible contract stable | none (declared) | D.2 drill 8/8 unchanged bar |

## What this review could not certify on paper

- C.2's final placement (LPCore vs LPFeatureSwiftUI) — the plan's own [VERIFY]; both homes legal, decided by LPCore's admission law at implementation.
- Swift 6 compile behavior of the F1-corrected closure in LPFeatureSwiftUI (if chosen) — must compile before dependents.
- Live drill behavior on the recomposed build (D.2 owns it).
- Staging runtime gate check — still blocked by pre-existing LPClaim breakage (disclosed; unchanged).

## Questions for the operator

None material. (If you have a preference for F1's helper home — LPCore vs LPFeatureSwiftUI — state it; otherwise the implementer follows the plan's admission-law test, defaulting to LPFeatureSwiftUI on any doubt.)

## Verdict

**Needs revision** — fold F1 (corrected extension syntax + isolation), F2 (concrete test design on the existing mock fixture), F3 (ordered B.2 checklist, push-last), F4/F6 (one-liners). No architectural change requested; the three-layer shape, dependency rewiring, and verification bar all stand.
