# Tap Verification & Cross-Geometry Honesty — Scoped Plan

> **For Hermes:** Small-batch, TDD where testable. Root cause ALREADY proven from the audit trail (unlike the last plan, no diagnosis task needed).

**Goal:** A tap step must not "pass" unless the intended navigation/interaction actually happened — and cross-device replays must fail honestly rather than tap scaled guesses that walk the wrong path.

**Trigger (live, 2026-09-04, `run_f5bdb387` on iPhone 16):** privacy-policy case — steps 2–4 all `pass` while the privacy page never opened; only the expect caught it. Audit trail: step 2 `coordinate-scaled` (147,649 → 135,597 — **52pt vertical drift**, no selector), step 3 `coordinate-fallback-scaled`, step 4 `selector-recentred` (container-node center trap). Run "passed" 4 taps then failed at expect.

## Root causes (verified in code + audit trail)

1. **Pass semantics lie**: `insStep.run(..., 'pass', ...)` fires the moment the press dispatch succeeds (playback.ts:604). Whether the tap hit the intended element is never checked. On a wrong-path walk, every subsequent step can still "pass" mechanically.
2. **Blind proportional scaling for selector-less taps** (playback.ts:563-567): assumes uniform layout scaling across geometries. False — 428×926 → 393×852 moved the row-tap 52pt (list offsets don't scale; different status/nav chrome). Step 2 of the case has NO selector (recorded before the capture guard, never backfilled).
3. **`selector-recentred`** (playback.ts:549): when the scaled point is "far" from the matched rect, playback taps the selector's CENTER — but containers (e.g. `Horizontal scroll bar, 1 page`) have centers on OTHER controls. `resolveSelector` rejects screen-sized containers (isContainerNode, selector.ts:101) but NOT small/medium containers like scroll-bar groups.
4. Post-tap `awaitUiStable` (playback.ts:591-600) is SKIPPED whenever the next step polls a selector — and even when it runs, "stable" ≠ "changed". A tap that does nothing (wrong target, no-op point) looks identical to a successful navigation once the screen settles.

## Design decisions (mine, challenge-worthy)

- **Verification = screen CHANGED after the tap, when we know what should change.** Full "tapped the right element" verification needs post-tap snapshots + diffing; we already own the machinery (`hierarchySig`, used by awaitUiStable).
- **`coordinate-scaled` becomes fail-by-default** for selector-less steps on differing geometry. Blind-scaled taps are guesses wearing pass badges. Escape hatch: `optional: true` (skip, honest) or author a selector (the durable fix — the recorder backfills selectors for exactly this).
- **Recentre gets the container guard** the recorder has; plus the proximity slack shrinks when we're scaled (we KNOW our point is unreliable).
- **No auto-selector-backfill of old steps in this batch** — data migration of intent is a separate decision.

## Tasks

### Task 1 — `resolveSelector`: reject non-screen container nodes for RECENTRING (keep for confirmation)

**Files:** `server/src/manual/selector.ts`, test `server/test/selector.test.ts` (extend)

`isContainerNode` (screen-sized: ≥400×600) guards capture and resolve-for-tap. But `selector-recentred` taps the center of whatever `resolveSelector` returned — and a 358×48 scroll-bar container's center is a different control. Split the policy:

```ts
/** Nodes whose CENTER is not the recorded intent even when small:
 *  scroll containers, page-dot groups — multi-child wrappers. Screen-sized
 *  check stays for capture; recentring additionally rejects these. */
function isRecentreUnsafe(n: SnapNode): boolean {
  if (isContainerNode(n)) return true;
  const t = n.type ?? '';
  if (/scroll bar|scrollbar/i.test(n.label ?? '')) return true;
  return t === 'Other' && !n.hittable; // opaque wrapper with no own hit area
}
```

`resolveSelector` gains a mode param: `resolveSelector(nodes, sel, mode: 'confirm' | 'recentre' = 'confirm')` — recentre mode rejects `isRecentreUnsafe` matches (returns null → coordinate fallback path, which now scales, Task 3). Playback's recentre branch (playback.ts:549) passes `'recentre'`.

**Tests:** scroll-bar-container match → confirm-mode returns it, recentre-mode null; `Other`+non-hittable → recentre null; Button → both modes resolve; **[self-review addition] hittable `Other` container (e.g. a tappable card) → BOTH modes resolve** (the `!n.hittable` clause is what keeps the heuristic lossy-safe — hittable wrappers stay recentre-eligible because their center IS their tap target).

### Task 2 — Post-tap verification: screen must CHANGE when the recording says it navigated

**Files:** `server/src/manual/playback.ts`; test `server/test/playback-verify.test.ts` (new; fake-alloy harness with a mutable snapshot fixture — the playback-expect pattern)

**⚠ PERF (self-review):** sig-before/after adds 1–2 snapshots per tap (~0.5–1s/step; snapshot ≈450ms measured). Acceptable, but the implementation MUST reuse reads: for selector-bearing steps, the settle-poll's LAST pre-dispatch snapshot IS sig-before (no extra read); only coordinate-tap steps need one fresh pre-tap read. Documented in code.

Mechanism: **sig-before vs sig-after**, captured around the dispatch:

```
sigBefore = hierarchySig(lastSettleRead ?? freshSnapshot())   // reuse the settle poll's last read
dispatch tap
awaitUiStable(...)                        // existing wait
sigAfter  = hierarchySig(snapshot())
```

- `sigAfter !== sigBefore` → the screen changed → genuine pass (we don't demand WHICH change — the expect steps own specificity).
- `sigAfter === sigBefore` → the tap did nothing → **fail** with `tap produced no screen change` (blocked=1? NO — app-behavior class; plain fail. The tap DID dispatch; the app just didn't react — could be wrong target OR a legitimately non-navigational tap).

**The legitimately-static tap problem (the design tension):** not every tap navigates — toggles, checkboxes, tab re-selects, "add to cart" badges may not change the AX hierarchy. Naive fail-on-no-change breaks those. Resolution:
- **Verify only when the recording EVIDENCES change**: we have per-step recorded thumbnails at record time (steps_json `ts`/`thumb`). In this batch, use the cheaper proxy: verify only when the step HAS a selector (selector-bearing taps are the navigational ones in practice; blind coordinate taps get Task 3's treatment instead) AND the next step is not on the same screen… — too clever. **Settled simpler rule: verify ALL taps, but no-change is a WARN-level pass, not fail, in v1; the run detail shows `tap produced no screen change` as the step reason with status pass.** The privacy-policy failure would still have been caught by Task 3 + Task 4 (expect). Rationale: failing hard on every toggle breaks real suites; warning surfaces the lie in the audit trail where QA already looks. Upgrade to hard-fail once real usage shows warn-noise is low. (Marked ⚠ DECISION in code comment.)

**Tests:** tap + sig unchanged → pass with warn reason recorded in evaluated_json (`screenChanged: false`); tap + sig changed → clean pass; snapshot dispatch failure → skip verification (best-effort, never blocks).

### Task 3 — Cross-geometry honesty: selector-less taps on scaled devices stop guessing

**Files:** `server/src/manual/playback.ts` (the :563 branch); test `server/test/playback-geometry.test.ts` (new, same harness)

When `scaleX/scaleY !== 1` and the step has NO selector:
- **fail** the step with `cross-device coordinate tap without a selector — record a selector or mark optional` (status fail; NOT blocked — this is template-authoring debt, and the reason string says exactly what to do).
- `optional: true` → skip with that reason (escape hatch preserved).

Same-device replays (scale 1) keep raw coordinates — that's the recorded truth.

**Tests:** scaled + selector-less + not optional → fail with the reason; scaled + optional → skip; scale=1 + selector-less → pass (regression); scaled + selector present → unaffected (Task 1/2 paths).

### Task 4 — `selector-recentred` audit visibility + slack tightening

**Files:** `server/src/manual/playback.ts` (:539-550)

- Recentre slack 44pt → when scaled, tighten to 24pt (a scaled point has known error; "near" should mean NEAR).
- evaluated_json gains `{ recentred: true, distance: <pt> }` on recentre steps (the audit trail that would have made today's diagnosis instant).

**Tests:** unit-level on the slack math via the geometry harness (recentre distance recorded; tightened slack forces more fallbacks on scaled runs).

### Task 5 — Live drills + close-out

1. **Repro drill:** iPhone 16 + the privacy-policy case as-is → expect: step 2 FAILS (cross-device selector-less), run failed, steps 3+ skipped, expect never reached. The wrong-path green run is dead.
2. **Author-the-fix drill:** add a selector to step 2 via the recorder probe path (or yaml `on:` with the account screen's privacy-row label — probe it live first) → replay on iPhone 16 → taps resolve by selector, page opens, expect passes. THE durable path demonstrated.
3. Same-device regression: 14 Plus replay unchanged (all pass, no warns).
4. Full gates; skill update (pass-semantics lesson + the warn-not-fail decision + container/recentre split).

## Verification gates

Server-only: `pnpm typecheck && pnpm lint && npx vitest run`. (Signatures: no engine names in code/docs.)

## Edge cases

| # | Case | Behavior |
|---|---|---|
| 1 | Toggle/checkbox taps (no AX change) | Task 2's warn-pass — run stays green, reason visible in run detail |
| 2 | Tap opens a system alert (AX outside app hierarchy) | snapshot may not change → warn-pass; alert steps are engine-dispatched separately today — noted, not solved here |
| 3 | Last-step tap | sig-after still captured (post-step screenshot path already waits) |
| 4 | Scroll-step (not tap) | Task 2 verifies TAPS only; scrolls already have state-based settle |
| 5 | type steps | Same verification applies (input often changes AX: cursor/field state) — warn-pass on no change |
| 6 | Animations that don't touch AX | awaitUiStable waits them out; sig compares AX only → unaffected |
| 7 | Very fast double-step (next step's settle covers change) | sig-after taken AFTER awaitUiStable → includes the change |
| 8 | Old templates full of selector-less taps on other devices | Task 3 fails them loudly with actionable reason — the intended honesty; optional-flag migration is per-case authoring. **Both current cases affected (`tnc` step 0, `privacy policy` step 1) — cross-device replays of them will now fail until selectors are authored; that is Drill 2's demonstrated path.** |
| 9 | `contains:`/`ignoreCase:` expects | Untouched — already the honest layer |
| 10 | Screen-off/idle sim mid-run | snapshot dispatch fails → verification skips (best-effort), existing watchdog/abort owns it |
| 11 | **[self-review] warn-reason rendering** | RunDetail renders `reason` on EVERY row incl. pass (verified: RunDetailPage.vue:135) — warn text will be visible with zero UI changes |
| 12 | **[self-review] Task 3 classification** | Plain FAIL (red), not blocked — author debt is actionable-red per the verdict-semantics contract; revisit only if users treat it as infra noise |
| 13 | **[self-review] perf of verification** | +0 extra snapshots for selector steps (settle-poll reuse), +1 for coordinate taps — bounded, documented |

## Plain-English summary

Today a tap "passes" the instant the press is accepted — even if it hit nothing, or the wrong thing, or a scaled guess on a different-sized phone. That's how four taps "passed" while the page they were supposed to open never opened; only the final check told the truth. This plan makes three honesty fixes: taps that provably do nothing get flagged in the run detail; blind scaled taps without an element reference fail with instructions instead of guessing; and the "aim at the element's center" fallback stops aiming at wrappers whose center is some other control. The durable path stays what it's always been: steps that name their element — now the failure modes tell you that.
