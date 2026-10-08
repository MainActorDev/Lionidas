# Review — evidence overlay parity + timing plan

- Plan: plans/20261009T000000Z-evidence-overlay-parity-timing-plan.md (Ready, 2026-10-09)
- Evidence: brainstorm artifact + decision log (operator: engine-first,
  both persistence scopes) + source reads: TapOverlayVideo.vue,
  InteractionOverlay.vue, shared/src/tap-overlay.ts,
  evidence-recorder.ts (:59, :114-121), routes/templates.ts:559,
  routes/runs.ts:273, schema.ts:292 migration pattern, argent
  tool-server video-recording start.ts/stop.ts.
- Verdict: **Ready for implementation** — 4 findings folded, 1 disclosed

## Findings

### F1 [High — folded] stopEpoch must be captured BEFORE the await

- Location: plan T2.2 (`video_anchor_ms = stopEpoch − mediaDurationMs`).
- Evidence: the stop dispatch is awaited (:114); `Date.now()` AFTER the
  await includes stop latency (SIGINT + moov finalization — hundreds of ms).
  The wall clock must be read the instant the dispatch RESOLVES, and —
  better — cross-checked against the engine's own wall `durationMs`
  (`stopEpoch − session.startedAt` ≈ engine durationMs; use
  `stopEpoch = startedAtWall + durationMsEngine` when the engine provides
  it — engine-clock consistent).
- Consequence if unfixed: anchor systematically late by stop latency.
- Folded: T2.2 now computes stopEpoch from the dispatch-return timestamp
  and prefers the engine's wall durationMs for consistency.
- Verify: unit test with a fake dispatch asserting anchor math uses the
  pre-captured epoch.

### F2 [Medium — folded] mvhd in fragmented/edge mp4s

- mvhd is the MOVIE duration — for the simctl mp4s this is the recorded
  span (verified intent), but a malformed/truncated file can carry
  nonsense. Guard: `0 < mediaDurationMs ≤ wallDurationMs + 2000` else
  treat as absent (fallback anchor). Folded into T2.2 + T3.
- Verify: engine test with a garbage-duration fixture.

### F3 [Medium — folded] PATCH auth + device-default semantics

- The device-default write must fire only for ADMIN (same as the per-run
  write) AND only when the run has a udid. Folding also: the player must
  show WHERE the effective offset came from (run vs device default) so an
  operator isn't confused by a pre-applied offset they didn't set.
- Verify: route tests (403 viewer, clamp, upsert) + player label.

### F4 [Low — folded] requestVideoFrameCallback seek behavior

- rVFC does NOT fire on seek/pause by itself in all browsers; the player
  must also redraw on `seeked` and `play` events, else markers vanish
  until the next frame callback. Folded into T2.4.

### F5 [Low — disclosed] steps-fetch joins per replay

- The player joins tap.idx→step name via one steps fetch per mount; replays
  are single-run views — acceptable, cached by the browser within a
  session. No change.

## Checks passed

- Decisions trace to operator answers (engine-first, both scopes).
- Backward-compat chain explicit (engine field optional → fallback anchor).
- Cross-repo sequencing honest (Lionidas ships alone; argent PR follows).
- Tests: parity, offset math, route auth/clamp/upsert, anchor fallback.

## Cannot certify on paper

Frame-level accuracy claims (needs the T4 live drill + real mp4), argent
PR acceptance (upstream), and browser rVFC seek semantics across Safari
versions (drill covers the dev browser).
