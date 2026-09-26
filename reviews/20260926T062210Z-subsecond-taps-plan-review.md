# REVIEW — Sub-second taps plan (20260926T062210Z)

- Plan reviewed: `plans/20260926T062210Z-subsecond-taps-plan.md` (Ready)
- Review verdict: **NOT READY — 2 blockers, 2 majors.** The plan as written cannot meet its own headline acceptance condition (C2) because the primary mechanism (A) does not apply to the motivating case.
- Reviewed: 2026-09-26, against live run data (runs c1db84f7, fabfff2f, 49d0e794, f20b15a1, c01c0f7a) and current `playback.ts` source.

## Blockers

### F1 — Dead-reckoning cannot help the motivating case (PP tap on 17PM)

The 17PM's 4.2s cost is waiting for the disclaimer to *enter* the AX tree after scroll — it was **never resolved earlier in the run** (below the fold before the scroll; absent from the tree entirely on that device class — verified by direct probes 2026-09-26: disclaimer id and Link label both absent across 5-9s of polling on the scrolled screen). A's validity rule requires "selector resolved at least once earlier THIS run". Therefore:

- The map has no entry for `Privacy Policy` / `auth_legal_disclaimer` at step 5.
- A provides zero benefit for the exact step the plan targets.
- B (prefetch during the ~0.8s scroll step + ≤8×150ms polling ≈ 2s window) cannot cover a ~4s text-kit exposure delay — the brainstorm itself admits this ("alone: insufficient on 17PM").
- **C2's "PP tap ≤1.2s on 984FF244" is unachievable by A+B as designed.**

Correction options (pick one, make testable):
1. **Restore the recorded point to the template's PP step** (`x:101, y:700` exists in git history / earlier steps_json) and allow **point-projection** for selector+point steps: recorded point, scaled per-device (existing `coordinate-fallback-scaled` math), dispatched immediately with the selector kept as the post-hoc audit trail. This fixes the 17PM case in ~0.1s+dispatch and directly answers the operator's Q3 with the scaling already proven by the engine. It does reintroduce the recorded-point-trust question — mitigated by verify-at-next-step (already accepted).
2. Measure the scroll delta (diff two snapshots around the scroll) — costs ~2 snapshots/scroll, more code, and still cannot fabricate a rect for a never-seen element. **Does not fix F1 either.**
3. Reduce C2 to "≤1.0s on A2102153; 17PM unchanged (documented floor per BACKLOG #13)" — honest but abandons the stated goal.

Recommendation: option 1, with the template step updated to carry both point and selector.

### F2 — C3 contradicts the design's dropped retry

C3: "a deliberately stale projection (test) retries via full AX wait and still passes." Design (A, verify-then-retry paragraph): "no in-step retry — the next step's own settle poll IS the retry." These are incompatible: the acceptance test as written cannot pass without an in-step retry that the design explicitly removed. Pick one:
- (a) Keep no-retry design → rewrite C3 to "a deliberately stale projection fails the NEXT verifying step honestly (existing reason strings), and the run's evidence shows the landed point" — the miss is caught, one step later, matching the operator's accepted locality shift.
- (b) Keep C3 as-is → add the in-step retry (re-enter settle loop on post-tap screen-unchanged when nextPollsSelector is false) — contradicts the plan's own simplicity rationale.

Recommendation: (a) — matches the operator's decision #1 verbatim ("fails at the NEXT verifying step").

## Majors

### F3 — "Scroll-adjusted" is undefined (delta unknowable)

The plan says rects are projected "through the scroll delta", but the runner does not know how far a `scroll` gesture moved content (momentum + content-size dependent). Without a defined delta, "geometry-preserving: scroll only" still yields a rect with unknown offset. If F1 option 1 is taken (point-projection), F3 shrinks to: same-run last-rect projection is only valid when NO scroll intervened (rect may have scrolled off) OR the rect is re-validated by one cheap snapshot. State the rule explicitly; do not leave "scroll-adjusted" as hand-waving.

### F4 — B's in-flight flag can starve the prefetch

"Runs only while no other alloy dispatch is in flight" — during the scroll step's settle the foreground loop dispatches nearly continuously (60ms gaps). A naive global flag means B almost never runs. Define: the prefetch polls in the foreground loop's *sleep gaps* (permitted whenever no dispatch is awaited at that instant), with its own snapshot requests serialized through the same queue. Otherwise delete B (it adds surface for ≤0 gain).

## Minors

- F5: "any tap/type/expect clears the map entry" — expect steps don't move UI; clearing on them is conservative but silently halves A's hit rate (common pattern: tap → expect → scroll → tap-same-screen). Either justify the conservatism in one line or exclude expect from clearing.
- F6: `resolvedBy: 'projected'` requires updating the resolvedBy union type + any exhaustive consumers/tests; list them (playback.ts declaration, tap-resolution test file) so it isn't discovered at compile time.
- F7: The plan's baseline claim "iPhone 16 2.27s / 17PM 5.31s" matches run data (c1db84f7 idx5=2.273s; fabfff2f idx5=5.312s) — verified. Keep those run ids in the PR body.

## Questions for the operator

1. F1 option choice — restore the PP step's recorded point and enable point-projection (recommended), or accept a lowered C2 for first-exposure targets?
2. F2 option choice — (a) no-retry + rewritten C3 (recommended), or (b) in-step retry?

## Correctness walk (normal path, after recommended fixes)

Step 4 scroll ends → step 5 (tap PP, point+selector) → point-projection dispatches immediately (~0.1s) → tap executes (~0.9s) → D elides screenChanged (next step verifies) → step 6 expect settles on the document (AX present by then — text-kit finished during the tap's 0.9s) → pass. Budget ≈ 1.0-1.1s. Failure path: projection stale → tap lands wrong → step 6 expect polls its full budget → fails honestly with evidence; run blocked. Matches operator decision #1.
