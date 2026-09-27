# Plan — Bellwether scaled composition: one gate, one line per module, zero domain pollution

> **For Hermes:** implement task-by-task with build/test verification between each. Three repos touched: Bellwether (library API addition) → ios-consumer-intl (recomposition of PR #385 + dependency rewiring) → no Crucible change (contract stable). Supersedes the composition currently on `cust/bellwether-home-seam-lioclaw`.

**Goal:** Recompose the Bellwether seam so it scales to any feature module: the gate opens **once per app**, module adoption is **two lines**, the domain layer carries **no seam state**, and the dependency wiring follows the repo's CI-proven ConstruktKit pattern.

**Architecture:** Three layers. (1) `Bellwether.activate()` — the sanctioned app-root entry (Debug/Staging builds only). (2) `LPCore` hosts `RefreshableFeature` + a `FeatureStore` extension that binds a store to its screen's signal, dispatching the feature's declared refresh intent. (3) Each feature module: one conformance (`static var refreshIntent`) + one adapter line (`bindRefreshSignal`). The once-guard becomes unconditional; explicit refresh rides a dedicated `refreshRequested` intent — the seam never touches domain State again.

**Tech:** Bellwether 0.2.0 (new API), LPCore (new file), FeatureStore/FeatureSpec from ConstruktKit 2.0.4 (no changes — extension-based integration).

**Facts pinned by inspection (2026-09-25):**

- `FeatureSpec.Intent` is a plain associated type (`FeatureSpec.swift:29`) — a protocol requiring `static var refreshIntent: Self.Intent` is expressible without touching Construkt.
- `FeatureStore.dispatch(_:)` is public (`FeatureStore.swift:65`) — the extension can dispatch.
- LPCore: Foundation-only, "no dependencies on other LP modules", but it's a *local SPM package that already declares path-deps in other modules' Package.swift patterns* — adding a Bellwether binaryTarget follows the exact `LPDesignSystem/Package.swift:23-26` recipe (verified shape). LPCore's "no LP deps" law is about *LP modules*; Bellwether is external infra, same class as Foundation. Dependency direction law (`app -> features -> LPFeatureSwiftUI/LPDesignSystem -> LPNavigationInterface/LPCore`) is respected: features already import LPCore.
- App root: `App/AppDelegate.swift:9` `didFinishLaunchingWithOptions` — already gates NFX with `#if DEBUG || STAGING` (a QA-build precedent for our gate).
- CI fallback map: `fastlane/TestSupport.rb:20+` `XCFRAMEWORK_TO_SPM_MAP` (ConstruktKit entry verified as the template); app framework links live in `project.yml:141+`.
- Current PR #385 composition (to be deleted): `HomeModule.swift` static-Void gate + State seeding, `HomeFeature.State.isLiveRefreshEnabled`, `HomeSwiftUIComposition` subscribe + adapter-init param, `HomeStoreAdapter` lint entry.
- Staging builds of the app are broken pre-existing (LPClaim, disclosed on #385) — this plan does not fix that; its gate therefore cannot be *runtime-verified* on a Staging build today. Unit-level pinning only.

---

## Stage A — Bellwether 0.2.0: `activate()` (+ test-override ergonomics)

### Task A.1: Add `activate()` to the library (failing test first)

**Files (repo `/Volumes/berkakyo/Users/berkamain/Developer/w0rk/lionparcel/Bellwether`):**
- Modify: `Sources/Bellwether/Bellwether.swift`
- Test: `Tests/BellwetherTests/BellwetherTests.swift` (append)

**Step 1 — failing test:**

```swift
@Test("activate() opens the gate; deactivate() closes it")
func activationLifecycle() {
    Bellwether.subscriptionsAllowed = false
    Bellwether.activate()
    #expect(Bellwether.subscriptionsAllowed == true)
    Bellwether.deactivate()
    #expect(Bellwether.subscriptionsAllowed == false)
}
```

**Step 2 — run:** `swift test` → FAIL (`activate` undefined).

**Step 3 — implement** (in `Bellwether` enum, Configuration section):

```swift
    /// The sanctioned consumer entry: call ONCE at app launch, from the app
    /// target, inside its Debug (or deliberate QA-build) compilation region.
    /// Sets-once semantics: an app that never calls it stays denied.
    public static func activate() {
        subscriptionsAllowed = true
    }

    /// Symmetric off-switch (tests / teardown).
    public static func deactivate() {
        subscriptionsAllowed = false
    }
```

**Step 4:** `swift test` → 6/6 pass.
**Step 5 — tag:** commit `Bellwether 0.2.0 — activate()/deactivate()`, push, `git tag 0.2.0 && git push --tags`.

---

## Stage B — ios-consumer-intl: dependency rewiring (ConstruktKit pattern)

> Do this FIRST on the branch so the recomposition compiles against the final wiring. CI verdict on the current shape is expected to fail a cache-miss runner (binaryTarget inside LPHome is invisible to TestSupport's swap); this stage removes the exposure regardless.

### Task B.1: Move the binaryTarget to LPCore

**Files:**
- Modify: `Modules/LPCore/Package.swift`
- Modify: `Modules/LPHome/Package.swift` (drop its binaryTarget; depend on product through LPCore)

`Modules/LPCore/Package.swift` targets section becomes:

```swift
    targets: [
        .target(
            name: "LPCore",
            dependencies: ["Bellwether"]
        ),
        .binaryTarget(name: "Bellwether", path: "../../XCFrameworks/Bellwether.xcframework"),
        .testTarget(name: "LPCoreTests", dependencies: ["LPCore"]),
    ],
    swiftLanguageModes: [.v5]
```

`Modules/LPHome/Package.swift`: remove `.binaryTarget(... Bellwether ...)` and the `"Bellwether"` target-dependency string; **declare the product properly** (no undeclared-import ride):

```swift
        .target(
            name: "LPHome",
            dependencies: [
                // …existing…
                .product(name: "LPCore", package: "LPCore")   // already present? verify; Bellwether re-exported via LPCore — see B.2
            ]
        ),
```

**Resolution rule to verify at implementation:** Swift doesn't re-export module visibility across package boundaries. LPHome importing `Bellwether` requires Bellwether to be a *product dependency of the LPHome package*. Two compliant options — **pick B.1a**:
- **B.1a (chosen):** LPHome's Package.swift keeps `.package(path: "../LPCore")` AND adds a direct product dep on the *package that owns the binaryTarget*. Since the binaryTarget lives in LPCore's package, LPHome can depend `.product(name: "Bellwether", package: "LPCore")` only if LPCore *re-exports* it as a product. Add to LPCore: `products: [.library(name: "LPCore", targets: ["LPCore"]), .library(name: "Bellwether", targets: ["Bellwether"])]` — LPCore's package now *vends* Bellwether; LPHome declares `.product(name: "Bellwether", package: "LPCore")`. Clean, explicit, one declaration of the binary.
- ~~B.1b~~: undeclared transitive import (the LPFeatureSwiftUI/ConstruktKit accident) — rejected; that class of implicitness is exactly the Claim Staging breakage.

### Task B.2: App-target link + CI fallback map

**Files:**
- Modify: `project.yml` (app target dependencies, next to ConstruktKit at ~:141):

```yaml
      - framework: XCFrameworks/Bellwether.xcframework
        embed: false
```

- Modify: `fastlane/TestSupport.rb` `XCFRAMEWORK_TO_SPM_MAP` (mirror the ConstruktKit entry):

```ruby
    "Bellwether.xcframework" => {
      package_name: "Bellwether",
      url: "https://github.com/MainActorDev/Bellwether",
      from: "0.2.0",
      products: ["Bellwether"]
    },
```

**Ordered checklist (review F3 — push only after step 5):**
1. Bellwether repo tagged `0.2.0` (Stage A complete)
2. `~/.mint/bin/scipio prepare . --support-simulators --framework-type static --configuration debug -o XCFrameworks` (from the app repo) → `XCFrameworks/Bellwether.xcframework` rebuilt at 0.2.0
3. Root `Package.swift`: bump Bellwether dep `from: "0.1.0"` → `from: "0.2.0"`
4. Regenerate `Package.resolved` (swift package resolve)
5. `xcodegen generate`
6. ONLY THEN commit + push

**Gate:** `cd Modules/LPHome && swift package resolve` clean; `xcodegen generate` produces a project containing `Bellwether.xcframework`.

---

## Stage C — the recomposition (delete the fragments, compose in two places)

### Task C.1: HomeFeature — dedicated refresh intent, unconditional guard

**Files:** `Modules/LPHome/Sources/LPHome/Runtime/HomeFeature.swift`

1. Add intent: `case refreshRequested` (next to `loadData`).
2. Reducer:

```swift
        case .loadData:
            // Once per screen creation — UNCONDITIONAL now (appearance never
            // refetches, Debug or production; explicit refresh uses
            // .refreshRequested). Failures keep the guard unset.
            if state.hasLoadedCountries {
                state.isLoadingCountries = false
                return .none
            }
            state.isLoadingCountries = true
            return .init(effects: [.loadRecommendedCountries])

        case .refreshRequested:
            // Explicit refresh (Bellwether signal): ALWAYS refetches.
            state.isLoadingCountries = true
            return .init(effects: [.loadRecommendedCountries])
```

3. **Delete:** `State.isLiveRefreshEnabled` (field + doc), and the old bypass condition.
4. Conformance (same file or a small extension):

```swift
extension HomeFeature: RefreshableFeature {
    /// The intent Bellwether's signal dispatches (bound via LPCore).
    public static var refreshIntent: Intent { .refreshRequested }
}
```

Add `import LPFeatureSwiftUI` to `HomeFeature.swift` (currently imports Foundation + ConstruktKit only — review F4). Compile order: Stage C.2's helper file first, then this.

### Task C.2: LPCore — `RefreshableFeature` + the bind extension

**Files:**
- Create: `Modules/LPCore/Sources/LPCore/RefreshSignal.swift`

*(Revision 2 — review F1 folded: where-clause on the EXTENSION; method @MainActor; default home LPFeatureSwiftUI.)*

```swift
import Bellwether
import ConstruktKit

/// A feature whose store can be refreshed by an external signal (Crucible
/// drills). The feature declares WHICH intent means "refetch now".
public protocol RefreshableFeature: FeatureSpec {
    static var refreshIntent: Intent { get }
}

extension FeatureStore where F: RefreshableFeature {
    /// Bind this store to its screen's refresh signal. The CALLER (an
    /// adapter, @MainActor) owns the returned subscription — its deinit
    /// detaches the Darwin observer. Nil when the seam is closed (production).
    @MainActor
    @discardableResult
    public func bindRefreshSignal(screenId: String) -> RefreshSubscription? {
        Bellwether.subscribeRefresh(for: screenId) { [weak self] in
            self?.dispatch(F.refreshIntent)
        }
    }
}
```

**Placement (resolved):** default home = **LPFeatureSwiftUI** (`Modules/LPFeatureSwiftUI/Sources/LPFeatureSwiftUI/RefreshSignal.swift`) — it already imports ConstruktKit, is the Feature-system runtime, and keeps LPCore's Foundation-only admission law intact. Compile-verify the Swift 6 closure capture there BEFORE writing dependents (review F1); if it errors, fall back to LPCore (Swift 5 mode) — API identical.

### Task C.3: HomeStoreAdapter — the whole seam, self-composed

**Files:** `Modules/LPHome/Sources/LPHome/SwiftUI/HomeStoreAdapter.swift`

1. **Delete:** the `refreshSignal` init parameter (revert to the two-param init).
2. Subscribe in-init:

```swift
    /// The Bellwether seam, whole and entire. The adapter owns the
    /// subscription: observer lifetime == adapter lifetime.
    private let refreshSignal: RefreshSubscription?

    public init(
        store: FeatureStore<HomeFeature>,
        resolveHomeMenuItems: @escaping () -> [HomeMenuItem] = { HomeMenuItem.defaultItems }
    ) {
        self.resolveHomeMenuItems = resolveHomeMenuItems
        self.refreshSignal = store.bindRefreshSignal(screenId: "home")
        super.init(store: store)
        menuItems = resolveHomeMenuItems()
    }
```

3. **Delete:** the `#if DEBUG intentionallyUnprojectedStateFields` block — the lint entry dies with the State field.
4. **Delete from HomeSwiftUIComposition:** the `Bellwether.subscribeRefresh` call + `refreshSignal:` argument (back to plain `HomeStoreAdapter(store:resolveHomeMenuItems:)`); remove `import Bellwether`.
5. **Delete from HomeModule:** the `openBellwetherGate` static-Void block AND the `initialState.isLiveRefreshEnabled` seeding (makeStore returns to its pre-#385 shape); remove `import Bellwether` if now unused (HomeFeature's conformance needs `RefreshableFeature` from LPCore/LPFeatureSwiftUI, not Bellwether).

### Task C.4: App root — the ONE gate

**Files:** `App/AppDelegate.swift` (`didFinishLaunchingWithOptions`, before `setUpFirebase()`):

```swift
        #if DEBUG
        // The Bellwether gate: one call, one place. UI-test refresh signals
        // (Crucible) only exist in Debug builds; production archives ship
        // the default-deny library untouched.
        Bellwether.activate()
        #endif
```

(+ `import Bellwether`.) Note the NFX precedent one line up uses `#if DEBUG || STAGING` — we deliberately use **DEBUG only** (operator decision: runtime gate, Debug default; a future QA build opts in by widening THIS one line).

### Task C.5: Tests — rewrite the two seam suites

**Files:** `Tests/Home/HomeFeatureTests.swift`

1. **Once-guard suite:** drop `isLiveRefreshEnabled` param; add a case asserting `.refreshRequested` refetches after a successful load (PASS-1 → PASS-2), and that plain `.loadData` remains a no-op after success (guard unconditional).
2. **Signal suite (review F2 — no adapter, no app-target types):** REBUILDS on the once-guard suite's existing mock-store fixture: `store.bindRefreshSignal(screenId: "home")` with `Bellwether.subscriptionsAllowed = true` + `launchArgumentOverride = "-uitest-live-refresh"` set (the library's test-override API — that's what it exists for), hold the subscription in a local `var` (deinit-detach at scope end), post the Darwin notification, expect `PASS-2`. This REPLACES the previous `HomeBellwetherSignalTests` suite (review F6).
3. Both suites' `makeStore` helpers lose the seam param (State field deleted).

**Run (same invocation as before, all three Home suites) — expected:** all pass; count ≥ 7.

---

## Stage D — verification & close-out

### Task D.1: Full local gates
1. `swift test` in Bellwether repo — 6/6.
2. App: full Home suites via `scripts/xcodebuild_cached.sh test …` — green.
3. `pnpm run check` in Crucible — unaffected (977/977; no server change; launch-arg + signal contract untouched).

### Task D.2: Live drill (same bar as run_23e64f36)
1. Build Debug for drill sim, install.
2. Proxy + routing on, drill user, `POST /api/templates/tpl_4d7b6b27/play`.
3. **Accept:** 8/8; both `refresh home (signal) · N request(s) confirmed`; 3 preset-matched fetches; one launch; frames = home dashboard with in-place chip flips (vision-verify 3 evidence PNGs).
4. **Positive control:** manual launch with arg → post signal → fetch fires.
5. **Negative control (unit-level, per disclosure):** Bellwether suite pins gate-closed halves. (Staging-build runtime check remains blocked by pre-existing LPClaim breakage — unchanged disclosure.)
6. Cleanup: routing off, mitm stop, app terminate, drill user delete.

### Task D.3: Push, PR update, docs
1. Commit + push to `cust/bellwether-home-seam-lioclaw` (PR #385 updates in place).
2. PR comment: recomposition rationale (one gate / two-line adoption / zero domain pollution), new drill evidence, the B.1a wiring note.
3. Bellwether README: add `activate()` to the adoption snippet; bump version notes to 0.2.0.
4. Crucible BACKLOG: note under #12 — seam composition finalized (library 0.2.0; module adoption pattern documented in Bellwether README).

---

## Files likely to change (summary)

| Repo | File | Change |
|---|---|---|
| Bellwether | `Sources/Bellwether/Bellwether.swift` | +`activate()`/`deactivate()` |
| Bellwether | `Tests/…` | +1 test |
| intl | `Modules/LPCore/Package.swift` | +binaryTarget +vend Bellwether product (or placement moves to LPFeatureSwiftUI — C.2 VERIFY) |
| intl | `Modules/LPCore/Sources/LPCore/RefreshSignal.swift` | NEW: `RefreshableFeature` + `bindRefreshSignal` |
| intl | `Modules/LPHome/Package.swift` | drop binaryTarget; product dep via LPCore |
| intl | `Modules/LPHome/…/HomeFeature.swift` | +`refreshRequested`, unconditional guard, conformance; −State field |
| intl | `Modules/LPHome/…/HomeStoreAdapter.swift` | self-subscribe in init; −init param, −lint block |
| intl | `Modules/LPHome/…/HomeSwiftUIComposition.swift` | −subscribe, −import |
| intl | `Modules/LPHome/…/HomeModule.swift` | −gate static, −State seeding, −import |
| intl | `App/AppDelegate.swift` | +`Bellwether.activate()` (the ONE gate) |
| intl | `project.yml` | +Bellwether framework link |
| intl | `fastlane/TestSupport.rb` | +XCFRAMEWORK_TO_SPM_MAP entry |
| intl | root `Package.swift` + lockfiles | 0.1.0 → 0.2.0 |
| intl | `Tests/Home/HomeFeatureTests.swift` | suites rewritten to intent-based seam |

## Risks / tradeoffs

- **C.2 placement** (LPCore vs LPFeatureSwiftUI) is the one genuine unknown — both are legitimate; decided by LPCore's admission law at implementation. Zero API difference.
- **Losing appear-refetch under the seam** — deliberate: appearance NEVER refetches now, even under Crucible. Back-forward/tab-retap gestures on once-fetching screens will fail guard 1 — correct; such screens should use `signal` (home does). Recorded as intended behavior.
- **Bellwether 0.2.0 rebuild** — xcframework must be regenerated + root pin bumped together or scipio cache serves 0.1.0 symbols (no `activate`) — flagged in B.2.
- **Backward compat:** Bellwether 0.2.0 is additive (0.1.0 consumers unaffected). PR #385 force-history stays linear (no rebase needed — commits stack on the branch).
- **Staging runtime verification still blocked** by the pre-existing LPClaim breakage (disclosed on #385) — unchanged; not this plan's scope.

## Open questions

None blocking. Two implementation-time [VERIFY]s (C.2 placement; B.2 scipio rebuild ordering) are flagged in-line.
