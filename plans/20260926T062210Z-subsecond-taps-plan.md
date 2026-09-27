# PLAN (Ready) — Sub-second taps: dead-reckoning (A) + post-check elision (D) + pre-arm (B)

- Source brainstorm: `brainstorm/20260926T062210Z-subsecond-taps.md` (2026-09-26T06:22Z)
- Plan status: **Ready (rev 2)** — review-folded 2026-09-26 (reviews/20260926T062210Z-subsecond-taps-plan-review.md: F1 opt 1 point-projection, F2 opt a no-retry C3, F3 no scroll-delta, F4 prefetch in sleep gaps, F5-F7 minors). Operator: "Apply the fixes. Then proceed."
- Scope: D → A(point-projection) → B in Crucible; C (dispatch cost) as a separate the device daemon investigation brief, no code here.
- Baseline: iPhone 16 (A2102153) PP tap 2.27s; iPhone 17 Pro Max 5.31s (runs c1db84f7/fabfff2f).

## Decision log (operator, chat 2026-09-26)

1. Post-tap verification accepted: a projected tap that misses fails at the NEXT verifying step, loudly, with evidence — failure locality moves one step, trust model unchanged.
2. All levers in scope; C deferred to a separate the device daemon investigation.
3. Projection source: **last-seen rect within the same run** (live geometry), never cross-run. Cross-device scaling ONLY as a candidate followed by verify-then-retry; the existing fail-honestly cross-device guards for coordinate-only steps stay byte-identical.
4. Projection invalidated by any navigation action (push/pop/tab switch/arrive/refresh verbs) — only scrolls preserve geometry.

## Objective and completion conditions

Every selector-backed tap step ≤1.0s on the pinned sim (iPhone 16, A2102153), and the 17PM (984FF244) PP step ≤1.2s despite late AX exposure. Done when:
- (C1) Baseline template passes 7/7 on both sims.
- (C2) PP tap measured ≤1.2s on A2102153 AND 984FF244 across 3 consecutive runs each (point-projection + ~0.9s dispatch + margin; ≤1.0s on the 16 expected but not gated — dispatch round-trip is the floor).
- (C3) Miss-handling proven (F2 opt a): a deliberately stale point-projection (test) taps, the NEXT verifying step fails honestly with existing reason strings, and the evidence screenshot shows the landed point; a genuinely absent target with no recorded point fails honestly as today.
- (C4) Existing suites green (982/982) + new unit tests for projection/retry/elision.

## In / out of scope

In: `server/src/manual/playback.ts` (settle loop, dispatch, post-check), run-scoped selector→rect map, prefetch of next-step selector, tests.
Out: the device daemon/alloy dispatch cost (C — separate investigation doc + benchmark, no code), app-side changes (BACKLOG #13 stands), screen-runner verbs (arrive/refresh untouched).

## Design

### D — post-check elision (lands first, trivial)

In the post-dispatch block: skip the `screenChanged` snapshot when `nextPollsSelector` is true (next step is tap/type/expect WITH a selector) — that step's own resolution IS the stronger check. The `warnReason` audit ("tap produced no screen change") is only computed when we actually snapshot; absent snapshot → no warn, `screenChanged: undefined` in evaluated_json (additive key, consumers tolerate absence — same shape as today's optional).

### A — dead-reckoning with verify-then-retry

**Run-scoped memory:** `const lastRectBySelector = new Map<string, {x,y,w,h}>()` in the run's step loop closure. Key = canonical selector JSON (`JSON.stringify(selector)` after key-sort). Written EVERY time a selector resolves (settle loop hits, expect matches, engine rescues). Never persisted cross-run (DB or otherwise).

**Two projection sources (F1 fix, review option 1):**

