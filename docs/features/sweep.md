# Sweep fallback — two-source truth for selector resolution

> Tier 1 of the [Baguette steal-list](../research/2026-09-05-baguette-steal-list.md).
> Plan: [2026-09-05-tier1-grid-sweep.md](../plans/2026-09-05-tier1-grid-sweep.md)

## The problem

A recorded step's selector (label/identifier) sometimes resolves against **zero** nodes at playback even though the control is plainly on screen and tappable. The canonical case: **SwiftUI childless containers** — tab bars, nav bars, segmented controls render as one opaque `Other` node with no children in the accessibility walk. The buttons inside are invisible to the tree, so selector-first resolution misses and the run degrades to the raw coordinate fallback (which breaks on any other device size).

This is the *invisible-but-visible* problem: the element exists, the user can tap it, only the AX walk is blind.

## The pipeline

```
selector miss (after launch-settle poll)
  │
  ├─ sweepTriggered?  childless container ≥200pt wide contains the
  │                    recorded point, no labeled node covering it
  │       │ no → coordinate fallback (unchanged behavior)
  │       ▼
  ├─ blindContainerAt → smallest qualifying container (tightest stencil)
  ├─ probePoints      → 5-point stencil: center + quarters, clamped inside
  ├─ sweepFind        → probe each point via devtools hit-test; first view
  │                     matching the selector wins
  └─ hit? → tap the hit's center; resolvedBy 'selector-sweep'
        miss? → coordinate fallback (unchanged)
```

Expect steps get the cheaper variant: a **single-point probe** at the recorded coordinate (no stencil) when the walk finds zero matches.

## Why fallback-only

The sweep never runs on a healthy tree. `sweepTriggered` requires the walk-blindness shape (childless wide container, nothing labeled at the point) — healthy screens resolve by selector as before. This keeps the sweep from masking genuinely-missing UI: if the element is truly absent, probes hit unrelated views, the selector predicate rejects them, and the run fails honestly.

## Why a 5-point stencil

The blind container's rect is known; the missed control is somewhere inside. Five probes (center + quarter-points) cover the interior of any bar-shaped container — a tab bar's buttons sit at predictable fractions of the width. Each probe costs ~27ms (measured live, Task 0), so the full stencil is ~135ms worst case. Larger stencils were rejected: the probe returns the *interactable* view at the point, so denser grids mostly re-hit the same views.

## Devtools warm-up (run-start, one-time)

The hit-test runs on a DYLD-injected devtools dylib inside the app. Injection requires a relaunch, and the env latch means the first relaunch lands without it. Live-verified sequence (once per run, only when a sweep-eligible step exists):

```
restart-app → throwaway probe (applies the DYLD env latch) → restart-app
```

Runs after `open`, so the extra relaunches coincide with what a run start does anyway. `CRUCIBLE_SWEEP=off` disables the sweep **and** the warm-up entirely.

## How it shows in run rows

- `evaluated_json.resolvedBy = "selector-sweep"` — the step resolved via probe
- `evaluated_json.sweep = { probes, hits, latencyMs, container, found }` — what was probed, what was found (the probe-found view enriches the stored hierarchy context: reality vs. the walk's blindness)
- `sweep.stats` bus event per qualifying step (drill reports, future UI)
- Expect probe pass carries reason `expect via point-probe (walk-blind)`

## Recording side

`recordExpectStep` accepts an optional `at: {x, y}` (the recorded tap point) — stored on the step and serialized as `at: [x, y]` in case YAML. The scalar `- expect: Label` form is untouched; coordinates only appear when recorded.
