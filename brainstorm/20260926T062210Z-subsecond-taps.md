# Sub-second taps despite late AX surfaces — can every tap reach ≤1s?

- Source prompt: "Can we push for each tap to reach 1s or less? Despite the 17 Pro Max accessibility surface problem."
- Created: 2026-09-26T06:22:10Z
- Status: Exploring

## Goal and context

Every tap step ≤1s end-to-end (settle + dispatch + post-check), even on the iPhone 17 Pro Max where the current bottleneck is APP-side: the disclaimer UITextView's text-kit layout exposes AX elements ~4s after scroll. Engine gates are already fast (exit within ~2 reads once the target exists); we cannot make the app expose AX sooner without production UI changes (rejected — BACKLOG #13).

So the question becomes: **what can the runner do with information it already has, without waiting for AX at all?**

## Current tap budget decomposition (17PM, PP step, 5.31s)

| Phase | Cost | Waits on |
|---|---|---|
| Settle poll until target resolves | **~4.2s** | app text-kit → AX exposure (the wall) |
| Tap dispatch | ~0.9s | runner round-trip |
| Post-check (screenChanged snapshot) | ~0.2s | AX again (fast once settled) |

The 0.9s dispatch + 0.2s post-check already nearly fill a 1s budget alone. So ≤1s needs BOTH: (a) near-zero pre-tap wait, and (b) a faster dispatch/post path.

## Exploration — candidate directions

### A. Dead-reckoning on scroll geometry (kill the pre-tap wait)

**Idea:** the step's recorded point (or last-known rect of the same selector in a previous run) is a strong prior after a deterministic scroll. For steps whose target was seen at any earlier point in the run (or in the same template's history), dispatch at the projected position WITHOUT waiting for AX confirmation; the post-tap verification (screenChanged / next expect) catches a miss.

- Mechanism: keep a per-run map selector→lastRect; after a scroll of known vector, project the rect by the scroll delta (or just reuse lastRect if it was already on-screen). Dispatch immediately at the projected point.
- Safety: this is what the coordinate fallback already does — the change is making it the PLAN for known targets instead of the fallback. Verification moves post-tap (did the screen change to what we expect?) instead of pre-tap.
- Risk: a wrong projection taps the wrong control and the run fails one step later — weaker failure locality. Mitigation: only dead-reckon when (1) the selector was resolved at least once this run, (2) the intervening action was a scroll, (3) the next step's expect will verify the outcome. Otherwise fall back to AX waiting.
- Expected win on the PP step: 4.2s → ~0.1s. Step ≈ 0.9-1.1s.

### B. Pre-arm the AX surface during the PREVIOUS step (overlap waits)

**Idea:** while step N (scroll) is settling, start polling for step N+1's selector in the background. By the time step N+1 starts, the target has had the whole previous step's duration + settle to appear; on the 17PM the disclaimer appears ~4s after scroll, and the scroll step only takes ~1s — so this alone doesn't cover the gap unless the overlap is combined with A.

- Cheap to implement (a prefetch promise keyed by next step's selector).
- Alone: insufficient on 17PM (4s text-kit latency > overlap window). Combined with A: covers the cases where A's projection is stale.

### C. Faster dispatch: cut the 0.9s tap round-trip

**Idea:** the tap command itself costs ~0.9s (accepted → completed in runner logs — XCUITest coordinate tap with app-guard checks). Investigate: (1) the FAST_APP_GUARD re-check on every act, (2) alloy_act payload shape (settle:false already), (3) whether a cheaper primitive exists in the device daemon (e.g., a raw touch event vs XCUITest tap). This is the device daemon/alloy territory — measurable win for EVERY step, not just late-AX ones.

### D. Post-check elision for verified chains

**Idea:** skip the screenChanged snapshot when the next step is an expect-with-selector (it already proves the outcome). Saves ~0.2s. Minor, safe, mechanical.

### E. App-side: pre-warm the text layout (out of scope per BACKLOG #13, listed for completeness)

Making the app lay out the disclaimer eagerly (e.g., `layoutIfNeeded` on appear, or `forceRendering`) would expose AX instantly — but it's a production code change for test speed, previously rejected. NOT proposed.

## Recommended combination

**A + C + D**, with B as opportunistic reinforcement:

- A removes the AX wall for any target seen earlier in the run (projection + post-verification).
- C is the only path to shrinking the irreducible dispatch cost (needed to actually land under 1s).
- D trims the tail.
- Realistic budget after: PP step ≈ 0.1s (wait) + 0.4-0.6s (dispatch, if C lands) + 0s (D) ≈ **0.5-0.7s**.

Without C, the floor is ~1.0-1.1s (dispatch alone) — right at the boundary, not comfortably under.

## Open questions

1. Is weakening pre-tap verification to post-tap verification acceptable for drill trust? (The run still fails loudly on a miss — just one step later. Evidence capture already screenshots every step.)
2. C requires touching the device daemon/alloy (shared surfaces other tools consume). In scope for this arc, or Crucible-only first (A+D) and C as a follow-up?
3. Should projection (A) be recorded-point-only (template author's intent, scaled per device) or last-rect-based (adapts to layout drift)? Recorded-point is simpler and matches the existing coordinate-fallback semantics.

## Next step

Operator picks scope: (i) A+D now (Crucible-only, ~1.0-1.1s floor), (ii) A+D+C (needs the device daemon/alloy work, targets ~0.6s), or (iii) B added on top. Then plan-mode for the chosen scope.
