# Viewtree P3 — In-Process Probe (Mechanism B): Live Drill Results

Executed 2026-09-18, iPhone 14 Plus sim (30B28173, iOS 26.4 runtime), LP
consumer-dev v3.4.0, fork branch `feat/viewtree-probe` (PR #3), Crucible
server with `CRUCIBLE_VIEWTREE_PROBE=1`.

## The headline

| Metric | lldb (mechanism A) | probe (mechanism B) |
|---|---|---|
| Dump latency | 6.6s warm / 17–23s cold | **52–449ms** (poll-cadence bound) |
| App paused | yes (SIGSTOP for the whole attach) | **never** |
| Through API | — | 359 nodes, waitMs 103ms, `injected: true` |

## Drill matrix (7 rows)

1. **Parity vs lldb, same process — PASS.** 360 nodes both sources, count
   ±0. Class 100.0%, parentIndex 100.0%, rect 98.1% — every rect mismatch
   is the home-banner carousel mid-animation (off-screen cells x=1128/1504)
   or pager-dot width deltas between two snapshots taken seconds apart.
   Address parity 94–96% for the same reason (views reallocated between
   snapshots). Two dylib bugs found and fixed live to reach this:
   - **Recursive-block SIGSEGV**: a block capturing its own `__block`
     variable heap-copies on first recursion → stale self-reference →
     crash (`__VTWalk_block_invoke`, crash reports
     LionParcelLogistics-2026-09-18-160937/161129.ips). Rewritten as an
     iterative explicit-stack walk.
   - **KVO class vocabulary**: `object_getClass` reports
     `NSKVONotifying_…` dynamic subclasses; `recursiveDescription` prints
     the `-class` answer. `[view class]` matches → 100% class parity.
2. **Stream stays live during dump — PASS.** Frame cadence identical with
   and without a dump fired mid-animation (24 frames in the window, both
   passes; dump 449ms). Negative control first: static screen = wire-silent
   (change-gating), so the drill fires inside the animation window.
3. **SwiftUI ceiling — NOT RUN** (Foodiary not installed on this sim).
   Structural expectation unchanged: hosting wrappers only; the parser's
   Foodiary fixture already pins the shape on the lldb side.
4. **Un-armed honest error — PASS.** Session without arming → 409
   `PROBE_NOT_ARMED`, message names `CRUCIBLE_VIEWTREE_PROBE=1`.
5. **Arm-after-open — PASS (honest timeout).** Arming after the app is
   already running → the app carries no watcher → NO_RESPONSE at 3s with
   the relaunch hint; lldb source unaffected.
6. **Cross-sim isolation — VERIFIED BY CONSTRUCTION + partial live.** All
   files are udid-scoped (`/tmp/BaguetteViewTree-<udid>*`), the dylib
   filters by main-bundle id read once at constructor; observed: the INTL
   app running concurrently on the same sim never loaded the watcher (log
   shows only consumer-dev). No second sim available in this drill.
7. **Sim reboot wipes arming — NOT RUN** (documented launchctl-env
   semantics; re-arm next session is the recovery, same as camera/motion).

## Bugs found by the drill (fixed)

- **Fork (2)**: the VTWalk crash + KVO class names (above). Both pushed to
  PR #3 (d7b843b).
- **Crucible (1)**: `finishManualSession` disarmed the probe even when
  ANOTHER live session held the same device — a stale orphaned session's
  watchdog-finish disarmed a freshly armed one mid-drill. Fixed: disarm
  only when no other live session holds the udid.
- **Operational lesson (the big one)**: rebuilding the dylib is NOT enough
  — staging is sha-keyed, but `DYLD_INSERT_LIBRARIES` keeps pointing at
  the OLD sha dir until disarm→re-arm. Symptom: "same crash, same offsets"
  after a fix. Ritual: rebuild → disarm → re-arm → relaunch app.
- **Known limitation (accepted)**: `startManualSession`'s alloy open with
  `hold: false` brings an ALREADY-RUNNING app to front without relaunching
  it — so if the app was already up when the session armed, the probe
  isn't in that process and dumps time out honestly. Workaround: terminate
  the app before session start (drill-verified: 359 nodes end-to-end).
  A warm-up relaunch (the sweep's `ensureEnvReady` pattern) is the future
  fix if this bites in practice; deliberately not bolted on now.

## Product costs (on the record)

- Fork PR same session (rule honored): MainActorDev/Baguette#3.
- Arming requires app relaunch (exec-time injection) — session-start
  arming makes this free when the app isn't already running.
- Injected-code badge: response carries `injected: true`.
- Env flag `CRUCIBLE_VIEWTREE_PROBE=1`, default OFF. lldb stays default.

## Verdict

**BUILT — mechanism B removes the pause.** Parity at the adopt bar
(≥95% with count ±0 exceeded: 100% class/parent), latency ~100× better,
stream continuity proven, honest error surface verified live. The probe is
the experimental opt-in source; P4's inspector-toggle question (P2.3)
remains open as before, now with a backend that can support it.
