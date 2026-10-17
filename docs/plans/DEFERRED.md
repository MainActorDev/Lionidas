# DEFERRED — parked work with triggers

Nothing rots silently: every entry names what was parked, why, and the
trigger that revives it. Append-only; entries are removed only when done.

## Platform state management — Phase A close-out (2026-10-17, `feat/app-states`)

- **Phase B: batch grouping + run-level provenance UI + AI write-proposals.**
  Edge 8's amortization (first case in a lane pays the walk, rest probe-hit)
  is auditable per-step today but not grouped per-run. Trigger: Phase A
  merged + a lane of N same-state cases exists in practice.
- **Probe-budget adaptivity.** The default probe budget is the 10s
  launch-settle window (edge 13; live S8 catch: 3s missed a state that WAS
  there after a cold relaunch, needlessly re-running the recipe). A flat 10s
  makes a mid-case PROBE MISS pay the full budget (10.3s observed in the
  mid-steps drill). Adaptive budget — first `ensureState` in a run uses the
  settle window, later ones poll short — is a tuning follow-up. Trigger:
  first real suite where miss latency shows up in run durations.
- **Forge-pin relaunch-continuity leg (edges 5/17).** Drill (b) exercised
  terminate + relaunch MID-RUN (uninstallReinstall) with the run stream,
  step audit, and expectations continuing green after the relaunch; the
  remaining leg — relaunch under a PINNED Forge scenario proving pins
  survive — needs an app with a network scenario (Foodiary carries none).
  Trigger: first scenario-carrying app case.
- **`ensureLogin`/`ensureLogout` YAML verbs** stay deprecated-but-parsed
  (full resolution order preserved: app_states entry → frozen legacy row →
  inline). Phase B may collapse them into the `ensure state` grammar once
  every app's login lives in the registry. Trigger: registry adoption
  across apps (no legacy-row consumers left).
- **Screens-page app-states panel scope.** S6 ships list + editor +
  revision display; a live probe-device affordance for state authors
  (parity with the screens states editor) is follow-up. Trigger: first
  authoring session that needs to discover identifiers while writing a
  recipe.
