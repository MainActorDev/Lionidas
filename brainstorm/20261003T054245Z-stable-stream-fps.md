# Stable ≥20 FPS for the cockpit stream — is it achievable?

- Source prompt: "is there a concrete way to make the FPS stable? Minimum at least at 20FPS. Is it something achievable?"
- Created: 2026-10-03T05:42:45Z
- Status: Applied (2026-10-03) — set_fps 30 + rolling-peak chip + fps idle decay

## Goal and context

The operator wants the cockpit device stream to hold a **stable floor of 20fps** instead of the observed fluctuation (8↔20). Grounded in both sides of the pipeline before answering (Lionidas `deviceStream.ts` + the engine `baguette/AVCCStream.swift`), plus a **live measurement**: 12 alternating swipes over 20s sampled every second.

## Confirmed inputs and decisions

Verified facts (code + live drill, 2026-10-03):

1. **The stream is callback-driven, not a fixed-rate sampler.** The engine encodes "every time SimulatorKit composites a frame… this preserves the simulator's real cadence" (`AVCCStream.swift:8-10`). FPS observed = the simulator's own composites, capped by `set_fps` (client asks 60) — there is no engine-side frame *generator*.
2. **Static screens are intentionally near-silent.** A seed gate (pixel-change) drops identical composites; a quiet screen ships ≈0 fps and the client's still-polish path takes over (`~0.5fps idle` is the documented design). This is a feature (bandwidth/CPU/evidence settle detection), not a bug.
3. **Live motion measurement (the drill above):** during continuous swipes the stream held **20, 20, 8, 20, 20, 8…** — a repeating pattern, not random jitter. The 8s are the seconds *between* swipes (animation settled → gate closes), 20s during motion. So: **motion already reaches 20fps; the "instability" is the quiet-gate doing its job between gestures.**
4. Client requests `set_fps 60 / set_bitrate 8Mbps`; a prior note says 60fps@native saturated HW decode once ("if motion ever stutters, tune fps down before bitrate").
5. The fps chip counts *received* frames per second client-side (`countFps` in `deviceStream.ts`).

## Exploration

### What "stable ≥20fps" can mean — three distinct targets

**A. Motion floor (recommended): while pixels move, never dip below 20.**
Today's motion rate ≈ the sim's composite rate — SpringBoard scrolling produced exactly 20fps sustained (measured). The risk to a *floor* is bursty composites (heavy pages encode slower). Concrete levers:
- Client `set_fps: 30` instead of 60 (halves encode/decode cost per frame; 30 > 20 with headroom; guards the documented HW-decode saturation).
- Engine already has `force_idr` on stuck decoders; no change needed.
- Acceptance test: scripted swipe for 10s, sampled fps ≥20 in every 1s window *containing motion*.

**B. Literal 20fps always, even on static screens.**
Achievable but defeats the design: it means disabling/bypassing the seed gate (re-encode identical frames 20×/s ≈ 8Mbps of nothing, CPU burn, and the quiet-detector that drives evidence settle + the still-polish path breaks). Only worth it if some consumer needs a heartbeat; a control-channel `set_min_fps` knob (engine change, TDD-gated in that repo) could do a 1fps keepalive without full 20.

**C. Perceived smoothness (what the operator probably feels).**
The 8↔20 cycle *reads* as stutter because the chip flashes. With (A), the honest fix for the read: keep the fps chip but label quiet as `idle` (already does: "live · idle (screen unchanged)") — the flicker during gesture pauses is the *label* switching. Hysteresis on the chip (hold "20fps" for 2s after quiet) is a 5-line client change that removes the flicker without touching the stream.

### Recommended direction

**A + C**: `set_fps 30` (client one-liner) + fps-chip hysteresis (client) + a scripted motion-floor check. No engine changes. Static-screen 20fps (B) rejected as design-defeating; revisit only if a concrete consumer needs it.

## Open questions

1. Does any consumer need constant frames as a liveness heartbeat (e.g. flake detection), or is the state channel enough? (Determines whether B's 1fps keepalive has any value.)

## Applied — outcome

- `set_fps` 60→30 (deviceStream.ts) — measured motion floor is ~20; 30 caps the wire with headroom and halves decode cost.
- fps chip: rolling 2s PEAK (StageBezel) — the instantaneous label flickered 20→8→20 between swipes; peak reads as the motion rate. Two iterations found live: (1) a zero-guard hysteresis missed it because scroll-settle never hits 0 fps; (2) the window must be tick-fed — an unchanged fps never fires the watcher.
- fps meter idle decay (countFps): the meter only ran on frame arrival, so a still screen froze the last reading forever; now decays to 0 after 1.2s of silence → chip shows `idle` on true quiet.
- Verified live (6 swipe pairs, 24 samples): steady `live · 20fps` throughout, no 8↔20 flicker. Post-drill the chip held 20 — canvas hashing proved the Lion Parcel app's auto-advancing promo carousel genuinely animates the screen: honest, not stuck. 31/31 web tests.

## Next step (original)

Apply the A+C patch on `feat/device-cockpit`: `set_fps` 60→30, chip hysteresis, and the scripted swipe drill asserting ≥20fps in every motion window. ~30 minutes including the drill.
