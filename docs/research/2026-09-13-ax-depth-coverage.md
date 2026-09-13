# AX-Depth P1 — Coverage diff: alloy_snapshot vs engine describe_ui (2026-09-13)

Env: iPhone 17 Pro sim (835EE2B0), iOS 27.0, Xcode 26.4, engine 0.1.61
(repo-root binary), LP consumer-dev v11, Foodiary v4. CLI captures; the
supervised child on :8422 was already running (captures were CLI-side, own
process). Fixtures: `server/test/fixtures/ax-depth/<case>/tree-engine.json`.

## Coverage table

| Case / probe | alloy_snapshot | engine full tree | engine hit-test | verdict |
|---|---|---|---|---|
| **B** MINGGU header matches (Foodiary) | 4 (label propagated to full-screen ancestors) → resolve null | **1** (`AXStaticText` only, propagation gone) | returns exactly that StaticText at (100,98) | ✅ RESOLVED natively |
| B count stability (same selector) | countMatches 3 (undercount) | 1 (true) | — | ✅ corrected |
| **A** status-bar items (Foodiary) | 0 | **6**: clock "17.31", Dynamic Island, Cellular, signal, "100% battery power", back-to-LP button | n/a (cross-process anyway) | ✅ RESOLVED |
| **A** status-bar items (LP) | 0 | **0** — asymmetric with Foodiary (see below) | — | ⚠ PARTIAL |
| Tab-bar buttons (LP: Home/Paketmu/Bayar/Akun) | present (`TabBar` + 4 `Button`s, identifiers) | **MISSING from full tree** (childless `AXGroup "Bar Tab"`); hit-test at (340,815) returns `AXRadioButton "Akun"` | ✅ rescues them | ⚠ hit-test-only |
| Tab-bar buttons (Foodiary) | present | present (`AXRadioButton` ×4 + identifiers) | — | ✅ both |
| Hierarchy depth (LP) | nested (parentIndex chains) | **flattened** — app root with ~33 depth-1 children | — | ⚠ regression for inspector nesting |
| Richness | label/type/hittable | role (AXRadioButton…), subrole, title, help, value, enabled, focused, hidden | same | ✅ engine richer |

## Honest asymmetries (recorded, not explained away)

1. **Status bar appears for Foodiary but not LP.** Working hypothesis (NOT
   verified): the grid sweep skips points inside content-leaf frames; LP's
   tab-zone/bottom leaf `AXStaticText " " (0 810; 402×148)` plus top coverage
   may swallow the probe points that would have found status-bar items —
   Foodiary's layout left them reachable. Needs one instrumented check in
   the fork before any conclusion. Do NOT generalize "engine sees the
   status bar" from the Foodiary row alone.
2. **Engine walk returns flat lists for LP** (all children at depth 1) —
   the inspector's nesting view and any lineage logic would degrade.
   Foodiary's tree retained depth (StaticTexts nested under meal Buttons).
3. **Hit-test output is an element, not a tree** — adoption for the sweep
   fallback is direct (it already consumes per-point results), but it cannot
   replace full-tree flows.

## Latency (CLI, cold — includes process spawn + XPC warm-up)

3× `describe-ui` round-trips: **0.61s / 0.45s / 0.76s**. The skill's
"hundreds of ms warm-up" holds, and full CLI round-trip stays under 1s —
on-demand use (inspector refresh, sweep probes, corpus capture) needs no
long-lived process. Watch-poll cadence (2.5s) would also be met, but steady
-state numbers should still come from serve/WS before any polling adoption
(P1 plan item, deferred until that decision matters).

## Engine-unreachable cases

None hit: both apps returned trees on every capture. (Transient capture
races during app switching were operator error — resolved by terminating
the other app first; not an engine failure. Recorded as a drill lesson:
**terminate-then-launch before capture**.)

## P1 verdict for the P3 gate (≥2/3 corpus uniquely resolved)

- Case B: uniquely resolved (1 match, no propagation) — ✅ counts.
- Case A (Foodiary): resolved (6 status-bar items) — ✅ counts.
- Case A (LP): not resolved on the full tree — the honest partial, with a
  named mechanism to check in the fork.

2 of 3 corpus cases resolve on the engine full tree alone → **adopt-gate
threshold met provisionally**; the LP tab/status-bar gap is exactly what
the hit-test sweep-fallback seam (existing `sweep.ts`) covers, and P2
(predicate stress + factory) still must run before any wiring decision.
