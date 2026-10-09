# Plan — Input verbs round (Stage 1): double-tap, long-press, shake, paste

- Source brainstorm: `brainstorm/20261009T001703Z-baguette-cockpit-parity.md`
- Review: `reviews/20261009T001703Z-baguette-cockpit-parity-plan-review.md`
  (F1–F4 applied 2026-10-09; F5/F6 disclosed, nonblocking)
- Status: Ready (revised — review findings applied)
- Created: 2026-10-09

## Decision log

| Decision | Source |
|---|---|
| Scope = ALL input verbs from the parity gap table | User: "I want all of them in the input verbs" |
| Packaging = staged | User: "staged" |
| Stage 1 = double-tap, long-press, shake, paste | Brainstorm proposal, accepted by "staged" |
| Stage 2 (later round) = edge gestures, streaming touch, pinch, host-key | Same decision, deferred tail |

## Verified facts (source, 2026-10-09)

1. **The simdeck child is baguette itself** — `server/src/simdeck/supervisor.ts:16`
   spawns `../baguette/Baguette` (env `CRUCIBLE_SIMDECK_BIN`) on port 8422.
   Lionidas manual-drive already speaks its wire dialect
   (`server/src/manual/engine-input.ts` → `POST /simulators/{udid}/input`).
2. **Shake**: `POST /simulators/<UDID>/shake` HTTP route on baguette serve
   (`../baguette/docs/features/shake.md:11`). Backed by `simctl spawn … notifyutil`
   posting `com.apple.UIKit.SimulatorShake`.
3. **Paste — composed in Lionidas (review F1, verified 2026-10-09)**: the
   child's HTTP `/input` route does NOT route through `PasteDispatch`
   (`ServerPluginRoutes.swift:270-284` — direct `GestureDispatcher.dispatch`;
   `Paste` is not a registered gesture, `GestureRegistry.swift:51-60`; the
   intercept exists only on the WS path `Server.swift:2600` and stdin
   `InputCommand.swift:60`). Working composition, both pieces verified:
   (a) `execFile('xcrun', ['simctl','pbcopy',udid])` with the text on stdin
   (baguette's own recipe, `SimctlPasteboard.swift:32` — same host-exec
   pattern as the uninstall route), then (b) `{"type":"key","code":"KeyV",
   "modifiers":["command"]}` over the child HTTP input route (`Key` is
   registered, `Key.swift:9-19`, `GestureRegistry.swift:57` — baguette's
   own server-side paste recipe, `paste.md:43`). `press:false` = step (a)
   only. No binary exec; no dependency on the sibling checkout at runtime.
4. **Double-tap (manual path)**: four `touch1-down/up` lines with ~80 ms hold /
   ~50 ms gap on ONE connection (`double-tap.md:45-70`). `touch1` is already in
   `POSITIONAL_KINDS` (`engine-input.ts:60`). Our engineInput sends one HTTP
   POST per gesture; four sequential POSTs to the PERSISTENT serve process have
   loopback RTT ≪ the 250 ms recognizer window — cadence is generated
   server-side with sleeps. T0 proves this live before building on it.
5. **Double-tap + long-press (case path)**: engine A's `press` command accepts a
   `doubleTap` boolean (`the tool runner/src/daemon/session-event-action.ts:376`
   touchSafeFlagSpec booleans; `daemon-runtime-port.ts:156` passes
   `doubleTap: true`). Alloy registers `longpress` already but its adapter type
   lacks `doubleTap` (`../alloy/src/adapter-a.ts:48-49`). Alloy needs a 2-line
   type + input-schema extension (separate alloy PR, same session).
6. Case DSL today: explicit step kinds (tap/scroll/type/runFlow/expect/…) —
   `server/src/manual/playback.ts:86`. New verbs follow the same convention:
   explicit kinds, not a generic `gesture` step.
7. Nothing input-side bypasses the boundary: manual path = child HTTP (spawned
   by supervisor), case path = alloy dispatch or the same child HTTP. The
   device-boundary test allowlist will need the new modules/kinds
   (`server/test/device-boundary.test.ts` caught the uninstall module before).

## Objective

Operators and cases can express the four Stage-1 verbs end-to-end:
drive-pad buttons fire them on the live simulator; case steps run them with
overlay markers and honest pass/skip/fail rows; evidence records taps.

Measurable completion:
- Live drill on a booted sim: shake delivered (motion event visible),
  paste lands non-ASCII text in a field, double-tap fires a double-tap
  recognizer, long-press fires a long-press recognizer.
- A case containing all four verbs runs green with `run_steps` rows + tap
  markers on the overlay for the positional verbs.
- `pnpm run check` green (server + web), boundary tests updated, full suite
  green. Alloy PR merged (or open with CI green) before Lionidas case-path
  verbs ship.

## Scope

IN: the four verbs on both surfaces (manual drive + case steps), wire helpers,
alloy doubleTap/longpress schema, overlay markers, tests, drills.
OUT (Stage 2, separate round): edge/system gestures (swipe-home,
app-switcher, NC, lock-screen pulls), streaming touch (live drag), pinch
(touch2), discrete key sends. Device-state cluster (appearance, status-bar,
motion, camera) and viewing surfaces stay out (brainstorm decision).

## Architecture

Two dispatch paths, both boundary-safe — mirror the existing split:

