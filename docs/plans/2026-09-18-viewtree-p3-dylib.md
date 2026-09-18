# Viewtree P3 — Mechanism B: In-Process Probe Dylib (Implementation Plan)

> **For Hermes:** implement task-by-task with per-task verify + commit. Fork
> work (T1–T3) lands on a non-main branch, pushed + PR'd the same session
> (fork rule). Crucible work (T4–T6) is ordinary repo commits. T7 is a live
> drill matrix against the real binary swap; T8 is docs. Gated by the user
> before ANY implementation starts (plan → self-review → human gate).

**Goal:** Remove the lldb attach pause (~7s warm / 17–25s cold app freeze)
from viewtree capture by serving the SAME VNode-shaped tree from INSIDE the
app via the wrapped engine's existing DYLD-injection machinery — the parent
plan's P3, executed under its own gate: "it either removes the pause at
product cost, or stays unbuilt — write which and why."

**Architecture:** A new `ViewTreeProbe.dylib` in the fork
(`Injected/ViewTreeProbe/`, house pattern of VirtualMotion/VirtualNetwork)
rides the shared `DYLD_INSERT_LIBRARIES` arming. The dylib installs a
stat-poll watcher ONLY in the process whose main-bundle id matches a
per-simulator intent file (`/tmp/BaguetteViewTree-<udid>.json`, same shared-
`/tmp` convention as motion/network). Crucible requests a dump by bumping the
intent file's `id`; the app walks `keyWindow.subviews` on the MAIN thread
(never SIGSTOPs) and atomically writes the flat VNode JSON to a response
file. Crucible polls the response, matches the `id`, normalizes `type` via
the SAME exported class-map the P1 parser uses, and returns it from the
EXISTING viewtree route behind a `source` param. lldb stays the default
source; probe is opt-in per call and armed per session behind
`CRUCIBLE_VIEWTREE_PROBE=1` (default OFF — injected-code honesty).

**Tech Stack:** ObjC + Foundation + UIKit (dylib, `-target
*-apple-ios17.0-simulator`, linker-adhoc, fat), Swift/ArgumentParser (fork
CLI subcommand), TypeScript in `@crucible/shared` + server (vitest), live
drill on LP consumer + Foodiary.

---

## Verified facts this plan is built on (2026-09-18, receipts)

1. **Injection machinery is generic already.** `InjectedDylib` is a
   name+env-override pair (`../Baguette/Sources/Baguette/Domain/Simulator/
   InjectedDylibInstallPlan.swift:31-37`: camera, motion, network).
   `InjectedDylibInstaller.installIfNeeded` resolves + sha-stages any of
   them; `SimctlSimulatorInjection` does the locked read-modify-write on
   `DYLD_INSERT_LIBRARIES` (merge by FILE NAME, per-sim file lock,
   `Injected/build.sh` loops `Injected/*/build.sh` with ZERO edits for a new
   dylib — only `Package.swift` needs a `.copy("Resources/ViewTreeProbe")`).
2. **House dylib conventions are pinned in-repo**: constructor installs only
   what a self-check validates; per-sim `/tmp/Baguette<Name>-<udid>.json`
   intent files (`SharedFileMotion.swift:22`, `VirtualNetworkCondition.m:21`);
   stat-poll cadence 0.1s (`VirtualNetworkCondition.m:33`); unified-log ONLY,
   never NSLog/stderr (stdout pollution comes back through spawned
   launchctl); fat build via `build_slice`, `-Wl,-adhoc_codesign`, and NEVER
   re-sign (`codesign --force` post-build = `invalid-page(2)` on iOS 26
   sim dyld).
