# Parity check: baguette device cockpit vs Lionidas cockpit

- Source prompt: "Let's do a parity check. In baguette's device cockpit, what
  does it have that Lionidas doesn't?"
- Created: 2026-10-09T00:17:03Z
- Updated: 2026-10-09T00:41Z (user selected input-verb scope; engine matrix verified)
- Updated: 2026-10-09T01:05Z (user accepted staged packaging; Stage-1 plan written)
- Status: Direction selected — staged; Stage-1 plan Ready (see plans/)

## Goal and context

Baguette (sibling repo — the tool engine family) has a device-control surface
("device cockpit": the /devices/:udid sim view + device farm). The operator
wants a gap analysis: which of its capabilities are MISSING from Lionidas's
cockpit, to decide what to adopt. This is a comparison of VERIFIED feature
sets, not code quality.

## Confirmed inputs and decisions

- Baguette feature inventory read from `../baguette/docs/features/` (29 docs,
  read 2026-10-09). Lionidas inventory from this repo's cockpit code + docs
  (MenuBar, StageBezel, device pages) — both read from source, not memory.
- **USER DECISION (2026-10-09): "I want all of them in the input verbs"** —
  scope = the full input-verb cluster from the gap table: double-tap, shake,
  edge/system gestures, streaming touch, host-keyboard passthrough, paste,
  pinch. Device-state (appearance/status-bar/motion/camera) and viewing
  surfaces (3D/twin/farm-grid/view-record/logs) stay OUT of this round.

## Engine availability matrix (verified in source, 2026-10-09)

How each verb can reach Lionidas. "A" = the tool runner engine (via alloy
`client.interactions.*`); "B" = engine-B flow path (`callBTool`).

| Verb | Underlying capability | Path | Effort |
|---|---|---|---|
| **Double-tap** | the tool runner `sequence` command, kind `doubleTap` (RunnerTests+SequenceExecution.swift:12,194) | A-sequence via new alloy registration | alloy + Lionidas |
| **Long-press** | `interactions.longPress` already registered (registrations.ts:210) | **already wired in alloy** | Lionidas only |
| **Edge gestures (swipe-home, app switcher, NC, lock)** | baguette `IOHIDDigitizerDispatch` slow-drag recipes (touches.md:157-159) | needs HID dispatch on engine side | engine + alloy + Lionidas |
| **Streaming touch** | baguette `Touch1` phases + `edge` hint | engine-side streaming API | engine + alloy + Lionidas |
| **Shake** | `simctl spawn … notifyutil` motion-shake signal (MotionShake via SimctlPasteboard-style subprocess; baguette ShakeCommand.swift) | A: add `shake` as an alloy_act action calling simctl spawn | simctl-native, cheap |
| **Paste** | `simctl pbcopy` (SimctlPasteboard.swift:32) + Cmd+V press | A: `paste` alloy_act action | simctl-native, cheap |
| **Pinch** | the tool runner? none found — baguette `Pinch.swift` gesture on HID | engine-side | engine work |
| **Host keyboard** | baguette `Keyboard.swift` host-key events | engine-side keyboard session | engine work |

Key structural fact: alloy's `alloy_act` today only forwards press/fill/scroll/
longpress/keyboardDismiss to engine A (registrations.ts:191-214). Anything
new = a new alloy registration (or act action) + Lionidas case-step verb +
cockpit drive control. NOTHING input-side can bypass alloy — the
device-boundary allowlist guarantees that.

## The gap table (baguette has → Lionidas status)

### Gaps — device-input verbs (Lionidas drives via engine dispatch: tap/type/scroll only)

| Capability | Baguette | Lionidas today |
|---|---|---|
| **Double-tap** | dedicated verb (process-boundary timing) | ❌ only single taps |
| **Shake gesture** | motionBegan/Ended delivery | ❌ none |
| **Edge/system gestures** (swipe-home, app switcher) | IOHIDDigitizer path | ❌ none |
| **Streaming touch** (drag with live finger) | single-finger streaming | ❌ (drive mode taps only) |
| **Host keyboard → sim** | every keystroke when focused | ⚠️ partial: type verb exists in cases; manual drive has no keyboard passthrough |
| **Paste/clipboard** (emoji, non-Latin — bypasses US-ASCII type limit) | in+out pasteboard | ❌ none |
| **Pinch** | (stream sidebar shows pinch overlay) | ❌ none |

