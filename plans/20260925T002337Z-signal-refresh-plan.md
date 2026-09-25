# Plan — Signal refresh: stay at Home, refetch in place

> **For Hermes:** implement task-by-task with build/test verification between each. Two repos, hard-ordered stages.

**Goal:** Replace home's `back-forward` refresh gesture with a Darwin-notification signal: Crucible posts `com.crucible.refresh.home` into the simulator, the app (under the `-uitest-live-refresh` seam) re-fetches in place — no navigation, no pull-to-refresh, no relaunch. The screen never leaves Home.

**Architecture:** The app's LPHome module gains a self-contained Darwin-observer bridge (CoreFoundation is module-available to the SPM package; no Core/app-target dependency, so the ProcessInfo-free law holds — the bridge activates only when the already-threaded `liveRefreshOnAppear` flag is true). Crucible gains a fifth refresh gesture `signal` in the registry grammar; playback's refresh verb posts the notification via a new device-op helper in the allowlisted `apps.ts` module, then GUARD 1 (traffic verification) runs unchanged.

**Tech:** CFNotificationCenter (Darwin center), `xcrun simctl spawn <udid> notifyutil -p <name>`, existing screen-runner verb machinery.

**Context:** ios-consumer-intl branch `cust/uitest-live-refresh-lioclaw` (PR #383, commit `70d0f306`) already ships the once-per-creation fetch + seam. Crucible `feat/screen-state-runner` (`5380eb9`) passes `-uitest-live-refresh` at playback launch. This plan supersedes the `back-forward` registry entry for home.

**Key facts pinned by earlier probes:**
- The simulator has its **own notifyd domain** — host `notifyutil` does NOT reach it; the post must run via `simctl spawn` inside the sim.
- `simctl spawn` currently errors on the drill sim (`LaunchdSimError 111` — residue of the SpringBoard restart). Task 0 gates on this; a sim reboot is the expected fix.
- `apps.ts` is in the device-boundary allowlist (`server/test/device-boundary.test.ts`) — the new helper MUST live there; no allowlist change needed.
- LPHome is SPM (`Modules/LPHome/Package.swift` auto-globs Sources) — new Swift files there need **no pbxproj registration** (unlike Core/ files).

**Contract (single source of truth):**
- Signal name: `com.crucible.refresh.<screenId>` (derived; no new registry field). For home: `com.crucible.refresh.home`.
- Semantics: signal ⇒ the subscribed store dispatches its load intent. Guard 1 then requires ≥1 preset-matched, run-attributed request within the existing `worldConfirmMs` budget.
- Production launches register **no observer** — the listener itself is the seam; once-guard behavior for users is untouched.

---

## Stage 0 — Feasibility gate (Crucible repo, no code)

### Task 0.1: Reboot drill sim, verify notifyutil delivery

**Files:** none.

**Steps:**
```bash
xcrun simctl shutdown 30B28173-D2C6-4D1A-B544-49EB4BEF7A4D
xcrun simctl boot 30B28173-D2C6-4D1A-B544-49EB4BEF7A4D
xcrun simctl bootstatus 30B28173-D2C6-4D1A-B544-49EB4BEF7A4D -b
xcrun simctl spawn 30B28173-D2C6-4D1A-B544-49EB4BEF7A4D notifyutil -p com.crucible.refresh.probe
echo "rc=$?"   # EXPECT rc=0, no LaunchdSimError
```
**Gate:** if spawn still fails after reboot → STOP, report; do not build on a broken transport.
**Success probe (optional but recommended):** in a scratch macOS CLI or via the app itself in Stage A, confirm an observer sees the post. The unit test in Task A.3 covers this in-process.

**Commit:** none.

---

## Stage A — App: Darwin observer bridge (ios-consumer-intl)

Branch: existing `cust/uitest-live-refresh-lioclaw` (same PR #383 — the signal is part of the same seam story).

### Task A.1: Write the failing test — signal dispatches loadData

**Files:**
- Modify: `Tests/Home/HomeFeatureTests.swift` (append suite)

**Step 1: Write failing test** — in-process post (unit tests run inside a host app; Darwin center works there):

```swift
@Suite("Home Crucible Refresh Signal", .serialized)
struct HomeRefreshSignalTests {

    @Test("Darwin signal dispatches loadData (bypasses once-guard under seam)")
    func signalRefetches() async {
        let auth = MockHomeAuthSession(isLoggedIn: false)
        let svc = SucceedingHomeShipmentService() // F2: make payloads stateful — first call PASS-1, second PASS-2 (adapt the mock with an internal counter)
        let store = makeStore(authSession: auth, liveRefreshOnAppear: true, shipmentService: svc)
        await store.sendAndDrain(.loadData)
        let first = store.state.wrappedValue.countries
        #expect(first.count > 0)

        let bridge = HomeUITestRefreshSignal(name: "com.crucible.refresh.home") { [weak store] in
            Task { @MainActor in store?.sendAndDrain(.loadData) }
        }
        defer { bridge.cancel() }
        CFNotificationCenterPostNotification(
            CFNotificationCenterGetDarwinNotificationCenter(),
            CFNotificationName("com.crucible.refresh.home" as CFString),
            nil, nil, true
        )
        // STATEFUL payload (review F2): service returns PASS-1 then PASS-2 —
        // only a real re-fetch observes PASS-2. A no-op signal fails loudly.
        try? await Task.sleep(for: .milliseconds(1000)) // F6: CI variance headroom
        #expect(store.state.wrappedValue.countries.first?.city == "PASS-2")
    }
}
```

**Step 2: Run to verify failure**

```bash
cd /Volumes/berkakyo/Users/berkamain/Developer/w0rk/lionparcel/ios-consumer-intl
scripts/xcodebuild_cached.sh test -project LionParcelLogisticsINTL.xcodeproj \
  -scheme LionParcelLogisticsINTL \
  -destination 'platform=iOS Simulator,id=C33FC73C-AA6B-44BB-8359-EF4057D04515' \
  -only-testing:LionParcelLogisticsINTLTests/HomeRefreshSignalTests
```
Expected: FAIL — `HomeUITestRefreshSignal` undefined.

### Task A.2: Implement the bridge + wire into makeStore

**Files:**
- Create: `Modules/LPHome/Sources/LPHome/Runtime/HomeUITestRefreshSignal.swift` (SPM — no pbxproj edit)
- Modify: `Modules/LPHome/Sources/LPHome/Composition/HomeModule.swift:62-82` (`makeStore`)

**Bridge (complete file):**

```swift
import Foundation

/// Darwin-notification bridge for UI-test refresh signals (Crucible).
///
/// When the app is launched with `-uitest-live-refresh` the home store
/// registers here; posting `com.crucible.refresh.home` into the simulator
/// (host: `xcrun simctl spawn <udid> notifyutil -p <name>`) re-dispatches
/// the load intent — an in-place refresh with no navigation. Production
/// launches never register: the listener IS the seam.
///
/// CFNotificationCenter callbacks are C function pointers — no captures.
/// The singleton hop is the standard workaround; one live bridge per name.
final class HomeUITestRefreshSignal: @unchecked Sendable {

    private static let handlerLock = NSLock()
    private static var handler: (@MainActor () -> Void)?

    private let name: CFNotificationName
    private let center = CFNotificationCenterGetDarwinNotificationCenter() // F3: no stored observer — deinit recomputes the raw pointer

    init(name: String, handler: @escaping @MainActor () -> Void) {
        self.name = CFNotificationName(name as CFString)
        HomeUITestRefreshSignal.handlerLock.lock()
        HomeUITestRefreshSignal.handler = handler
        HomeUITestRefreshSignal.handlerLock.unlock()
        // C callback — free function, no captures
        CFNotificationCenterAddObserver(center, UnsafeRawPointer(Unmanaged.passUnretained(self).toOpaque()),
            { _, _, _, _, _ in
                HomeUITestRefreshSignal.handlerLock.lock()
                let h = HomeUITestRefreshSignal.handler
                HomeUITestRefreshSignal.handlerLock.unlock()
                Task { @MainActor in h?() }
            }, name.rawValue, nil, .deliverImmediately)
    }

    deinit {
        CFNotificationCenterRemoveObserver(center, UnsafeRawPointer(Unmanaged.passUnretained(self).toOpaque()), name, nil)
    }

    func cancel() {
        HomeUITestRefreshSignal.handlerLock.lock()
        HomeUITestRefreshSignal.handler = nil
        HomeUITestRefreshSignal.handlerLock.unlock()
    }
}
```

**Pitfalls encoded above (do not "simplify" away):**
1. The callback cannot capture — static handler + lock is the bridge.
2. Handler hops to `@MainActor` via `Task` — the reducer dispatch must stay on main.
3. `deinit` removes the observer — the store owns the bridge, so observer lifetime == store lifetime.
4. `[VERIFY]` the exact `CFNotificationCenterAddObserver` Swift signature against the SDK while implementing (CF opaque types drift between Xcode versions; adjust the `observer` storage type to whatever compiles — it is only passed back for removal).

**Wiring in `makeStore` (after `store.dispatch(…sessionLoaded…)`, before `return store`):**

```swift
        if liveRefreshOnAppear {
            let bridge = HomeUITestRefreshSignal(name: "com.crucible.refresh.home") { [weak store] in
                store?.dispatch(.loadData)
            }
            store.holdCrucibleBridge(bridge)   // tiny associated-object box — see note
        }
```

`FeatureStore` is an external type (Construkt) — attach via a small `final class` box + associated object, OR (preferred if simpler) return the bridge up from `makeStore` alongside the store and hold it in `HomeStoreAdapter` (a class we own: add `private var signalBridge: HomeUITestRefreshSignal?` and set it from `makeStoreAdapter`). **Decide at implementation by reading `HomeStoreAdapter`'s init; the adapter-hold path avoids associated objects — prefer it.** `.loadData` dispatched with `liveRefreshOnAppear == true` already bypasses the once-guard in the reducer — no reducer change needed.

**Step 3: Run the A.1 test** — expected PASS.
**Step 4: Run the full Home suites** (both existing suites must stay green):

```bash
scripts/xcodebuild_cached.sh test … -only-testing:LionParcelLogisticsINTLTests/HomeFeatureTests \
  -only-testing:LionParcelLogisticsINTLTests/HomeCountriesOnceGuardTests \
  -only-testing:LionParcelLogisticsINTLTests/HomeRefreshSignalTests
```
Expected: 7/7 passed.

**Feature System lint:** no new `State` fields ⇒ no `@Projected`/`intentionallyUnprojectedStateFields` changes.

### Task A.3: Commit

```bash
git add Modules/LPHome/Sources/LPHome/Runtime/HomeUITestRefreshSignal.swift \
        Modules/LPHome/Sources/LPHome/Composition/HomeModule.swift \
        Modules/LPHome/Sources/LPHome/SwiftUI/HomeSwiftUIComposition.swift \
        Modules/LPHome/Sources/LPHome/SwiftUI/HomeStoreAdapter.swift \
        Tests/Home/HomeFeatureTests.swift
git commit -m "feat(home): Darwin signal refresh under the uitest seam — com.crucible.refresh.home re-dispatches loadData in place (no navigation); observer registered only when liveRefreshOnAppear; bridge lifetime = adapter lifetime"
git push
```

---

## Stage B — Crucible: `signal` gesture

Branch: `feat/screen-state-runner` (already carries the launch-arg commit).

### Task B.1: Device-op helper (failing test first)

**Files:**
- Modify: `server/src/manual/apps.ts` (add helper next to `openSimulatorUrl`, ~line 38)
- Test: `server/test/signal-refresh.test.ts` (new)

**Step 1: Failing test** — mock `execFile` is overkill; assert the helper's argv shape via injection seam. Follow how `app-install.test.ts` fakes exec if a pattern exists; otherwise thin: test only the screen-runner call path (B.3) and keep the helper a pure `execFileAsync('xcrun', ['simctl','spawn',udid,'notifyutil','-p',name], { timeout: 5_000 })` five-liner reviewed by eye. **[VERIFY] existing fake-exec pattern in `server/test/app-install.test.ts` first and reuse it if present.**

**Step 2: Implement:**

```ts
/** Post a Darwin notification INTO the simulator's own notifyd domain
 *  (host notifyutil does not reach the sim — must spawn inside it).
 *  Consumed by the app's uitest refresh seam: signal ⇒ in-place refetch. */
export async function postDarwinNotification(udid: string, name: string): Promise<void> {
  await execFileAsync('xcrun', ['simctl', 'spawn', udid, 'notifyutil', '-p', name], { timeout: 5_000 });
}
```

`apps.ts` is already allowlisted for the device-boundary tripwire — **no allowlist change, no new files with `simctl` references.**

### Task B.2: Grammar — fifth gesture

**Files:**
- Modify: `shared/src/app-screens.ts:18` (union), `:56` (`GESTURES` set), refresh validation block (~`:109-130` — `signal` needs NO selector/back/deepLink; assert those stay absent or optional-ignored)
- Test: `server/test/app-screens.test.ts` (append cases)

**Step 1: Failing tests:**
```ts
// signal gesture accepted, no selector required
expect(validateScreen({ id: 's', refresh: { gesture: 'signal' }, states: { ...valid } }).errors).toEqual([]);
// unknown key rules unchanged; back-forward still requires selector (regression pin)
```
**Step 2:** widen the union + set; ensure the `signal` branch in validation does not demand `selector`. Update the doc comment at `app-screens.ts:4`.
**Step 3:** `CI=true npx vitest run test/app-screens.test.ts` — green.

### Task B.3: Runner — refresh verb branch

**Files:**
- Modify: `server/src/manual/screen-runner.ts:199-235` (add branch) + new private `postSignal` (dynamic-import pattern mirroring `openUrl` at `:79-86`)
- Test: extend `server/test/signal-refresh.test.ts`

**Step 1: Failing test** — fake alloy seam as `launch-arg.test.ts` does; `vi.mock('../src/manual/apps.ts')` to capture `postDarwinNotification` calls; registry with `refresh: { gesture: 'signal' }`; run `refresh('home')`; assert one call with `['<udid>', 'com.crucible.refresh.home']` and — with a traffic row seeded post-mark — `{ ok: true }` (guard 1 satisfied through the existing poll).

**Step 2: Implement** — in `refresh()`:

```ts
} else if (gesture === 'signal') {
      // in-place refetch: the app's uitest seam listens for a Darwin
      // notification — no navigation, no relaunch. Host notifyutil cannot
      // reach the sim's notifyd; spawn inside it (apps.ts, allowlisted).
      const fail = await this.postSignal(`com.crucible.refresh.${screenId}`, 'signal refresh');
      if (fail) return fail;
} else if (gesture === 'deepLink' && scr.refresh?.deepLink) {
```

and the private helper (same shape as `openUrl`):

```ts
  private async postSignal(name: string, what: string): Promise<VerbOutcome | null> {
    try {
      const { postDarwinNotification } = await import('./apps.ts');
      await postDarwinNotification(this.d.udid, name);
      return null;
    } catch (err) {
      return { ok: false, code: 'SCREEN_ENTRY_FAILED', note: `${what} failed: ${err instanceof Error ? err.message : String(err)} (simctl spawn broken? reboot the sim)` };
    }
  }
```

GUARD 1 (the traffic poll after the gesture chain) runs **unchanged** — the signal must still produce a preset-matched request or the step fails `SWAP_NOT_CONFIRMED`.

**Step 3:** `CI=true npx vitest run test/signal-refresh.test.ts test/screen-runner.test.ts` — green.

### Task B.4: Round-trip pin (registry flip moved to Stage C — review F4)

**Files:**
- Test: `server/test/app-screens.test.ts` (append): export-to-YAML of a `signal` screen emits `refresh:\n    gesture: signal` with no selector; import round-trips it. (Exporter code needs NO change — verified `app-screens.ts:121-130` emits bare gesture when no selector/deepLink.)

**Live registry flip is Task C.0** — deliberately after the bridged app is installed, so no window exists where the registry signals and no listener is present.

**BACKLOG entry (review F5, pre-existing):** YAML exporter drops `back:` anchors and selector `point:` — back-forward registries lose the return leg on round-trip. Out of scope here.

### Task B.4b: Web editor — `signal` (+ backfilled `deepLink`) options (review F1, operator-approved "both")

**Files:**
- Modify: `web/src/pages/ScreensPage.vue:586-591` (select options), `:128-137` (`formToScreen` branches)

**Step 1:** add to the gesture `<select>`:
```html
          <option value="deepLink">deepLink</option>
          <option value="signal">signal</option>
```
**Step 2:** `formToScreen` — after the `deepLink` branch add:
```ts
  } else if (f.refreshGesture === 'signal') {
    refresh = { gesture: 'signal' };
  }
```
**Step 3:** confirm `screenToForm` (`:99` region) round-trips: `refreshGesture: r?.gesture ?? ''` already carries any gesture id; away-id input stays empty and optional for signal — verify no validation demands it.
**Step 4:** `pnpm run check` (vue-tsc) green; manual: open home's editor, change nothing, save, GET registry → `refresh.gesture === 'signal'` intact; set a screen to deepLink via UI → persists.

### Task B.5: Full gate + commit

```bash
cd /Volumes/berkakyo/Users/berkamain/Developer/w0rk/lionparcel/ai/crucible && pnpm run check   # EXPECT 972+n passed, 0 failed
git add server/src/manual/apps.ts server/src/manual/screen-runner.ts shared/src/app-screens.ts \
        server/test/signal-refresh.test.ts server/test/app-screens.test.ts
git commit -m "feat(screens): signal refresh gesture — playback posts com.crucible.refresh.<screen> into the sim's notifyd (spawn-in-sim helper in apps.ts, allowlisted); app's uitest seam re-fetches in place; guard 1 unchanged"
git push
```

---

## Stage C — Live drill + evidence (the acceptance bar)

### Task C.0: Registry flip for home (moved here per review F4 — app understands the signal NOW)

```bash
curl -s -b /tmp/ckX.txt http://127.0.0.1:9230/api/app-screens/com.lioparcel.services.consumer.int-dev > /tmp/reg.json
python3 - <<'PY'
import json
d = json.load(open('/tmp/reg.json'))
for s in d['screens']:
    if s['id'] == 'home':
        s['refresh'] = { 'gesture': 'signal' }
json.dump(d, open('/tmp/reg2.json','w'))
PY
curl -s -b /tmp/ckX.txt -X PUT http://127.0.0.1:9230/api/app-screens/com.lioparcel.services.consumer.int-dev \
  -H 'content-type: application/json' -d @/tmp/reg2.json   # carries revision; stale -> 409
```
**Verify:** GET shows home `refresh.gesture === 'signal'`, away-anchor fields gone.

### Task C.1: Rebuild + install the app with the bridge

```bash
scripts/xcodebuild_cached.sh build -project LionParcelLogisticsINTL.xcodeproj \
  -scheme LionParcelLogisticsINTL \
  -destination 'platform=iOS Simulator,id=30B28173-D2C6-4D1A-B544-49EB4BEF7A4D' \
  -derivedDataPath .derived-data
xcrun simctl install 30B28173-D2C6-4D1A-B544-49EB4BEF7A4D \
  .derived-data/Build/Products/Debug-iphonesimulator/LionParcelLogisticsINTL.app
```

### Task C.2: Run the drill case through playback (proxy + routing on, drill user re-created as before)

```bash
curl -s -b /tmp/ckdrill.txt -X POST http://127.0.0.1:9230/api/templates/tpl_4d7b6b27/play \
  -H 'content-type: application/json' \
  -d '{"udid":"30B28173-D2C6-4D1A-B544-49EB4BEF7A4D","triggeredBy":"drill"}'
```

**Acceptance — ALL must hold:**
1. Run passes 8/8; steps 3 and 6 are `refresh home` executing the **signal** (no See-all roundtrip).
2. Traffic: exactly 3 preset-matched fetches, one per world, seconds apart, zero relaunches (one cold launch only).
3. Video/frames: chips flip **in place** — home stays on screen across both swaps. Grab the 3 evidence PNGs + step table as before.
4. Negative (manual, quick): launch **without** the arg, activate `countries-my`, post the signal → **no fetch** (observer absent; production untouched).

### Task C.3: Evidence + close-out
- Post drill matrix + frames to PR #383 (comment).
- BACKLOG note under #11: signal gesture superseded back-forward for home.
- Cleanup: routing off, mitm stop, app terminate, drill user delete.

---

## Files likely to change (summary)

| Repo | File | Change |
|---|---|---|
| intl | `Modules/LPHome/Sources/LPHome/Runtime/HomeUITestRefreshSignal.swift` | NEW — Darwin bridge |
| intl | `Modules/LPHome/Sources/LPHome/Composition/HomeModule.swift` | register bridge when seam on |
| intl | `Modules/LPHome/Sources/LPHome/SwiftUI/HomeStoreAdapter.swift` | hold bridge (lifetime) |
| intl | `Modules/LPHome/Sources/LPHome/SwiftUI/HomeSwiftUIComposition.swift` | thread bridge if adapter-hold chosen |
| intl | `Tests/Home/HomeFeatureTests.swift` | +1 suite (signal refetch) |
| crucible | `server/src/manual/apps.ts` | +`postDarwinNotification` |
| crucible | `shared/src/app-screens.ts` | gesture union + validation |
| crucible | `server/src/manual/screen-runner.ts` | `signal` branch + `postSignal` |
| crucible | `server/test/signal-refresh.test.ts` | NEW |
| crucible | `server/test/app-screens.test.ts` | +2 cases |
| crucible | registry DATA (DB) | home refresh → `signal` |

## Risks / tradeoffs

- **`simctl spawn` transport** — currently broken on the drill sim (`LaunchdSimError 111`); Task 0 gates. If a reboot doesn't fix it, the whole design needs a different in-sim trigger — stop and report rather than force it.
- **CF API drift** — `CFNotificationCenterAddObserver`'s Swift spelling varies by SDK; the plan marks `[VERIFY]` at the implementation site.
- **Signal tests the signal path, not user-reachable refresh** — vacuous for home by the user's own constraint (no PTR for Home, refresh must be invisible); the grammar still keeps `pull`/`back-forward`/`tab-retap` for screens with real gestures.
- **Name coupling** — `com.crucible.refresh.<screenId>` is a contract between app code and runner derivation; documented in both files; no runtime validation possible across the boundary (guard 1 is the behavioral check).
- **One live handler per name** (static hop) — fine for one home screen instance; if home ever exists twice (split view), the bridge needs keying — YAGNI now.

## Decisions (operator, 2026-09-25)

1. **Extend PR #383** — Stage A lands on `cust/uitest-live-refresh-lioclaw`. RESOLVED.
2. **Web editor gets `signal` AND `deepLink` options** (review F1 scope = both). RESOLVED.
3. **Retire `liveRefreshOnAppear`'s appear-refetch?** Keep it — harmless under the arg, gives manual drills the appear path; the signal is additive (YAGNI).
4. **Static-handler last-writer-wins** (review F7): accepted — one home store per process in production and in drills; re-key if a second instance ever exists.

## Review

Reviewed 2026-09-25: `reviews/20260925T002337Z-signal-refresh-plan-review.md` (verdict: Needs revision). F1–F4, F6 folded into this revision; F5 → BACKLOG; F7 → decision 4. All `[VERIFY]`s resolved against SDK headers and live code.
