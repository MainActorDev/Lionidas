# Plan — Bellwether: the UITest seam as a standalone SPM library

> **For Hermes:** implement task-by-task with build/test verification between each. Three stages: library repo → prebuilt integration → LPHome refactor. PR #383 stays landing as-is; the refactor rides a follow-up branch.

**Goal:** Extract the launch-arg/Darwin-signal seam from LPHome's forced wiring into a plug-and-play, prebuilt SPM library any iOS project adopts in one line — deleting the boolean threading, the static handler hop, and the app-target ProcessInfo read.

**Architecture:** A standalone library **Bellwether** (MainActorDev org, sibling of Construkt): a single public facade (`Bellwether`) over three small types — config (one ProcessInfo read + test override), signal naming (canonical `com.crucible.refresh.<screenId>`), and subscription (per-id handler registry, Darwin observer, lifetime-bound tokens). LPHome consumes it via `XCFrameworks/Bellwether.xcframework` (Scipio prebuilt, like siblings) and its adoption collapses to a single `subscribe` call in `HomeStoreAdapter`.

**Tech:** Swift 6 / SPM swift-tools 6.0, CFNotificationCenter (Darwin center), Scipio (mint) for prebuilds.

---

## Naming (operator decision #3: "British, good philosophy")

**Bellwether** — literally "the wether (castrated ram) that leads the flock, wearing a bell"; figuratively *the early signal that shows which way things will move*. The philosophy is exact: the library listens for quiet signals and tells the app where to move (refetch), and it exists only to serve the flock (the test harness) — never the shepherd's business logic. Also passes the practical bars: unambiguous in code review, no SwiftUI/Foundation collision, `import Bellwether` reads as intent.

