# 030 — cockpit live tap visuals (choose the language)

Three visual languages for showing WHERE the system is interacting on the
cockpit's live stage. Each variant is a self-contained page: phone frame +
a scripted 4-step interaction loop (tap · type · scroll · tap) rendered in
that language. Judge them in motion — open each `index.html`.

| Variant | Idea | Strength | Cost |
|---|---|---|---|
| **a — ripple** | expanding circle + fade at the tap point (the current evidence/RunPanel family) | one language everywhere; quiet | easy to miss at a glance |
| **b — crosshair + label** | precise crosshair with the step name beside it | says WHAT and WHERE | busier; label truncation |
| **c — trace path** | numbered connected dots of the run's recent interactions, older ones fading | tells the flow's story | needs a horizon (last N) |

Mechanics are identical regardless of choice: WS `step.tap` events
(x, y, logicalW, logicalH) → draw on the stage canvas, `overlayAt` fade
timing. The sketch picks the LANGUAGE only.