3. **Arming only affects apps launched AFTER arm** (`MotionCommand.swift`
   help text: "Only apps launched after `motion start` see anything; dyld
   inserts at exec time"). Manual session start ALREADY opens the app
   (`server/src/manual/session.ts:146` alloy_apps open, bundle fallback
   `com.apple.Preferences`) — arming BEFORE that open needs no extra
   relaunch.
4. **The engine CLI spawn pattern exists**: `server/src/alloy/engine-tree.ts`
   resolves `CRUCIBLE_SIMDECK_BIN ?? <repo>/../baguette/Baguette`, execFile
   with timeout + maxBuffer, `__setEngineTreeForTest` seam. `BIN` is module-
   private today — this plan exports a resolver for reuse.
5. **The P1 parser's frame semantics**: `parseRecursiveDescription` stores
   the raw `frame = (x y; w h)` values — which are SUPERVIEW-relative (that
   is what recursiveDescription prints, i.e. `view.frame`). The in-process
   walk emitting `view.frame` produces the SAME numbers by construction —
   parity is structural, not approximate.
6. **VNode shape** (`shared/src/view-tree.ts:15-27`): `AxNode & {viewClass,
   baseClass?, address?, hidden?, alpha0?, clipped?}`; `type` is computed by
   the module-private `viewClassToType` + `CLASS_TYPE` map — the probe
   normalizer must reuse THAT map, exported for the purpose (single source
   of truth; no ObjC duplicate).
7. **Route + guards shipped** (`server/src/routes/manual.ts:241`,
   `server/src/manual/viewtree.ts`): 410 SESSION_NOT_FOUND, 409 vs automated
   runs (kind='manual' excluded), 422 NOT_SIM, per-device mutex (`locks`
   set), fresh-PID resolve, honest error codes. Response today:
   `{nodes, pausedMs, pid}`.
8. **Fork state**: on branch `fix/sweep-band-occluders` (pushed; binary at
   `ai/baguette/Baguette` is this lineage). origin/main moved
   665d1da→33293c5 — upstream drift is NOT our problem for this feature;
   branch from current working lineage, note drift in the PR.
9. **Verification gates** (repo standard): server `pnpm typecheck && pnpm
   lint && pnpm vitest run --maxWorkers=2`; web untouched (no UI in this
   plan); fork `swift test` + `./build.sh` + nm-export guard.
10. **Consumer reality**: no UI consumes viewtree yet (API-only, P2.3 not
    built) — response-shape additions are contract-tested only.

---

## Design decisions (each with the alternative rejected)

### D1 — Transport: stat-poll intent file + atomic response file
Request = rewrite `/tmp/BaguetteViewTree-<udid>.json` with a fresh `id`;
response = `/tmp/BaguetteViewTree-<udid>.dump.json` carrying the same `id`.
Host polls response every 50ms, 3s budget. Rejected: Unix socket / TCP
server in-app (more machinery, port lifecycle, no house precedent);
SIGUSR1 (async-signal safety in arbitrary apps is a gamble). The stat-poll
is the proven VirtualNetwork pattern; a dump is rare so 0.1s worst-case
latency is fine.

### D2 — Process filter: main-bundle id read ONCE in the constructor
`dispatch_once`: read intent file; if `bundleIdentifier` mismatch or file
absent → install nothing (launchctl, SpringBoard, other apps pay one file
read). Rejected: swizzle-only-when-asked (nothing to swizzle — we ADD a
watcher, not replace methods); filtering by process name (fragile).

### D3 — Walk on main thread via dispatch_async, never block the caller
The watcher thread sees the id bump, `dispatch_async(main)` walks
`subviews` DFS pre-order (SAME order as recursiveDescription), builds the
flat array, writes the response atomically from the main thread. ~338-view
walk is single-digit ms. Mid-animation frames = same snapshot honesty as
lldb (badge, not a fix).

### D4 — Wire shape: VNode JSON minus `type`, normalized Crucible-side
Dylib emits `{index, parentIndex, viewClass, baseClass?, address, rect,
hidden?, alpha0?, clipped?, label?, hittable, bundleId, id}`. `type` is
filled by `nodesFromProbe()` in `shared/src/view-tree.ts` using the
newly-exported `viewClassToType` — one class→type vocabulary, both sources.
Rejected: duplicating CLASS_TYPE in ObjC (drift class).

### D5 — Lifecycle: arm at session START behind env flag, disarm at finish
`CRUCIBLE_VIEWTREE_PROBE=1` (default OFF) → `startManualSession` spawns
`Baguette viewtree arm --udid <udid> --bundle <bundleId>` BEFORE the
alloy_apps open (fact 3 ⇒ zero extra relaunch). `finishManualSession`
disarms best-effort (in-memory armed-udid set; server restart leaks an
armed env until sim reboot — same class as camera/motion, noted honestly).
Armed state is NOT persisted to `manual_sessions` (a column would LIE
across server restarts — env is real, memory isn't). Per-call opt-in stays:
route `source:'probe'` on an un-armed session → honest 409 `PROBE_NOT_ARMED`
with the flag hint.

### D6 — Route: `source` body param, additive response fields
`POST /api/manual/:id/viewtree` body `{source?: 'probe'}` (default/absent =
lldb, bit-for-bit current behavior). Probe response: `{nodes, source:
'probe', waitMs, injected: true}` — no `pausedMs`/`pid` (app was never
paused, never attached; fabricating either would break the honesty
contract). Shared per-device lock WITH the lldb path (one dump at a time
per device, either source).

### D7 — Fork surface: one CLI subcommand, three verbs
`Baguette viewtree arm --udid <udid> --bundle <id>` / `viewtree disarm
--udid <udid>` / `viewtree status --udid <udid>` (armed? intent file?).
Writes the intent file + rides `SimctlSimulatorInjection`. The dump
request/response file IO is Crucible-direct (host sees /tmp) — the engine
binary is NOT in the dump path (fewer spawns, no new long-lived process).

---

## Tasks

### Fork (branch `feat/viewtree-probe` off `fix/sweep-band-occluders`)

**T1 — dylib skeleton + build + staging**
- Create `Injected/ViewTreeProbe/build.sh` (copy VirtualMotion's; OUT=
  ViewTreeProbe.dylib, sources `Sources/*.m`, frameworks Foundation only).
- Create `Injected/ViewTreeProbe/Sources/ViewTreeProbe.m`:
  - `VTProbePath()` — `/tmp/BaguetteViewTree-%s.json` +
    `/tmp/BaguetteViewTree-%s.dump.json` from `SIMULATOR_UDID` (nil-safe,
    VirtualNetworkCondition.m pattern).
  - `VTLog()` os_log subsystem `com.baguette.viewtree` (NEVER NSLog).
  - Constructor: dispatch_once → read intent → bundle match check →
    install poller or exit.
- `InjectedDylib.viewTreeProbe = InjectedDylib(name: "ViewTreeProbe",
  environmentOverride: "BAGUETTE_VIEWTREEPROBE_DYLIB")` +
  `Package.swift` `.copy("Resources/ViewTreeProbe")`.
- Verify: `./Injected/ViewTreeProbe/build.sh` → fat dylib, nm exports > 0;
  `./build.sh` stages it; `swift build` green; `swift test` green.
- Commit: `feat(inject): ViewTreeProbe dylib skeleton — intent file, bundle filter, build`.

**T2 — the walk + request/response**
- Same file: poller (0.1s stat interval, generation/mtime guard like
  VNCondition) → on new `id`: `dispatch_async(main)`: keyWindow via the
  PINNED KVC chain (`connectedScenes` → `anyObject` → `keyWindow`),
  DFS-pre-order `subviews` walk emitting the D4 JSON per node, atomic write
  of the response (`id`, `bundleId`, `nodes`, `elapsedMs`).
  - Per node: `viewClass = NSStringFromClass(class)`, `baseClass` = first
    superclass whose name starts `UI` (app classes only), `address` =
    `@"%p"`, `rect` = `view.frame` verbatim, `hidden = isHidden`,
    `alpha0 = alpha < 0.01`, `clipped = clipsToBounds`, `label` = text for
    UILabel (and UIButton via `titleLabel`), `hittable = isUserInteractionEnabled`.
  - No keyWindow / app in background → response `{id, error:
    "no-key-window"}` (honest, matches lldb NO_APP class).
- Dylib internals are verified LIVE (T7) — the fork has no ObjC test
  target; keeping the dylib thin is the mitigation. State this in the PR.
- Commit: `feat(inject): probe walk + stat-poll request/response — main-thread DFS, atomic dump`.

**T3 — CLI subcommand**
- `Sources/Baguette/App/Commands/ViewtreeCommand.swift`
  (`viewtree arm|disarm|status`, `--udid`, `--bundle`; arm installs dylib
  via `InjectedDylibInstaller.installIfNeeded(.viewTreeProbe)` +
  `injection.arm`, writes intent file first — the same
  publish-then-arm order as `SharedFileMotion.publish`).
- Register in `RootCommand.swift` subcommands.
- Fork tests (Swift Testing): intent-file round-trip, arg validation,
  arm-merge behavior via `MockSubprocess` (mirror
  `SimctlSimulatorInjectionTests`).
- Verify: `swift test`; manual `./build -c release` + binary works.
- Commit: `feat(cli): viewtree arm|disarm|status — probe lifecycle verbs`.
- Push branch + open PR same session (fork rule). Note upstream drift
  (665d1da→33293c5) in the PR body.

### Crucible

**T4 — shared: export the type map + probe normalizer**
- `shared/src/view-tree.ts`: export `viewClassToType`; add
  `nodesFromProbe(raw: ProbeNode[]): VNode[]` (fills `type`, validates
  index/parentIndex/rect presence — THROWS on malformed, same
  garbage-in-is-loud contract as the parser).
- `shared/package.json` exports: `./view-tree` already present — NO edit
  (verified).
- Tests (`server/test/view-tree.test.ts`, same home as the parser tests):
  normalize happy path (probe fixture built from the LP-home P0 fixture by
  a one-time script checked into the test as a fixture), throw on missing
  rect / dangling parentIndex, type-parity: for every node in the LP
  fixture, `nodesFromProbe` type == parser type.
- Commit: `feat(shared): nodesFromProbe — probe JSON → VNode via the ONE class-type map`.

**T5 — server: probe client**
- `server/src/manual/viewtree-probe.ts`:
  - `engineBin()` — export from `engine-tree.ts` (move the resolution;
    consumers unchanged) — reuse for the arm spawn.
  - `armProbe(udid, bundleId)` / `disarmProbe(udid)`: execFile the CLI
    verbs, 10s timeout, honest `ProbeError` codes
    (`ARM_FAILED|DISARM_FAILED`).
  - `fetchProbeViewtree(udid, bundleId, {timeoutMs=3000})`: write request
    `{id: crypto-random, bundleId}` atomically → poll response file every
    50ms → validate `id` match (mismatch = STALE, keep polling),
    `bundleId` match (WRONG_APP), `error` passthrough, `nodes.length>0`
    (EMPTY honest) → `nodesFromProbe` → `{nodes, waitMs, source:'probe'}`.
  - Test seam `__setViewtreeProbeForTest` (fs + spawn override) — same
    pattern as `__setViewtreeForTest`.
- Tests (`server/test/viewtree-probe.test.ts`, REAL tmpdir files, no
  sleeps beyond tiny overrides): happy path, stale-id rejection, wrong
  bundle, timeout (timeoutMs=200 vs responder that never writes),
  empty-nodes, malformed node → PARSE.
- Commit: `feat(server): viewtree probe client — arm/disarm + id-matched poll + normalize`.

**T6 — route + session wiring**
- `routes/manual.ts` viewtree route: parse `body.source`; `'probe'` →
  shared per-device lock (export the lock set from `manual/viewtree.ts` or
  hoist to a tiny module — ONE lock for both sources), armed-set check →
  409 `PROBE_NOT_ARMED` (message names the env flag), else
  `fetchProbeViewtree`; lldb path untouched. Keep every existing guard
  (410/409-run/422-NOT_SIM apply to BOTH sources — the walk touches the
  main thread mid-run; cheap consistency).
- `manual/session.ts`: `startManualSession` — when
  `process.env.CRUCIBLE_VIEWTREE_PROBE === '1'` (read at call time, same
  pattern as `CRUCIBLE_SWEEP`), `armProbe` BEFORE the alloy_apps open;
  failure = warn + continue (session must not die for an experimental
  probe — lldb source still works; honest note in session note field).
  `finishManualSession` — best-effort `disarmProbe` when armed set has the
  udid.
- Tests: route matrix in `server/test/viewtree-route.test.ts` (probe
  armed+ok / not-armed 409 / source default stays lldb (existing tests
  must pass UNCHANGED — backward compat receipt) / both-source lock);
  session tests with seam override (arm-before-open ordering asserted via
  call recording; finish disarms).
- Gates: `pnpm typecheck && pnpm lint && pnpm vitest run --maxWorkers=2`.
- Commit: `feat(server): viewtree probe wiring — session arm behind env, route source param, shared device lock`.

### Live verification

**T7 — binary swap + drill matrix** (half session, live)
- Fork release build + binary-swap ritual (rm BEFORE cp, `--version`,
  `codesign -dv`, supervisor respawn via proxied route).
- Matrix (LP consumer home = UIKit/hybrid; Foodiary = pure SwiftUI):
  1. **Parity**: same screen, probe dump vs lldb dump (same process):
     address+class+rect match ≥95%, node count equal ±0. Record table in
     the research note.
  2. **Pause removal**: stream stays live DURING a probe dump (frame
     cadence uninterrupted); app responds to a tap immediately after.
     `waitMs` p50 ≤ 500ms, p95 ≤ 2s.
  3. **SwiftUI ceiling parity**: Foodiary = same 7-wrapper shape.
  4. **Un-armed honest error**: session without flag → 409
     PROBE_NOT_ARMED, message names the flag.
  5. **App-not-relaunched**: arm AFTER app open (manual CLI arm) → probe
     times out honestly at 3s (NO_RESPONSE), lldb source still fine.
  6. **No cross-app leakage**: second sim running another app while
     armed → its dump request gets nothing (udid-scoped files), other app
     unaffected (its constructor filtered out).
  7. **Reboot wipes arming**: sim reboot mid-session → honest timeout;
     re-arm works next session. (Drill note, not a fix.)
- Negative control: with the probe module seam returning garbage shapes,
  the route must 5xx honestly — vacuous-pass guard per the repo rule.

**T8 — docs + verdict**
- `docs/research/2026-09-18-viewtree-p3-probe.md`: parity table, timing,
  matrix results, product-cost register (fork PR + swap ritual, injection
  badge, exec-time-only arming).
- `docs/plans/2026-09-13-viewtree-probe.md`: P3 section stamped with the
  outcome (built / rejected-by-numbers).
- `DEFERRED.md`: update the viewtree lines (P3 resolved; P2.3 UI toggle
  remains the open follow-up, now with a cheaper backend).
- Docs commit separate from code commits (user preference).

---

## Edge-case table (walked at T7 exit)

| # | Case | Behavior |
|---|---|---|
| 1 | App launched before arming | dyld inserts at exec only — probe NO_RESPONSE at 3s, honest; mitigated by arm-before-open at session start |
| 2 | Route asks probe on un-armed session | 409 PROBE_NOT_ARMED naming `CRUCIBLE_VIEWTREE_PROBE=1` |
| 3 | Armed, other processes launch (launchctl, SpringBoard) | constructor bundle filter — no watcher installed, one file read |
| 4 | App killed between arm and request | 3s timeout, honest NO_RESPONSE; never an empty 200 |
| 5 | Stale response file from earlier dump | request `id` must match; mismatch keeps polling until budget |
| 6 | Sim reboot mid-session | launchctl env wiped — timeout honest; next session re-arms |
| 7 | Concurrent probe + lldb dumps, same device | ONE shared per-device lock; second waits (fail-early class) |
| 8 | Huge tree (1000s of cells) | no cap (lldb path has none); measure in drill; maxBuffer sized for MBs |
| 9 | Pure-SwiftUI screen | same 7-wrapper ceiling as lldb — asserted in matrix row 3 |
| 10 | Wrong app answers (bundle mismatch) | response `bundleId` checked vs session app → WRONG_APP error |
| 11 | App main thread busy > 3s | walk queued behind main work → timeout honest, never partial tree |
| 12 | Intent file deleted while armed | already-running watcher keeps last id; new ids never seen → timeout honest |

## Numeric exit gate (P3 verdict input)

| Gate | Pass | Fail → |
|---|---|---|
| Probe waitMs | p50 ≤ 500ms, p95 ≤ 2s on LP home | keep lldb default, probe stays experimental |
| Parity vs lldb (same process) | ≥95% address+class+rect, count ±0 | fix normalizer or REJECT probe |
| App never paused | stream frames continue during dump | mechanism broken — reject |
| Product cost | fork PR merged same session; env flag default OFF | record and stop |

## Risks

- **Injected into every armed process** — mitigated by D2 (one read,
  no-op elsewhere); the sweep warm-up latch already proves the LP app
  tolerates DYLD_INSERT.
- **Fork churn** — wrap work is settled (b83f322 lineage); branch off the
  CURRENT lineage the wall binary runs, note upstream drift in the PR.
- **Codesign traps** — linker-adhoc only, never re-sign, sha-keyed staging
  (all pinned in house build.sh comments; copied verbatim).
- **No ObjC test target in the fork** — dylib thinness + live matrix + the
  Crucible-side parity test carry the verification load; stated openly in
  the PR and here.
- **Corpus rot** — fixtures pin app build + screen, same convention as
  ax-depth (fixture regeneration note in T4).

---

## Self-review (performed 2026-09-18, findings folded back above)

- **(a) mentally executed every planned test against its data** — T5
  stale-id test needs the response file to PRE-exist with an old id: test
  writes a response with id `stale` then calls fetch with a fresh id and a
  responder that never writes → expects timeout, NOT the stale nodes.
  Caught: an earlier draft asserted "returns stale" (wrong contract).
- **(b) both ends of every data link** — intent path written by CLI with
  `--udid` ↔ read by dylib from `SIMULATOR_UDID` (same string format,
  verified against VirtualNetworkCondition.m:21). Response written by
  dylib ↔ read by Crucible with the SAME udid-scoped path. Route shape ↔
  tests assert `{nodes, source, waitMs}` for probe and the unchanged
  `{nodes, pausedMs, pid}` for lldb.
- **(c) factual claims re-checked against code** — startManualSession's
  open is at session.ts:146 (arm slot exists BEFORE it); finishManualSession
  at :393; engine-tree BIN is module-private (plan exports it); shared
  exports map already contains `./view-tree` (no exports-map edit — the
  classic trap, checked not assumed).
- **(d) field consumers verified** — `type` is consumed by
  InspectTree-format consumers; only ONE producer (the exported map) for
  both sources.
- **(e) backward compat** — default route behavior and response are
  byte-identical when `source` is absent; existing viewtree-route tests
  must pass UNCHANGED (that's the receipt, stated in T6).
- **(f/g) schema + determinism** — no DB schema change (deliberate; a
  persisted armed column would lie across restarts). Probe tests use real
  tmpdir + injected fake responders; the only timing test uses an explicit
  small `timeoutMs` — no wall-clock assertions on parallel load.
- **(h) mutating-route guard** — route already carries the busy guard;
  probe rides the same guard + the shared device lock.
- **(q) richer-source regression** — probe could disagree with lldb
  (ordering, extra nodes); the parity test is the regression net, count
  equality ±0 is the sharp assertion.
- **Honesty contract audit** — probe response omits `pausedMs`/`pid`
  rather than fabricating zeros; `injected: true` rides the payload so any
  future UI can badge it.
- **One deliberate scope cut** — no UI toggle (P2.3) here: API-only until
  demand, per the parent plan. The plan does NOT silently absorb it.
