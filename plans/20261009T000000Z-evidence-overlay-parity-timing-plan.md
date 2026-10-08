# Plan — evidence overlay parity + step-precise timing

- Brainstorm: brainstorm/20261009T000000Z-evidence-overlay-parity-timing.md
  (all questions closed by operator 2026-10-09: engine-first "if it is the
  most correct way"; offset persistence per-run AND per-device)
- Status: **Ready**
- Branch: continue `chore/sidebar-regroup-2` (PR #26) for the Lionidas leg;
  argent engine change on its own upstream PR.

## Objective & completion conditions

1. Evidence replay shows the IDENTICAL 030-B visual as the live cockpit
   (crosshair guides + ember ring + label chip) — verified by a parity test
   asserting both surfaces emit the same canvas-op sequence.
2. Marker timing anchored to the engine-measured true first frame
   (`stopEpoch − mvhd mediaDuration`) with a manual per-run fine-align
   residual and a per-device remembered default; player ticks on presented
   frames (requestVideoFrameCallback, rAF fallback).
3. Backward compatible: no engine field → fallback anchor (today's
   start-dispatch stamp) → everything still works.

## Verified facts (source-read 2026-10-09)

- Evidence player: `web/src/components/TapOverlayVideo.vue` (old ring+dot
  visual, rAF tick, `overlayAt` from `shared/src/tap-overlay.ts`).
- Live visual: `InteractionOverlay.vue` (030-B), draw code private to the
  component (commit 5eb04d0).
- Recorder: `server/src/manual/evidence-recorder.ts` — stop dispatch at
  :114-121 (result has `video.hostPath`; envelope passes extra fields
  through), `video_started_at` written at start (:59).
- Route: `/api/templates/:id/run-taps` (templates.ts:559) returns
  `{runId, videoStartedAt, taps}`; steps route exists (runs.ts:273) for the
  idx→name join.
- Engine: argent `stop-video-recording` (stop.ts) already scans mp4 bytes
  for moov (both layouts); wall-clock `durationMs` from `session.startedAt`.
- Schema: runs migration pattern at schema.ts:292 (`ALTER TABLE ADD COLUMN`).

## Stages

### T1 — shared draw fn + evidence parity (Lionidas, no engine dep)

1. `shared/src/interaction-marker.ts`: pure `drawInteractionMarker(ctx, m,
   {w, h})` — the 030-B op sequence (guides, ring, caret for type, label
   chip with offscreen flip), opacity from caller. Exported op-list variant
   for tests.
2. `InteractionOverlay.vue` calls it (behavior unchanged; its existing
   tests keep passing).
3. `TapOverlayVideo.vue` calls it: fetch `/api/runs/:id/steps` once, join
   `tap.idx → step name` (chip `tap · <name>`; unknown idx →
   `interaction`), pass opacity from `overlayAt`.
4. Parity test: both components driven with the same marker → identical
   recorded op sequences (canvas getContext mock, per the
   interactionOverlay.test.ts pattern).

### T2 — timing: anchor, offsets, persistence (Lionidas)

1. Schema: `ALTER TABLE runs ADD COLUMN video_anchor_ms INTEGER` +
   `ADD COLUMN overlay_offset_ms INTEGER DEFAULT 0`; new table
   `device_overlay_defaults(udid TEXT PRIMARY KEY, offset_ms INTEGER NOT NULL,
   updated_at INTEGER NOT NULL)`.
2. Recorder (evidence-recorder.ts): at stop, capture `stopEpoch` the
   instant the dispatch resolves (review F1 — never Date.now() after
   awaits); when the engine returns wall `durationMs` prefer
   `stopEpoch = startedWall + durationMs` (engine-clock consistent).
   Read `mediaDurationMs` when present and sane
   (`0 < mediaDurationMs ≤ wallDurationMs + 2000`, review F2) →
   `video_anchor_ms = stopEpoch − mediaDurationMs`; else leave NULL (route
   falls back to `video_started_at`). Single migration point in the stop
   block (:114).
3. Routes:
   - `/api/templates/:id/run-taps`: return `anchor =
     video_anchor_ms ?? video_started_at`, plus `offsetMs` and the
     device-default offset when per-run offset is unset.
   - `PATCH /api/runs/:id/overlay-offset` `{offsetMs}` (admin; clamps to
     ±10s; skips the device-default upsert when the run has no udid —
     review F3): writes run row, and upserts `device_overlay_defaults`
     for the run's udid (the "both" persistence).
4. Player (TapOverlayVideo): apply `offsetMs` inside `overlayAt` call
   (playhead adjustment); ◀/▶ buttons (±100ms, shift-click ±25ms) calling
   the PATCH, current value shown, plus a provenance hint (run vs device
   default — review F3); tick via `requestVideoFrameCallback` when
   present, rAF fallback, AND redraw on `seeked`/`play` events (rVFC
   doesn't fire on seek — review F4).
5. Server tests: anchor fallback chain, offset PATCH (auth, clamp,
   device-default upsert), run-taps response shape. Shared tests:
   offset-aware overlayAt math (marker appears exactly at tap−offset).

### T3 — engine change (argent, upstream PR — separate repo/branch)

1. `stop.ts`: parse mvhd duration (find 'mvhd' box — walk top-level atoms
   from ftyp; timescale+duration fields; h264 fast-start AND hevc tail
   moov both covered since we scan atom table not byte windows) →
   `mediaDurationMs` in the result + test fixture mp4s (generate minimal
   boxes).
2. PR to argent upstream (fork branch `feat/video-media-duration`), same
   discipline as the butler skipDirs thread. Lionidas consumes
   opportunistically — T2 already works without it.

### T4 — gates + live drill

1. Full gates: server suite + web suite + typecheck + build.
2. Live drill: run `tnc` → replay evidence in the player → visual matches
   cockpit (crosshair+label) → tap markers land on the finger-press
   moments → ◀/▶ adjusts → offset persists across reload → device default
   appears on the NEXT run's player. Screenshot evidence for the PR.

## Out of scope

- Re-encoding/normalizing videos; changing codecs.
- Auto-alignment beyond the engine-measured anchor (closed as the design).
- Alloy changes (field passes through the envelope untouched).

## Sequencing rationale

Lionidas-first (T1+T2 ship value alone: parity + manual align), argent T3
parallel/follows, T4 drills the union. If the argent PR stalls upstream,
nothing blocks — the fallback anchor + manual align stand alone.
