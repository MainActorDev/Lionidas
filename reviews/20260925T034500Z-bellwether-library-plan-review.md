# Review — Bellwether library plan (`20260925T034500Z-bellwether-library-plan.md`)

- Reviewed: `plans/20260925T034500Z-bellwether-library-plan.md` (as saved 2026-09-25) + brainstorm `20260925T032047Z`
- New operator requirement captured mid-review: **"enforce it runs for Debug only by default"** — the plan has NO mechanism for it; folded into F1/F8 below.
- Evidence sources: ios-consumer-intl live repo (Makefile scipio target, `fastlane/Fastfile:346-356`, `fastlane/TestSupport.rb:130-150,273`, root `Package.swift` (AllDependencies), `project.yml:12-141`, `Modules/LPDesignSystem/Package.swift:23-26`, `Modules/LPFeatureSwiftUI/Package.swift`), iPhoneSimulator SDK `CFNotificationCenter.h:45-68`, scipio `--help` (output flag confirmed: `-o, --output`)
- Verdict: **Needs revision** — two confirmed code defects in the library sketch (F2, F3), one new requirement unimplemented (F1), one CI-mode gap (F5). All corrections are concrete; architecture and staging are sound.

## What was verified independently

| Plan claim | Check | Result |
|---|---|---|
| Org `MainActorDev` | `gh repo list` (Crucible, Alloy, xcbuddy live there) | ✅ |
| Scipio invocation shape | `Makefile:20-28` (`mint run giginet/Scipio … --configuration debug`), `~/.mint/bin/scipio prepare --help` | ✅ — and the output flag is `-o/--output`, resolving the plan's `[VERIFY]` |
| Prebuilt consumption pattern | `LPDesignSystem/Package.swift:23-26` binaryTarget path `../../XCFrameworks/…` | ✅ |
| XCFrameworks git-ignored, rebuilt per machine | `git check-ignore` → ignored | ✅ |
| CI swaps XCFrameworks for SPM remotes when the dir is absent | `Fastfile:346-356`, `TestSupport.rb:273` + spec rewrite `:130-150` | ✅ — and it exposes F5 |
| Darwin-center semantics for the callback path | SDK header lines 52-57: **`object` and `suspensionBehavior` are IGNORED for the Darwin center**; the registered observer pointer is what the callback receives | ⚠️ — contradicts the plan's sketch (F2) |
| Crucible contract strings name-stable | runner + app code (this session) | ✅ zero server change |

## Findings

### F1 — HIGH — New requirement "Debug only by default" has no mechanism in the plan

**Where:** plan Stages A/C; requirement stated by operator during this review.

**Consequence:** as planned, a Release/TestFlight build launched with `-uitest-live-refresh` would still subscribe and refetch — exactly what "Debug only by default" exists to prevent. And note the trap: **a `#if DEBUG` inside the library CANNOT work** — the XCFramework is prebuilt once (`--configuration debug`) and linked into every app configuration; compile conditions are baked at Scipio time, not per-app-config.

**Correction (recommended design):** the library grows an explicit consumer-set gate; the app's *source-compiled* module sets it under its own `#if DEBUG`:

```swift
// Bellwether — library default: DENY. Overridable by the consumer at startup.
public static var subscriptionsAllowed = false
public static var isLiveRefreshEnabled: Bool { subscriptionsAllowed && argPresent }

// LPHome (local SPM package — compiles per app configuration, so #if DEBUG follows the APP's config)
#if DEBUG
Bellwether.subscriptionsAllowed = true
#endif
```

"By default" is honored: Debug builds allow; Release/Staging deny unless a build explicitly opts in (a QA/Staging build could set it — runtime-overridable, not a code change per build). **Verify:** new unit test (gate=false + arg → `subscribeRefresh` nil); acceptance drill gains a second negative — **Staging-config build + arg + signal → zero fetches**.

### F2 — HIGH — Confirmed defect in the A.2 sketch: the handler box rides the `object` parameter, which the Darwin center ignores

**Evidence:** SDK `CFNotificationCenter.h:52` — "CFNotificationCenterAddObserver(): the 'object' and 'suspensionBehavior' arguments are ignored". The callback receives the **observer pointer** it was registered with (param 2), not the object.

**Consequence:** as sketched, `box.toOpaque()` in the `object` slot never reaches the callback → delivery test fails and the implementer chases a ghost.

**Correction:** register the **HandlerBox itself as the observer** (`Unmanaged.passRetained(box).toOpaque()` as the observer param); the callback casts its `observer` argument back to the box and fires. `deinit` removes the observer with the same pointer and `passRetained`-balances with `release`. Ownership discipline: CF does not retain the observer pointer — the box is retained by the subscription, released on detach.

### F3 — HIGH — Confirmed defect: strong registry entry defeats `deinit`-detach (the whole lifetime design)