| Verb | Manual drive (simdeck child) | Case step (playback) |
|---|---|---|
| double-tap | timed `touch1` 4-POST sequence via `engineInput` | `alloy_act press {doubleTap:true}` |
| long-press | timed `touch1` down/dwell/up via `engineInput` | `alloy_act longpress {durationMs}` |
| shake | child `POST /simulators/{udid}/shake` | same child route (server-side fetch) |
| paste | `xcrun simctl pbcopy` + child-input Cmd+V `Key` (F1 composition) | same |

Busy-ack honesty (review F2): the child answers `{"ok":false,"error":"device
busy…"}` with HTTP 200 when its per-sim input gate is held
(`ServerPluginRoutes.swift:261,274`). `assertAck`/`engineInput` must surface
that text instead of collapsing it into INPUT_TIMEOUT — the helpers' error
contract includes it (unit-tested with a busy ack fixture).

Positional verbs emit the existing `step.tap`/`manual.session.tap` marker
events with the dims chain from the overlay-reliability round (`overlayDims`).
Shake/paste are non-positional: recorded as steps, no tap marker.

## Implementation stages

- **T0 — Prove the wire (no product code).** Rebuild the baguette binary if
  stale (`swift build -c release` + copy, per established procedure; restart
  child via server restart). Live probes against the booted sim, via curl +
  tiny tsx scripts:
  (a) shake route 200 + app-visible motion;
  (b) paste composition: `simctl pbcopy` + Cmd+V Key over the child input
  route — non-ASCII text must land in a focused field (F1 path);
  (c) four timed touch1 POSTs firing a double-tap recognizer (probe with a
  Notes/list view) — RECORD the tap-1-up→tap-2-down gap from ack timestamps;
  **probe passes only if the measured gap ≤ 120 ms** (recognizer headroom,
  review F3); on failure, try multi-event bodies, else child WS (see Edge
  cases);
  (d) long-press dwell firing a context menu;
  (e) read-only schema inspection sizing T3 honestly (review F4):
  `defineToolFromRow` input-schema strictness in alloy + engine A's
  `press`/`click` tool input schema — does an unknown `doubleTap` key pass
  through or get rejected?
  Record findings in the drill notes; adjust the dispatch table if any probe
  falsifies an assumption.
- **T1 — Server wire helpers** (`engine-input.ts`): `shakeSim(udid)`,
  `pasteText(udid, text, press)`, `doubleTapSim(udid, x, y, dims)`
  (timed sequence), `longPressSim(udid, x, y, ms, dims)`. Unit tests for
  translation/timing contract (fake child, like `engine-input.test.ts`).
- **T2 — Manual session surface**: routes `/api/manual/:id/{shake,paste,
  double-tap,long-press}` → `recordStep` + bus events (`manual.session.*`);
  drive-pad controls in the cockpit (shake button, paste box, double-tap +
  long-press as tap-modifiers). Manual tests mirroring `app-uninstall.test.ts`
  shape.
- **T3 — Alloy PR** (repo `../alloy`, branch + PR same session): adapter-a
  `press` gains `doubleTap?: boolean`; `alloy_act` input schema gains
  `doubleTap` (press) and `durationMs` (longpress). Contract tests. Sized by
  the T0(e) schema inspection: pass-through → type-only PR; closed schema →
  type + tool input schema + contract fixtures.
- **T4 — Case DSL + playback**: step kinds `doubleTap`, `longPress`, `shake`,
  `paste` (validation, step naming, overlay marker emission via existing
  `emitTap` path for positional verbs). Playback tests with a stub alloy
  dispatch (existing pattern in playback tests).
- **T5 — Gates**: boundary allowlist update, `pnpm run check`, full suites,
  live drill of a case containing all four verbs, commit + PR on a
  `feat/input-verbs-stage1` branch.

## Edge and failure cases

- Child not spawned / port dead: manual verbs fail with the existing
  `LEASE_LOST`-style honest error; case verbs fail the step with the engine
  error surfaced in `reason` (no silent skip — these are explicit intents,
  not dismiss-if-shown soft steps).
- Paste target field not focused: `press:true` pastes into whatever is
  first-responder — case authoring rule documented (tap the field first);
  `press:false` variant for UIPasteboard-reading apps.
- Double-tap cadence: recognizer budget ~250 ms; server-side sleeps keep the
  sequence ≤ ~220 ms total, validated by the T0(c) measured-gap criterion
  (≤ 120 ms). If the probe fails, fallback = single POST with all four
  events if the child accepts multi-line bodies (probe in T0), else child WS
  (new client in engine-input, still loopback-only).
- Busy gate collisions: mid-sequence `{"ok":false,"error":"device busy"}`
  acks are surfaced verbatim (F2), never retried blindly — a retried tap
  into a possibly-changed screen state is worse than an honest failure.
- Shake on non-iOS sim: child fails cleanly; step fails honestly.
- Paste ack-ok-but-nothing-focused: Cmd+V acks ok even with no
  first-responder; case docs carry the tap-field-first rule (F6, disclosure
  — no runtime guard in Stage 1).

## Validation and acceptance checks

1. T0 probe transcript saved under `reviews/` (drill evidence, neutral wording
   — signature scanner rule).
2. New unit tests green: wire helpers, manual routes, playback kinds.
3. `pnpm run check` green; server + web suites green; boundary test updated.
4. Live drill: four-verb case passes; overlay shows double-tap/long-press
   markers; shake + paste steps recorded green.
5. Alloy PR open with CI green; Lionidas PR stacked so the case path is
   honest about the dependency.

## Rollout / handoff

Lionidas PR `feat/input-verbs-stage1` (+ alloy PR same session). Stage 2
(edge gestures, streaming touch, pinch, key sends) starts from the brainstorm
artifact with the same child-wire foundation — no new discovery needed.
