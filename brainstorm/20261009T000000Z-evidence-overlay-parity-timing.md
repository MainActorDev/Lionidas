# Evidence overlay parity + step-precise timing

- Source prompt: "1. Ensure the video evidence showing the same visual overlay
  as when running test case. 2. Ensure the visual timing is precision to the
  step."
- Created: 2026-10-09 (post-midnight session)
- Status: Direction selected (questions closed 2026-10-09 by operator)

## Decision log

1. "Engine changes is preferable if it is the most correct way" (operator,
   2026-10-09) → Option B promoted: measure the anchor correction from the
   engine's own artifacts, not manual calibration alone. Option A (manual
   fine-align) stays as the residual belt-and-braces UI.
2. "both" (operator, 2026-10-09) → offset persistence per-run AND per-device
   remembered default (A+).

## Goal and context

The live cockpit now paints **030-B** (crosshair guides + ring + step-label
chip, 1400ms fade) via InteractionOverlay — but the evidence video player
(TapOverlayVideo.vue) still draws the OLD language: white ring + blue dot,
no label. The user wants (1) identical visuals in evidence replay, and (2)
the marker to appear at EXACTLY the moment the tap lands in the video.

## Confirmed inputs and decisions

- Live visual (locked): sketch 030-B — crosshair + label chip
  (web/src/components/cockpit/InteractionOverlay.vue, commit 5eb04d0).
- Evidence player today: white-ring/blue-dot circles (TapOverlayVideo.vue),
  `overlayAt()` timing from shared/src/tap-overlay.ts (fade 1400ms).
- Timing chain (code read):
  - `runs.video_started_at` = `Date.now()` when the alloy_video START
    dispatch RETURNS (evidence-recorder.ts:59) — "best-effort anchor".
  - `run_taps.ts` = `Date.now()` at the tap emit site (playback.ts:1718).
  - Player maps: rel = tap.ts − video_started_at, compares to
    video.currentTime×1000.
- Both clocks are the same host's epoch ms (no skew); the error sources are
  (a) encoder startup delay between dispatch-return and FIRST FRAME, and
  (b) player decode jitter (small).

## Exploration

### Part 1 — visual parity (mechanical)

Extract ONE shared draw routine `drawInteractionMarker(ctx, {fx, fy, label,
kind, opacity}, canvasW, canvasH)` (in shared/ as pure canvas code or a web
util — shared/ wins: server-side tests can assert ops). Both surfaces call
it:
- InteractionOverlay (live) — identical output.
- TapOverlayVideo (evidence) — needs the step LABEL: fetch run steps once
  (`/api/runs/:id/steps` exists), map `tap.idx → step name`, chip reads
  `tap · <name>` exactly like live. (overlayAt already carries idx.)

### Part 2 — timing precision to the step (the real design question)

Error today = (first-frame time − dispatch-return time) + jitter. The
encoder startup gap is unknowable from the API (alloy_video returns ok,
no frame ack; the mp4 often only materializes at stop — cannot watch bytes).

Options:

- **A — Persisted fine-align offset (rec)**: keep the epoch anchor, add
  `overlay_offset_ms` to runs (default 0); evidence player gets ◀/▶ align
  buttons (±100ms steps, current offset shown, maybe also drag). Persisted
  per run via a small PATCH. One-time 5-second alignment per video makes
  every subsequent marker frame-exact; drift within a run is near-zero
  (same-clock). Honest: manual calibration, zero guessing.
- **B — Auto anchor improvement**: probe first-frame availability
  (screenshot at start, frame-compare) — engine gives no handle; heavy and
  still approximate. Rejected as over-engineering for now.
- **C — Step-gated markers**: show marker only while the player's step row
  for idx is "current" (from the steps panel), ignoring video time — loses
  the fade-on-tap feel and doesn't sync to pixels. Rejected.
- **A+ (nice-to-have)**: remember the last used offset per DEVICE (encoder
  behavior is stable per host) as the default for new runs — aligns most
  videos to within ~100ms out of the box.

Also part of precision hygiene: use `requestVideoFrameCallback` (where
available) instead of rAF for the tick — draws exactly on presented frames,
killing decode-jitter wobble; fallback rAF.

## Open questions

None — closed by the decision log above.

## Engine facts (verified in source, 2026-10-09)

Chain: Lionidas → alloy (tool registry, registrations.ts:307 alloy_video) →
the **tool engine** (video-recording tools, engine repo) →
`simctl io recordVideo`.

- `start-video-recording` spawns simctl, waits a 1500ms early-error window,
  returns `{sessionId, outputPath}` — **no first-frame ack exists** (Apple's
  simctl emits none).
- `stop-video-recording` already reads mp4 bytes (moov-atom scan, both
  fast-start and tail layouts) and returns wall-clock
  `durationMs = Date.now() − session.startedAt` + `sizeBytes`.
- The mp4's **mvhd atom carries the true media duration** — parseable with
  the same file-handle machinery the moov scan uses.

## Corrected design (engine-measured anchor + manual residual)

**Engine change (tool engine, upstream PR):**
- `stop-video-recording` additionally parses mvhd duration → returns
  `mediaDurationMs` alongside wall-clock `durationMs`.
- Why most correct: the wall-vs-media delta IS the accumulated
  startup/frame-drop error. TRUE first-frame epoch = stopEpoch −
  mediaDuration. Anchoring to that removes the dominant error term with
  zero guessing.

**Lionidas change (evidence-recorder):**
- Persist `video_anchor_ms = stopEpoch − mediaDurationMs` (fallback: the
  current start-dispatch stamp when the field is absent — old runs and
  engines without the change keep working).
- Per-tap timing becomes exact modulo sub-frame jitter.

**Manual residual (option A kept):** per-run `overlay_offset_ms` + ◀/▶
align buttons for the honest last mile (player/decode side); per-device
remembered default (A+) auto-applies to new runs.

**Cross-repo note:** the tool engine owns this — the change lands as an
upstream PR; alloy passes the new result field through untouched
(envelope-transparent); Lionidas consumes.

## Next step

Close the 2 questions → plan: shared draw fn + label join (parity), offset
column + PATCH + align buttons + rVFC tick (precision), tests (draw-op
parity test asserting both surfaces emit identical op sequences; offset
math test), live drill: run a case, replay evidence, align, verify the
crosshair lands on the finger.
