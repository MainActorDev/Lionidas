# Review — Signal refresh plan (`20260925T002337Z-signal-refresh-plan.md`)

- Reviewed: `plans/20260925T002337Z-signal-refresh-plan.md` (as saved 2026-09-25)
- Evidence sources: live code in both repos (checked 2026-09-25), iPhoneSimulator SDK headers (Xcode 27A266a), prior session drills (back-forward matrix, launch-arg evidence)
- Verdict: **Needs revision** — 2 High findings (web-UI data-loss path; a test that cannot fail for the reason it exists). All findings have concrete corrections; no architectural objection.

## What was verified independently (not taken from the plan)

| Plan claim | Check | Result |
|---|---|---|
| `CFNotificationCenterAddObserver` Swift shape | SDK header `CFNotificationCenter.h:63` + callback typedef `:23` | ✅ plan's call matches; `.deliverImmediately` (=4) is a valid suspension behavior; `PostNotification`'s trailing args are ignored on the Darwin center (harmless in the test) |
| `store.dispatch` / `sendAndDrain` exist on FeatureStore | Construkt `FeatureStore.swift:65,82` | ✅ |
| `apps.ts` is device-boundary allowlisted | `server/test/device-boundary.test.ts:25` (`manual/apps.ts` in ALLOWED) | ✅ no allowlist change needed |
| LPHome is SPM ⇒ no pbxproj edit for new Swift file | `Modules/LPHome/Package.swift` path pattern (same as `HomeFeature.swift` et al., which appear nowhere in pbxproj file lists) | ✅ |
| fake-exec test pattern exists for B.1 | `server/test/app-install.test.ts:12` `fakeXcrun(dir, {delayMs, fail})` | ✅ the plan's `[VERIFY]` resolves to **use it** |
| YAML exporter needs no change for `signal` | `server/src/routes/app-screens.ts:121-130` — emits `gesture:` + optional selector/deepLink; `signal` emits bare gesture | ✅ (but see F5 — pre-existing gap) |
| Registry is data with revision-guarded PUT | `app-screens.ts:39-41` (revision carried) | ✅ |
| Guard 1 unchanged and adequate | `screen-runner.ts:236-246` (10s poll, run-attributed, preset-matched) | ✅ |

## Findings

### F1 — HIGH — Web editor silently DELETES the new gesture (and already deletes `deepLink`)

**Where:** plan Stage B (no web-UI task exists); evidence `web/src/pages/ScreensPage.vue:586-591` (gesture `<select>` offers only none/pull/tab-retap/back-forward), `:99` (`refreshGesture: r?.gesture ?? ''`), `:128-137` (`formToScreen` has no `signal` or `deepLink` branch).

**Consequence:** after the registry flip, opening home's editor in the UI loads `signal` into a select that has no such option → renders blank → any save writes `refresh: undefined`. Editing any unrelated field of the screen destroys the refresh. (The same defect already exists for `deepLink` — pre-existing, but this plan adds a second victim and makes the registry flip actively dangerous.)

**Correction:** add a Stage B task: add `signal` (+ `deepLink`, one line each) to the select; `formToScreen` branch `refresh = { gesture: 'signal' }` (no fields); ensure `screenToForm` round-trips it (no away-id required). **Verify:** `pnpm run check` (vue-tsc) green + manual editor round-trip: open home → save without changes → GET shows `refresh.gesture === 'signal'` still present.

### F2 — HIGH — The A.1 test cannot fail for the reason it exists

**Where:** Task A.1 test asserts `countries.count == first.count` with a service that returns the same payload every call.

**Consequence:** count equality is true both when the signal re-fetches (same data) and when nothing happens (test's own bridge posts, handler may or may not fire). The test pins nothing about the bridge.

**Correction:** make `SucceedingHomeShipmentService` stateful — return `["PASS-1"]` on first call, `["PASS-2"]` on second; after posting the Darwin notification, assert `countries.first?.city == "PASS-2"` (or equivalent). Now failure modes (observer not registered, callback not hopping to MainActor, static-handler wiring) all fail the test.

### F3 — MEDIUM — Dead, wrongly-typed property in the bridge code

**Where:** Task A.2 bridge: `private var observer: (any CFNotificationCenter)?` — never assigned; `deinit` recomputes the raw pointer instead.

**Correction:** delete the property. The center (`CFNotificationCenterGetDarwinNotificationCenter()`) and the raw `UnsafeRawPointer(self)` recomputation are all that's needed.

### F4 — MEDIUM — Live registry flip ordered before the app that understands it is installed

**Where:** Task B.4 flips the registry; Task C.1 rebuilds/installs the bridged app.

**Consequence:** between B.4 and C.1, any run of the drill case fails `SWAP_NOT_CONFIRMED` against the old app (signal posted, no listener, no fetch). Confusing for anyone (or any cron) playing cases in that window.

**Correction:** keep B.4's *test* (round-trip pin) in Stage B, move the *live* registry flip to the start of Stage C, after install.

### F5 — LOW (pre-existing, out of scope) — YAML exporter drops `back:` and selector `point:`

**Where:** `app-screens.ts:124-130` — exports selector identifier/label/labelContains only; `back` anchor and `point`s never emitted.

**Consequence:** a back-forward registry YAML round-trip loses the return leg today. Not caused by this plan (`signal` round-trips clean). **Recommend:** BACKLOG entry, not a change in this plan.

### F6 — LOW — A.1 sleep 300ms is thin for CI variance

Darwin delivery is fast, but CI (GitHub macOS runners) can stall. Raise to 1s; the suite is `.serialized` and fast regardless.

### F7 — LOW — Accepted risk worth stating: static-handler is last-writer-wins

Existing once-guard tests call `makeStore(liveRefreshOnAppear: true)` → each registers a bridge whose handler overwrites the static. No assertion depends on those handlers, and production has exactly one home store — acceptable, but the plan should say it explicitly so a future second home-instance (split view) knows the bridge needs keying.

## Resolved plan `[VERIFY]`s

- CF API signature → confirmed against SDK (table above); implement as written minus F3.
- fake-exec pattern → `fakeXcrun` exists; B.1 uses it.
- YAML exporter → no change needed for `signal` (F5 notes the pre-existing gap).

## Coverage traceability

| Requirement (user) | Plan work | Acceptance check |
|---|---|---|
| Stay at Home, refresh in place | signal gesture + Darwin bridge | C.2: 8/8, no See-all roundtrip, chips flip in place |
| No pull-to-refresh | gesture set unchanged for others; home = `signal` | registry state; grammar tests B.2 |
| Production untouched | observer registered only under seam | C.2 negative: no arg → signal ignored, no fetch |
| Refetch must be verifiable | guard 1 unchanged | traffic: 3 preset-matched fetches / run |

## What this review could not certify on paper

- Whether `simctl spawn … notifyutil` works after sim reboot (plan's own Stage 0 gate — correct design, must run).
- End-to-end delivery sim-notifyd → app observer (C.2 is the only real proof; A.1 is in-process only).
- CI stability of the Darwin-delivery timing (F6 mitigates).

## Questions for the operator

1. **F1 scope:** fix the select for `signal` only, or also add the missing `deepLink` option (pre-existing gap, one line)? Recommend both.
2. **Plan's own open question 1** still open: extend PR #383 vs. new branch from `develop` for Stage A. Plan assumes extend.

## Verdict

**Needs revision** — apply F1 (web-UI task) and F2 (stateful test payload) before implementation; F3/F4/F6 are plan edits; F5/F7 are notes. No change to architecture, staging, or acceptance bar.