**Where:** A.2 `Registry.attach` stores `subscriptions[screenId] = sub` (strong) while `RefreshSubscription.deinit` is the detach path.

**Consequence:** the singleton holds the subscription forever → adapter releasing it changes nothing → observer never removed → the "deinit detaches" test fails (and every same-id re-creation leaks an observer).

**Correction:** weak storage (`NSHashTable<RefreshSubscription>.weakObjects()` or id→`weak` box), or drop the dictionary entirely — same-id last-wins can be enforced by removing any existing weak entry at attach. Keep the dictionary only if the "one live subscription per screen id" rule is wanted; state the choice.

### F4 — MEDIUM — Stage B.2 contains a wrong snippet followed by its own correction

**Correction:** keep only the right one — LPHome's `Package.swift`: target dependencies += `"Bellwether"` + `.binaryTarget(name: "Bellwether", path: "../../XCFrameworks/Bellwether.xcframework")`. Self-contained in the consuming package (cleaner than the LPFeatureSwiftUI precedent, which imports `ConstruktKit` without declaring it and rides transitive visibility).

### F5 — MEDIUM — CI mode (no XCFrameworks) cannot resolve LPHome's binaryTarget

**Evidence:** `Fastfile:346-356` + `TestSupport.rb:273` — when `XCFrameworks/` is absent, CI swaps framework refs for SPM remotes via the generated spec/root `Package.swift`. `Modules/LPHome/Package.swift`'s new binaryTarget points at a directory that won't exist on CI.

**Correction (plan edit):** extend the CI-fallback contract — root `Package.swift` (AllDependencies) gains `.package(url: "https://github.com/MainActorDev/Bellwether", from: "0.1.0")` and the TestSupport swap maps LPHome's Bellwether binary ref to the remote product, mirroring the ConstruktKit handling (`TestSupport.rb:130-150`). `[VERIFY]` at implementation: read `replace_xcframeworks_with_packages` fully and mirror its mechanism; confirm CI's access to the private repo (same as Construkt's path — if Construkt resolves from URL in CI today, the credential story already covers MainActorDev repos; if not, Bellwether must be public or the pipeline token scoped).

### F6 — LOW — Stage C option (a) interacts with F1

With the gate design, `liveRefreshOnAppear` (State Bool) must initialize from `Bellwether.isLiveRefreshEnabled` **inside the `#if DEBUG`-gated setup region** so Release builds can't bypass the once-guard via the arg. One line; make it explicit in Task C.1.

### F7 — LOW — Name availability unverified

"Bellwether" on GitHub/SwiftPM not checked (no lookup performed). `[VERIFY]` before repo creation; renaming pre-publish is cheap, post-publish is not.

### F8 — LOW — scipio output flag resolved

`-o/--output <dir>` confirmed via `--help` — the plan's `[VERIFY]` is closed; write the command as `scipio prepare ../Bellwether --support-simulators --framework-type static --configuration debug -o XCFrameworks` (note: run from the app repo so the output lands in its ignored `XCFrameworks/`).

## Coverage traceability

| Requirement (operator) | Plan work | Acceptance check |
|---|---|---|
| Any iOS project, plug-and-play (decision 1) | standalone SPM lib, one-line adoption | adoption compiles; drill green |
| Complete scope (decision 2) | multi-screen registry + test override + lifetime tokens | A.3 tests 1–4 |
| British name, good philosophy (3) | Bellwether + rationale | README |
| Same org as Construkt (3) | MainActorDev repo | repo exists |
| Land #383 then refactor (4) | Stage C on follow-up branch | PR sequence |
| Prebuilt like siblings (5) | Scipio static debug xcframework | `ls XCFrameworks/Bellwether.xcframework` |
| **Debug only by default (new)** | F1 gate | unit test + Staging-build negative drill |

## What this review could not certify on paper

- Registry/pointer plumbing actually delivering on-device (A.3 is the check; F2/F3 fixes make the tests meaningful rather than vacuous).
- CI fallback mechanics end-to-end (F5 `[VERIFY]`).
- On-paper only: concurrency soundness of the gate var (single-threaded startup set; document "set once at launch").

## Questions for the operator

1. **F1 shape:** runtime gate (`subscriptionsAllowed`, recommended — overridable per build) vs pure compile-time `#if DEBUG` at call sites (simpler, but enabling a special Release build means code change)?
2. **F5:** if MainActorDev private-repo access in CI turns out to be unsolved, is making Bellwether **public** acceptable (its code is a ~150-line signal channel; no business logic)?

## Verdict

**Needs revision** — fold F1 (gate design + two new verification checks), F2/F3 (rewrite the A.2 sketch correctly), F4 (one clean snippet), F5 (CI-fallback task), F6/F8 edits. No architectural objection: placement, staging, naming rationale, and the land-then-refactor sequence all stand.