1. **Point-projection (the primary path, fixes the 17PM case):** a step that carries BOTH a recorded point and a selector may dispatch immediately at the recorded point — scaled per-device via the existing `coordinate-fallback-scaled` math — with the selector demoted to post-hoc audit (resolution attempted only for the record; a null resolution does NOT block the dispatch). This is the path for first-exposure targets that have never entered the AX tree this run. The template's PP step gets its recorded point restored (x:101, y:700 from git history).
2. **Rect-projection (secondary, same-run memory):** selector resolved earlier this run via the map (below). Only valid when NO scroll intervened since the resolution (F3: scroll delta is unknowable — momentum + content-size dependent; a scrolled rect is treated as invalid rather than adjusted) and no navigation action (tap/type/verb) intervened. Expects do NOT clear the map (F5: they don't move UI; the tap→expect→scroll→tap-same-screen pattern keeps working — a scroll still invalidates).

**Fast path (replaces the pre-tap AX wait):** when either projection source is valid, dispatch IMMEDIATELY. No settle poll. `resolvedBy: 'projected-point' | 'projected-rect'` in evaluated_json (new labels — auditable; union type + tap-resolution test updated, F6).

**Cross-device (operator Q3, unchanged from review):** point-projection scales through the SAME proven math as the coordinate fallback; rect-projection never crosses devices (run-scoped map implies same device). Coordinate-only steps without selectors keep the fail-honestly guard byte-identical.

**Verify, no in-step retry (F2 fix, review option a):** the fast path RELIES on the next verifying step. Within the SAME step after dispatch, if `nextPollsSelector` is FALSE (no verification follows), take the screenChanged snapshot as today — the projection is then verified by screen-change (weaker but immediate). There is NO in-step retry: a stale projection is caught by the NEXT step (its settle loop polls the real AX and fails honestly with existing reason strings + evidence showing the landed point). This matches operator decision #1 verbatim.

**Cross-device candidate rule:** projection with scaling is allowed ONLY when the map entry came from THIS run (which implies same device — cross-RUN reuse is banned by design), so scaled projection across devices cannot arise from the map. Cross-device selector-only steps keep today's behavior (resolve live or fail honestly). This closes the operator's Q3 structurally: the only geometry ever projected is same-run, same-device, scroll-adjusted.

**Where it hooks:** at the TOP of the tap/type settle section — before the settle loop, check map validity; if valid → skip loop, set tx/ty from projection, jump to dispatch with `resolvedBy='projected'`. The settle loop remains the path for cold selectors.

### B — pre-arm (opportunistic)

Prefetch polls run in the FOREGROUND loop's sleep gaps (F4 fix): at each `setTimeout` wait inside the settle/expect polling loops, if the wait is ≥120ms, issue ONE snapshot for the NEXT step's selector (serialized through the same alloy queue — no in-flight flag, no interleaving, no separate poller). Successful resolutions write the map. Cap: ≤8 prefetch snapshots per step. Best-effort: errors swallowed, never blocks or fails the run. (With F1's point-projection carrying the 17PM case, B is pure reinforcement — if implementation shows the sleep-gap hook is invasive, B may be dropped without affecting acceptance.)

### Sequencing

1. D + tests (elision case).
2. A + tests (validity rules, projected label, cold path unchanged, navigation clears map).
3. B + tests (map writes, in-flight guard).
4. Verification drills: 3× A2102153 + 3× 984FF244, record step timings; before/after table in the PR body.
5. C scoping doc (separate file, `plans/` — investigation brief for the device daemon dispatch cost: FAST_APP_GUARD re-check, XCUITest tap ceremony, benchmark protocol) — no C code.

## Edge and failure cases

- Projection taps wrong control → next verifying step fails honestly (evidence screenshot shows where we landed); run blocks with existing reason strings. Accept: operator-approved locality shift.
- Map entry stale after in-app animation → same as above; retry is the next step's settle loop (by design, see A).
- Prefetch races a foreground dispatch → in-flight flag; prefetch skips when set.
- Abort mid-projection → projection dispatch goes through the same withWatchdog; abort-aware loops unchanged.
- Selector-only step with valid projection → same fast path (tx/ty from rect center); no recorded point needed.
- Expect steps never project (they ARE the verification).

## Acceptance checks

- `pnpm run check` green; new unit tests: elision (D), point/rect projection validity + labels + scroll/navigation clearing (A), sleep-gap map writes (B).
- Drills per C1/C2 with step-duration table; evaluated_json carries resolvedBy 'projected-point'/'projected-rect' (union + tap-resolution test updated, F6); baseline run ids c1db84f7/fabfff2f cited in the PR body (F7).
- Cross-device unchanged-behavior test: the existing cross-device guard suite passes untouched.

## Rollout

Single Crucible PR on `feat/screen-state-runner` after commits 0ee0756/e88be1b/b8101bf (already local). No schema changes (evaluated_json keys additive). C brief delivered as a plans/ doc for the the device daemon repo's own workflow.