Fallbacks considered and rejected: `Beacon` (overloaded in iOS — iBeacon), `Herald` (fine, but passive-sounding), `Semaphore` (catastrophic collision), `Vanguard` (militaristic, and it *follows* signals, doesn't lead).

## Facts pinned by inspection (2026-09-25)

- Org: `MainActorDev` (Construkt = `github.com/MainActorDev/Construkt`, pinned 2.0.4; Crucible, Alloy, xcbuddy all live there).
- Prebuilt pattern: `XCFrameworks/*.xcframework` at repo root (git-ignored), consumed via `.binaryTarget(path: "../../XCFrameworks/X.xcframework")` declared in `Modules/LPDesignSystem/Package.swift:23-26`; Scipio runs through `make scipio` (`mint run giginet/Scipio prepare --support-simulators --framework-type static --configuration debug`); `ScipioDummy/` (empty `struct Dummy {}` + Package.swift) is the manifest anchor Scipio walks.
- LPHome is a local SPM package depending on sibling Modules by path; no pbxproj registration for Swift files.
- Current seam (to be deleted by the refactor): `Core/Helpers/UITestConfiguration.swift` (app target), `liveRefreshOnAppear` threading `AppScreenBuilder → makeSwiftUIView → makeStoreAdapter → makeStore`, `HomeUITestRefreshSignal` static-hop class, State field + `intentionallyUnprojectedStateFields` entry.
- The once-guard (`hasLoadedCountries` + reducer short-circuit) is **domain logic, not seam** — stays untouched.
- Crucible contract is name-stable: notification `com.crucible.refresh.<screenId>`, launch arg `-uitest-live-refresh` — the library implements the same strings; zero server-side change.

---

## Stage A — the library repo (`github.com/MainActorDev/Bellwether`)

### Task A.1: Scaffold

**Files (new repo):**
- `Package.swift`, `Sources/Bellwether/Bellwether.swift`, `Tests/BellwetherTests/BellwetherTests.swift`, `README.md`, `.gitignore`

**Package.swift:**
```swift
// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Bellwether",
    platforms: [.iOS(.v16)],
    products: [.library(name: "Bellwether", targets: ["Bellwether"])],
    targets: [
        .target(name: "Bellwether"),
        .testTarget(name: "BellwetherTests", dependencies: ["Bellwether"]),
    ]
)
```

### Task A.2: The API (complete file — `Sources/Bellwether/Bellwether.swift`)

*(Revision 2 — review F1/F2/F3 folded: default-deny runtime gate; HandlerBox IS the observer (Darwin center ignores `object` — SDK CFNotificationCenter.h:52); weak registry so deinit-detach works.)*

```swift
import CoreFoundation
import Foundation

/// Bellwether — the test-harness signal channel.
///
/// One line per screen gives an app under UI test an in-place refresh
/// listener: the harness posts `com.crucible.refresh.<screenId>` into the
/// simulator; Bellwether's subscriber refetches.
///
/// Philosophy: the bellwether wears the bell for the flock — it hears the
/// signal so the business logic doesn't have to.
///
/// GATE (default DENY): this library is prebuilt once and linked into every
/// app configuration — compile conditions bake at Scipio time, so "Debug
/// only" cannot live here. The CONSUMER sets `subscriptionsAllowed` at
/// startup (typically inside its own `#if DEBUG`); a Release build that
/// wants the seam (QA drill builds) may opt in deliberately.
public enum Bellwether {

    // MARK: - Configuration

    /// The launch argument the harness passes (contract: `-uitest-live-refresh`).
    public static let liveRefreshArgument = "-uitest-live-refresh"

    /// Runtime gate, DEFAULT DENY. The consumer enables it at launch
    /// (operator decision 2026-09-25: runtime, not compile-time). Set once
    /// at startup; not thread-safe for concurrent mutation by design.
    public static var subscriptionsAllowed = false

    /// The full seam condition: gate AND launch argument.
    public static var isLiveRefreshEnabled: Bool {
        subscriptionsAllowed && ProcessInfo.processInfo.arguments.contains(liveRefreshArgument)
    }

    /// Test override for the ProcessInfo half ONLY — the gate stays
    /// explicit so tests exercise it. Pass nil to restore real arguments.
    public static var launchArgumentOverride: String? = nil

    static var argumentPresent: Bool {
        if let launchArgumentOverride { return true }
        return ProcessInfo.processInfo.arguments.contains(liveRefreshArgument)
    }

    // MARK: - Signal naming

    /// Canonical notification name for a screen's refresh signal.
    public static func refreshSignalName(for screenId: String) -> CFNotificationName {
        CFNotificationName("com.crucible.refresh.\(screenId)" as CFString)
    }

    // MARK: - Subscription

    /// Subscribe a screen to its refresh signal. Non-nil ONLY when the
    /// gate is open AND the harness argument is present — production
    /// launches get nil, store nothing, no observer ever exists.
    ///
    /// The returned subscription's lifetime is the observer's lifetime:
    /// store it in the owning adapter; `deinit` detaches.
    @discardableResult
    public static func subscribeRefresh(
        for screenId: String,
        handler: @escaping @MainActor () -> Void
    ) -> RefreshSubscription? {
        guard subscriptionsAllowed, argumentPresent else { return nil }
        let box = HandlerBox(screenId: screenId, handler: handler)
        box.register()
        return RefreshSubscription(box: box)
    }
}

/// An owned refresh listener. Deallocation detaches the observer —
/// no static handler hop, no manual cancellation required.
public final class RefreshSubscription: @unchecked Sendable {
    private let box: HandlerBox
    fileprivate init(box: HandlerBox) { self.box = box }
    deinit { box.unregister() }   // weak registry ⇒ deinit actually runs
}

/// The observer object itself. The Darwin center IGNORES the `object`
/// and `suspensionBehavior` AddObserver arguments (SDK header :52) and
/// hands the callback the OBSERVER pointer — so the box registers AS the
/// observer and the callback casts it back. CF does not retain the
/// pointer: the subscription's strong box ref is the retain.
final class HandlerBox: @unchecked Sendable {
    private let screenId: String
    private let handler: @MainActor () -> Void
    private let center = CFNotificationCenterGetDarwinNotifyCenter()
    private let name: CFNotificationName

    init(screenId: String, handler: @escaping @MainActor () -> Void) {
        self.screenId = screenId
        self.handler = handler
        self.name = Bellwether.refreshSignalName(for: screenId)
    }

    fileprivate func register() {
        let observer = Unmanaged.passRetained(self).toOpaque()
        CFNotificationCenterAddObserver(center, observer, { _, observer, _, _, _ in
            guard let observer else { return }
            let box = Unmanaged<HandlerBox>.fromOpaque(observer).takeUnretainedValue()
            box.fire()
        }, name.rawValue, nil, .deliverImmediately)
        Registry.shared.register(self, for: screenId)   // weak entry
    }

    fileprivate func unregister() {
        let observer = Unmanaged.passUnretained(self).toOpaque()
        CFNotificationCenterRemoveObserver(center, observer, name, nil)
        Registry.shared.unregister(screenId: screenId)
        Unmanaged.passUnretained(self).release()        // balance register's retain
    }

    fileprivate func fire() { Task { @MainActor in handler() } }
}

/// Weak per-screen registry — one LIVE subscription per id (last-wins
/// detaches the previous), but never OWNS one (strong storage would keep
/// deinit from firing — review F3).
private final class Registry: @unchecked Sendable {
    static let shared = Registry()
    private let lock = NSLock()
    private var live: [String: WeakBox] = [:]
    private final class WeakBox { weak var value: HandlerBox? }

    func register(_ box: HandlerBox, for screenId: String) {
        lock.lock(); defer { lock.unlock() }
        live[screenId] = WeakBox(value: box)
    }
    func unregister(screenId: String) {
        lock.lock(); defer { lock.unlock() }
        live.removeValue(forKey: screenId)
    }
}
```

**Implementation notes (binding):**
1. `passRetained`/`release` pairing across `register`/`unregister` is the ownership spine — leak-free by construction when subscription lifetime is respected; the lifetime test pins it.
2. The gate is deliberately two-part (explicit `subscriptionsAllowed` + launch arg): tests can exercise each half independently (`launchArgumentOverride` covers the arg half without ProcessInfo games).
3. Everything stays one file — the library IS its surface.

### Task A.3: Tests (complete file — `Tests/BellwetherTests/BellwetherTests.swift`)

```swift
import Testing
import CoreFoundation
@testable import Bellwether

@Suite("Bellwether", .serialized)
struct BellwetherTests {

    @Test("default DENY — gate closed ⇒ subscribe nil even with the argument")
    func defaultDeny() {
        Bellwether.subscriptionsAllowed = false
        Bellwether.launchArgumentOverride = "-uitest-live-refresh" // arg present
        #expect(Bellwether.subscribeRefresh(for: "home", handler: {}) == nil)
        Bellwether.launchArgumentOverride = nil
    }

    @Test("gate open but no argument ⇒ nil")
    func gateOpenNoArg() {
        Bellwether.subscriptionsAllowed = true
        Bellwether.launchArgumentOverride = nil              // real ProcessInfo: no arg in test host
        #expect(Bellwether.subscribeRefresh(for: "home", handler: {}) == nil)
    }

    @Test("signal name is canonical")
    func naming() {
        #expect(Bellwether.refreshSignalName(for: "home").rawValue as String == "com.crucible.refresh.home")
    }

    @Test("gate+arg: subscription delivers on post; deinit detaches")
    func deliveryAndLifetime() async {
        Bellwether.subscriptionsAllowed = true
        Bellwether.launchArgumentOverride = "-uitest-live-refresh"
        defer { Bellwether.subscriptionsAllowed = false; Bellwether.launchArgumentOverride = nil }
        let box = FireBox()
        var sub = Bellwether.subscribeRefresh(for: "lifetest") { box.fire() }
        #expect(sub != nil)
        CFNotificationCenterPostNotification(
            CFNotificationCenterGetDarwinNotifyCenter(),
            Bellwether.refreshSignalName(for: "lifetest"), nil, nil, true)
        try? await Task.sleep(for: .milliseconds(600))
        #expect(box.count == 1)
        sub = nil                                              // deinit detaches
        CFNotificationCenterPostNotification(
            CFNotificationCenterGetDarwinNotifyCenter(),
            Bellwether.refreshSignalName(for: "lifetest"), nil, nil, true)
        try? await Task.sleep(for: .milliseconds(600))
        #expect(box.count == 1)                               // no second delivery
    }

    @Test("two screens coexist — each handler fires only for its id")
    func multiScreen() async {
        Bellwether.subscriptionsAllowed = true
        Bellwether.launchArgumentOverride = "-uitest-live-refresh"
        defer { Bellwether.subscriptionsAllowed = false; Bellwether.launchArgumentOverride = nil }
        let a = FireBox(); let b = FireBox()
        let sa = Bellwether.subscribeRefresh(for: "a") { a.fire() }
        let sb = Bellwether.subscribeRefresh(for: "b") { b.fire() }
        defer { sa = nil; sb = nil }
        CFNotificationCenterPostNotification(
            CFNotificationCenterGetDarwinNotifyCenter(),
            Bellwether.refreshSignalName(for: "a"), nil, nil, true)
        try? await Task.sleep(for: .milliseconds(600))
        #expect(a.count == 1 && b.count == 0)
    }
}

final class FireBox: @unchecked Sendable {
    private let lock = NSLock(); private(set) var count = 0
    func fire() { lock.lock(); count += 1; lock.unlock() }
}
```

**Expected:** 5 passed (two gate tests are new — they pin the Debug-only contract).

**Run:** `swift test` in the repo (macOS host — Darwin center works host-side; iOS platform target declared but host tests suffice for this surface).
**Expected:** 4 passed.

### Task A.4: Push + tag

```bash
git init && git add -A && git commit -m "Bellwether 0.1.0 — the test-harness signal channel"
git remote add origin git@github.com:MainActorDev/Bellwether.git
git push -u origin main && git tag 0.1.0 && git push --tags
```

---

## Stage B — prebuilt integration (ios-consumer-intl)

### Task B.1: Clone + prebuild

```bash
cd /Volumes/berkakyo/Users/berkamain/Developer/w0rk/lionparcel
git clone git@github.com:MainActorDev/Bellwether.git
# Scipio from the app repo (its mint pin), targeting the sibling clone:
cd ios-consumer-intl && ~/.mint/bin/scipio prepare ../Bellwether \
  --support-simulators --framework-type static --configuration debug \
  -o XCFrameworks   # flag verified via scipio --help (-o, --output)
ls XCFrameworks/Bellwether.xcframework  # gate
```
(`XCFrameworks/` is git-ignored, so each machine prebuilds locally — same as Construkt.)

### Task B.2: Expose to LPHome — binaryTarget, self-contained in the consuming package

**Files:**
- Modify: `Modules/LPHome/Package.swift`

```swift
    targets: [
        .target(
            name: "LPHome",
            dependencies: [ /* existing… */ "Bellwether" ]
        ),
        // …existing…
        .binaryTarget(name: "Bellwether", path: "../../XCFrameworks/Bellwether.xcframework"),
    ]
```

(Consuming package declares its own binary target — cleaner than riding transitive visibility.)

**Gate:** resolve packages cleanly (`make resolve`), `import Bellwether` resolves in LPHome.

### Task B.3: CI-fallback + Crucible contract note

**CI context (verified 2026-09-25):** `.github/workflows/ios-tests-macos.yml` is the unit-test CI (PR + push to main/develop → `fastlane ios test_ci` on a macOS runner). When the runner's `XCFrameworks/` cache misses, `TestSupport.rb:273` swaps framework refs for SPM remotes via the root `Package.swift` (AllDependencies). Bellwether is **PUBLIC** (operator decision — ~150-line signal channel, no business logic), same resolution path as Construkt (`root Package.swift:13` already pulls MainActorDev/Construkt as a public URL) — no credential work.

**Files:**
- Modify: root `Package.swift` — dependencies += `.package(url: "https://github.com/MainActorDev/Bellwether", from: "0.1.0")`; AllDependencies target += `.product(name: "Bellwether", package: "Bellwether")`
- Modify: `fastlane/TestSupport.rb` `replace_xcframeworks_with_packages` — **[VERIFY at implementation: read the full method first]** map LPHome's `XCFrameworks/Bellwether.xcframework` ref to the remote product, mirroring the existing ConstruktKit handling (`:130-150`)

Contract strings are identical — `com.crucible.refresh.<screenId>` and `-uitest-live-refresh`. Nothing in Crucible changes; the library README is the contract's single source of truth.

---

## Stage C — LPHome refactor (follow-up branch `cust/bellwether-seam-lioclaw`, after #383 lands)

### Task C.1: Delete + rewire

**Files:**
- Modify: `HomeStoreAdapter.swift` — replace `signalBridge` + composition threading with:
```swift
    private let refreshSignal: RefreshSubscription?

    public init(store: FeatureStore<HomeFeature>, resolveHomeMenuItems: …) {
        …
        self.refreshSignal = Bellwether.subscribeRefresh(for: "home") { [weak store] in
            store?.dispatch(.loadData)
        }
    }
```
- Delete: `Modules/LPHome/Sources/LPHome/Runtime/HomeUITestRefreshSignal.swift`
- Delete: `liveRefreshOnAppear` threading — `AppScreenBuilder.swift` param, `HomeModule.makeStore` param + State init, `HomeSwiftUIComposition` param, `HomeFeature.State.liveRefreshOnAppear` field + `intentionallyUnprojectedStateFields` entry
- **Careful:** the reducer's once-guard bypass keyed on `liveRefreshOnAppear` — with the field gone, `loadData` re-dispatch must still bypass. Two options at implementation: (a) keep a `Bool` in State set at init from `Bellwether.isLiveRefreshEnabled` (minimal churn; the field stays but stops being *threaded*), or (b) the subscription's handler dispatches a dedicated intent (`.refreshRequested`) that always refetches. **Pick (a)** — smaller diff, guard semantics unchanged, and the state field documents itself.
- `Tests/Home/HomeFeatureTests.swift`: once-guard suite passes `liveRefreshOnAppear` via State init (option a) — tests keep passing with trivial changes; signal suite swaps `HomeUITestRefreshSignal` for `Bellwether.subscribeRefresh` + `Bellwether.overrideLiveRefresh(true)`.
- Delete: `Core/Helpers/UITestConfiguration.swift` — the app target returns to zero seam knowledge.
- **The gate set (F1, runtime):** inside LPHome (source-compiled ⇒ follows app configuration):

```swift
#if DEBUG
Bellwether.subscriptionsAllowed = true
#endif
```

  placed once at `HomeModule` (static init or adapter init). With option (a), `liveRefreshOnAppear` initializes from `Bellwether.isLiveRefreshEnabled` INSIDE the gated region — a Release build with junk launch args can never bypass the once-guard.

### Task C.2: Full suites + drill acceptance

```bash
# suites (expect 7/7 + refactor-affected ones adapted)
scripts/xcodebuild_cached.sh test … -only-testing:…HomeFeatureTests …
# drill: same as the signal drill — 8/8, in-place flips, negative control
```

### Task C.3: PR + Crucible drill comment

Branch `cust/bellwether-seam-lioclaw` from `develop`, PR to `develop`, drill evidence comment (same table as the signal drill).

---

## Files likely to change (summary)

| Repo | File | Change |
|---|---|---|
| Bellwether (new) | `Package.swift`, `Sources/Bellwether/Bellwether.swift`, `Tests/…` | the library |
| ios-consumer-intl | `Modules/LPHome/Package.swift` | +binaryTarget Bellwether |
| ios-consumer-intl | `Modules/LPHome/…/HomeStoreAdapter.swift` | one-line subscribe |
| ios-consumer-intl | `Modules/LPHome/…/HomeUITestRefreshSignal.swift` | DELETE |
| ios-consumer-intl | `App/Composition/AppScreenBuilder.swift` | seam param DELETE |
| ios-consumer-intl | `Modules/LPHome/…/HomeModule.swift`, `HomeSwiftUIComposition.swift`, `HomeFeature.swift` | threading DELETE (State keeps a self-documenting Bool, option a) |
| ios-consumer-intl | `Core/Helpers/UITestConfiguration.swift` | DELETE |
| ios-consumer-intl | `Tests/Home/HomeFeatureTests.swift` | adapt to Bellwether API |

## Risks / tradeoffs

- **Registry pointer plumbing** (A.2 note 1) is the one genuinely fiddly part — the plan pins the test contract (delivery, deinit-detach, multi-screen) so a wrong implementation fails tests, not silently passes.
- **Scipio output flag** marked `[VERIFY]`.
- **Option (a) keeps a State Bool** — purist-unclean vs option (b)'s dedicated intent, but chosen for minimal reducer churn; revisit if the reducer grows more seam-aware logic.
- **Bellwether is app-agnostic** — Crucible's contract strings now live in a third repo; README is the contract source of truth, and the Crucible drill remains the integration check.

## Decisions (operator, 2026-09-25 — post-review)

1. **F1: RUNTIME gate** — `Bellwether.subscriptionsAllowed`, default DENY; the consumer's `#if DEBUG` opens it; a deliberate QA/Staging build may opt in without code churn. RESOLVED.
2. **F5: Bellwether is PUBLIC** (org MainActorDev). The CI in question is `ios-tests-macos.yml` — the unit-test workflow (`fastlane ios test_ci`), not store delivery; it already resolves MainActorDev/Construkt as a public URL, so no credentials are needed. RESOLVED.

## Review

Reviewed 2026-09-25: `reviews/20260925T034500Z-bellwether-library-plan-review.md` (Needs revision). This revision folds F1 (default-deny runtime gate, two gate tests, Staging-negative acceptance), F2 (HandlerBox-as-observer, SDK-verified), F3 (weak registry), F4 (clean B.2), F5 (CI-fallback task, public repo), F6 (gate-scoped State init), F8 (`-o` flag). Remaining `[VERIFY]`s: TestSupport.rb mechanism read; GitHub name availability pre-publish.