### Gaps — device-state control

| Capability | Baguette | Lionidas |
|---|---|---|
| **Interface/appearance control** (light/dark, contrast, 12 Dynamic-Type sizes) | read+write | ❌ none |
| **Status-bar override** (time, carrier, battery, signal) | write+clear | ❌ none |
| **Location spoof** | set lat/lon | ⚠️ server has location ops for cases; no cockpit surface |
| **Motion injection** (CMMotionActivity, pedometer, gyro) | three entry points | ❌ none |
| **Camera source** (webcam/still/video → AVCapture) | pipe into sim | ❌ none |
| **File upload / drag-drop install** | type-routed | ⚠️ install exists via packages picker; no arbitrary file/photo drop |

### Gaps — viewing/streaming surfaces

| Capability | Baguette | Lionidas |
|---|---|---|
| **3D device rendering** (model-matched, gyro twin from a real phone) | live 3D stage | ❌ none (2D bezel) |
| **Companion screens** (CarPlay plane, paired Watch udid) | streamable | ❌ none |
| **Device farm grid/wall/list** (multi-device focus) | /farm | ⚠️ Lionidas has a device WALL page + cockpit tabs; no grid view of live streams |
| **Browser-side view recording** (capture what you see) | one-button WebM | ❌ (evidence video is sim-recorded, not view-captured) |
| **Live unified-log stream** (per-device, filterable) | WS logs | ⚠️ run activity feed exists; no oslog stream |

### Where Lionidas is AHEAD (context, not gaps)

Test orchestration (cases/suites/runs/evidence/verdicts), build→test loop,
projects/CI, forge network scenarios, screen registry, baseline governance,
agent layer. Baguette is a device-control surface; Lionidas is the QA brain
that USES one. The cockpits overlap only in the drive/stream surface.

## Exploration

**Adoption reality check**: Lionidas talks to devices through the Alloy
engine (device-boundary allowlist). Every baguette capability above would
arrive as an ENGINE capability (if the tool engine exposes it) or a new
allowlisted host module. Nothing here is a Lionidas-side solo build.

Priority candidates by operator value for a QA cockpit (proposal — not
accepted):
1. **Double-tap + edge gestures** — real case coverage (list rows, back
   navigation) that today's cases literally cannot express.
2. **Interface/appearance + status-bar** — accessibility & localization
   passes need dark/contrast/text-size flips; screenshots need clean status
   bars. High QA value, cheap (simctl ui + status_bar).
3. **Paste** — unlocks non-Latin credential flows (ID phone numbers with
   prefixes) that `type` mangles.
4. **3D/twin, farm grid, camera, motion** — flashy but not on the current
   QA critical path.

## Open questions

1. **Packaging**: one big round, or staged? My proposal (not accepted):
   - **Stage 1 (Lionidas + alloy only, no engine work)**: double-tap via
     the tool runner `sequence{doubleTap}` registration, long-press (already in
     alloy), shake + paste (simctl-native — no engine changes).
   - **Stage 2 (engine work)**: streaming touch + edge gestures (HID
     dispatch), pinch, host-keyboard passthrough.
   Staging ships the 4 cheap verbs now and isolates the HID work.
2. **Case-DSL shape**: new step kinds (`doubleTap`, `paste`, `shake`) vs one
   generic `gesture` step with params. Affects case authoring, evidence
     markers, and the drive UI. Decide at plan time.
3. **Drive-mode surface**: cockpit mini-pad for these verbs (long-press
   button, shake button, paste box) — or cases-only this round, drive pad
   later?

## Next step

Answer the packaging question (staged vs one round), then run
`hms-plan-from-brainstorm` on this artifact for the input-verbs round.
