# AX-Depth Spike — verify + consume the deeper accessibility tree

> **For Hermes:** time-boxed spike, decision-gated by NUMERIC criteria (P3).
> Produces evidence + executable corpus + a DEFERRED.md entry. Phases 0–2 run
> against the baguette CLI / serve mode directly and can start pre-wrap; only
> the adopt-wiring assumes the simdeck proxy. Naming: engine name used like
> sibling plans; defer to the simdeck naming decision at wrap time.

**Goal:** Prove, against Crucible's live selector-failure corpus, that the
deeper accessibility tree already produced by the wrapped engine's
`describe_ui` (recursive walk + 32pt hit-test grid merge, richer attributes)
fixes the "selector says not found, eyes say it's there" class at the root —
and decide, by numbers, how Crucible's selector layer should consume it.
Second goal (P2.5, decoupled): fix the inspector's wrong padding/gap
readings via geometric re-parenting — evaluated on BOTH today's tree and the
engine tree, shippable independently of the AX-depth decision.

**Architecture:** No new device-facing code. The private-framework seam
(`AccessibilityPlatformTranslation` / AXPTranslator + token dispatcher) is
consumed once, by the wrapped engine. This spike measures what its tree adds
over `alloy_snapshot`, stresses the selector predicates against it, and gates
a schema/matching decision. Crucible's stencil sweep (`sweep.ts`) stays as
tier 3 for the engine's residual blindness.

**Tech Stack:** baguette CLI (`describe-ui`) for coverage, baguette serve
(WS) for steady-state latency, existing `matchesSelector` / `countMatches` /
`resolveSelector` / `sweep.ts` / `inspect-geometry.ts`, vitest, JSON fixtures.

---

## Correction this plan owns (supersedes the chat framing)

The original idea — "build private-AX introspection in Crucible as a fallback
tier under the grid sweep" — picked the wrong seam. The walk's blindness isn't
fixable from the consumer side; it's fixed *inside* the engine by merging the
positional hit-test into the tree (baguette's `describe_ui` already does
exactly this, including cross-process items: status bar, tab-bar buttons).
Rebuilding an AXP dispatcher in Crucible would recreate the exact device-facing
surface the simdeck wrap deletes. The spike therefore verifies and consumes,
it does not duplicate.

## What it will solve (mapped to the live failure taxonomy)

| Taxonomy member (steal-list) | Mechanism | Confidence |
|---|---|---|
| Invisible-but-visible AX elements (childless SwiftUI tab bars / nav bars / toolbars) | grid-merge grafts hit-test survivors into the tree — `resolveSelector` sees them natively instead of via stencil | high |
| Status-bar elements unresolvable (walk is app-scoped) | grid sweep crosses processes | high |
| Ambiguity nulls (`pool.length !== 1` → coordinate fallback) | `role` / `traits` / `value` in matching = finer discrimination than label+type | medium |
| Existence-count fidelity (same-origin collapse heuristic, `countMatches`) | role-aware collapse replaces the geometric heuristic | medium |
| "Label not found" on visibly-present labels (ic_tabbar_account_inactive class) | covered by row 1 | high |
| **Inspector padding/gap wrong inside a visible container** (P2.5) | geometric re-parenting — works on TODAY's tree too | high |

## What it will NOT solve

- **Design values of padding/spacing.** SwiftUI `.padding()`/`spacing:` are
  layout facts that never enter any AX tree (public or private). The
  inspector measures geometry; it cannot read the developer's intent.
  Runtime truth would need the DYLD-injection probe — already decided
  out of scope (Figma-parity plan, Tier 3).
- **Snapshot staleness** — the tree is still poll-based; no change
  notifications (engine known limit). Callers keep re-issuing per gesture.
- **AXP group-child drops** (`role=group` containers occasionally lose
  children; idb#767) — structural, upstream of us. Stencil sweep stays as
  tier 3 for exactly this.
- MJPEG/stream weight, evidence-without-tap-context — different tiers.

## Verified facts this plan is built on (2026-09-13)

1. **Stencil sweep already shipped** — `server/src/manual/sweep.ts`: 5-point
   stencil, triggers only when the recorded point sits inside a childless
   ≥200pt container with no labeled cover; `probeFn` injected; wired at
   `playback.ts:816`. Narrower than the engine's 32pt full-screen grid.
2. **Selector surface is thin** — `selector.ts`: `matchesSelector` keys on
   `identifier` / `label(Contains)` / `type` only; `AxNode` (`shared/src/ax-tree.ts:8`)
   carries no `role`, `traits`, or `value`. `countMatches` collapses
   same-origin matches geometrically. `resolveSelector` returns null on any
   ambiguity.
3. **Engine tree is deeper and richer** — `describe_ui` returns labels,
   frames (device points, letterbox-corrected), identifiers, role, traits,
   value; `--x --y` variant = point hit-test. Merge pipeline in their
   `ax-hit-test-sweep.md`.
4. **⚠ Engine tree is NESTED; SnapNode[] is FLAT.** `describe_ui` returns
   `{ tree: { …, children: [] } }` (their accessibility.md example). Our
   predicates consume a flat array with `index`/`parentIndex`. A factory
   (flatten + index synthesis) is therefore REQUIRED CODE, not a footnote —
   and grafted grid-sweep nodes arrive WITHOUT lineage.
5. **⚠ No `hittable` documented in engine output.** `SnapNode.hittable` gates
   `resolveSelector`'s pool and `sweepTriggered`. The factory needs an
   explicit derivation rule (candidate: default true except known
   non-interactive roles; to be settled from P1 fixtures). Unsettled rule =
   P2 results are garbage-in.
6. **⚠ CLI pays XPC warm-up on EVERY invocation** (their known limit: warm-up
   is per-process; CLI exits per call). Steady-state latency is only
   measurable against long-lived `baguette serve` (WS describe_ui). Coverage
   via CLI; latency via serve.
7. **Engine known limits**: snapshot-only; frontmost-app only (SpringBoard
   idle → null); group-child drops (idb#767); NSNumber values stringify.
8. **alloy_snapshot survives the wrap** — simdeck retire-list (its fact #6)
   covers the stream/input stack only; the alloy dispatch stays. So
   post-wrap, consuming engine depth = NEW server-side client (serve/WS or
   subprocess), not the iframe surface.
9. **App-session heal exists (b83f322, 2026-09-13)** — alloy app sessions go
   stale under churn (reboot/relaunch/engine recycle) and snapshots fail
   `No active session`; `dispatchWithAppHeal` (session.ts) re-opens the
   recorded `manual_sessions.app_bundle_id` once and retries. P0 corpus
   capture MUST route through it (or record bundle id + re-open manually) —
   a stale-session snapshot is an environment failure, NOT a corpus case;
   never record one as "selector miss".
10. **Signature scan** matches five historical engine-name patterns (see
   `scripts/scan-signatures.mjs` — never write them out, not even in docs;
   this plan tripped the scan by listing them) — the current engine's name
   passes today.

---

## Phases

### P0 — Failure corpus + RED baseline (pre-wrap-safe)

Capture the failures this spike must move, as MACHINE-CHECKABLE evidence:

1. Reproduce ≥3 live cases: (a) tab-bar childless-container miss, (b)
   visible-label "not found", (c) ambiguity-null (live template preferred;
   if none in current run logs, a synthetic-but-verified case built from a
   captured real tree is acceptable — mark it as such).
2. Per case, commit to `server/test/fixtures/ax-depth/<case>/`:
   `tree-alloy.json` (alloy_snapshot output), `case.json` (selector,
   recorded point, expected outcome, one-line repro, app build + screen
   route, sim OS + Xcode version), `screenshot.png` (gitignored if large —
   path recorded in case.json). Trees are TEXT and small: they go IN the
   repo so the corpus is re-runnable in CI.
3. **RED baseline lock (negative control, must fail):** a vitest corpus test
   feeds each `tree-alloy.json` through the predicates and ASSERTS today's
   failure (resolve null / count wrong / sweep fires). A case that passes
   today = corpus error, not a spike win. Corpus proven before P1 spends
   anything.
3. Exit: corpus committed, RED test red for the right reasons.

**P0 RESULT (2026-09-13, executed live — supersedes two assumptions):**
- Case A captured on BOTH apps (lp-home-statusbar, foodiary-home): zero
  status-bar items, zero battery/wifi/clock labels — machine-verified.
- Case B captured on foodiary-home, and it is NOT the predicted
  double-exposure: it is **SwiftUI label PROPAGATION** — the day header's
  label rides up to its full-screen ancestors (Other/ScrollView at
  402×874), giving 4 hittable matches → `resolveSelector` null → coordinate
  fallback; `countMatches`=3 also undercounts (origin-collapse misses the
  container/text pair at different origins). Taxonomy row updated.
- The steal-list's childless-SwiftUI-tabbar disease is NOT present on
  today's screens (Foodiary's SwiftUI TabBar exposes real buttons+ids; LP
  home uses a UIKit TabBar). Corpus honesty: recorded as healthy, not
  forced into a case.
- Tests: `server/test/ax-depth-corpus.test.ts` (4 passing — they ASSERT
  today's failures, so a fix landing flips them red = the negative
  control working). Live re-capture script: `scripts/ax-depth-p0-check.ts`.
  Screenshots gitignored (large), kept on disk for P2.5 ground truth.
- Gate collateral (disclosed): 3 pre-existing failures from b83f322/f957154
  fixed in passing (unused import, 2× TS2532/2345 non-null assertions in
  inspect-sample.ts + inspect-route.test.ts). Full suite 617/617 green.

### P1 — Coverage diff (pre-wrap-safe, engine CLI + serve)

Same screens, same sims, engine's tree instead:

1. `baguette describe-ui --udid <UDID>` per corpus screen; `--x --y` at the
   recorded failure points. Capture raw engine JSON per case as
   `tree-engine.json` fixtures (in repo).
2. **Honest failure recording:** if describe_ui errors or returns null tree
   on a screen (e.g. Springboard idle), the case is marked
   `engine-unreachable` with the error — never silently dropped.
3. Diff per screen: node count with label/identifier, tab-bar children
   present, status-bar items present, failing selector now ≥1 match, and
   exactly-1 (resolvable) vs >1 (STILL ambiguous — note: more nodes can make
   ambiguity WORSE; count-stability is a first-class column, see P2.4).
4. Latency via **serve mode** (long-lived process, warm XPC): script takes
   N=20 describe_ui calls + N=20 alloy_snapshot calls, reports p50/p95.
   CLI latency is reported separately labeled `cold (incl. warm-up)` — never
   mixed into steady-state numbers.
4. Latency via **serve mode** (long-lived process, warm XPC): script takes
   N=20 describe_ui calls + N=20 alloy_snapshot calls, reports p50/p95.
   CLI latency is reported separately labeled `cold (incl. warm-up)` — never
   mixed into steady-state numbers. *(Deferred: CLI cold numbers below
   already cover the on-demand use case; serve-mode p50/p95 recorded when a
   polling decision actually depends on it.)*
5. Exit: coverage table (with count-stability column) + latency table in
   `docs/research/2026-09-13-ax-depth-coverage.md`; engine fixtures committed.

**P1 RESULT (2026-09-13, executed live):** coverage table + asymmetries in
the research note; engine fixtures committed next to the alloy trees.
Headlines: case B fully resolved (1 match, no propagation); Foodiary
status bar = 6 real items; **LP status bar + tab buttons NOT in the engine
full tree** (childless `AXGroup`, flat depth-1 walk) — point hit-test
rescues the buttons (`AXRadioButton "Akun"`); status-bar asymmetry needs
one fork-side check (content-leaf swallowing sweep points — hypothesis,
unverified). CLI latency 0.45–0.76s cold incl. warm-up. Gate math:
2/3 corpus resolved on full tree → adopt threshold met provisionally;
hit-test seam covers the LP gap (that's `sweep.ts`'s shape). Drill
lesson: terminate-then-launch before capture.

### P2 — Predicate stress (pure functions, no device)

Does the richer tree break or improve the selector layer? All via ONE new
pure factory consumed by tests:

1. **Factory as a deliverable, not test glue** —
   `engineTreeToSnapNodes(json): SnapNode[]` in `shared/src/` (or server test
   utils if it must not ship): flatten nested `children`, synthesize stable
   `index`/`parentIndex` (documented order rule), map `role` → `type` via an
   explicit table (vocabulary must COVER existing selector `type` values —
   unmappable role = factory throws, never silently drops), derive
   `hittable` per the rule settled from P1 fixtures. Unit-tested on its own:
   - golden-file test per corpus fixture (fields survive, counts stable)
   - **determinism test**: same JSON twice → identical arrays (merge order
     must not wander)
   - **schema guard**: unknown engine fields don't crash; missing optional
     fields → undefined, never 0/''.
2. Feed factory output through `matchesSelector` / `countMatches` /
   `resolveSelector` / `sweepTriggered` per corpus case. GREEN target:
   resolve returns the recorded intent on engine tree.
3. **Negative controls (must hold):**
   - `sweepTriggered === false` on healthy merged trees (labeled cover
     exists) — stencil must NOT fire when the tree sees.
   - `isContainerNode` still rejects screen-sized nodes on the richer tree.
4. **Count-regression axis:** for each corpus selector, countMatches on
   alloy tree vs engine tree. New visibility (status bar, grafted children)
   can CHANGE counts of existing existence assertions — a regression here
   is a finding, not noise; it shapes the adopt decision as much as fixes do.
5. Exit: green/red table per predicate per case + minimal schema delta
   (`role?`, `traits?`, `value?` on AxNode — optional fields only,
   wire-backwards-compatible) + matching-tier sketch: identifier →
   label+type → label+role. *(Schema delta and tiering move to the adopt
   plan — P2's evidence: current predicates already consume the engine
   tree via role→type mapping; new fields are additive, not required.)*

**P2 RESULT (2026-09-13, executed on committed fixtures):**
- Factory: `server/test/utils/engine-tree.ts` — DFS flatten, explicit
  role→type table (8 roles observed; unmappable THROWS), hittable :=
  !hidden && enabled (optimistic convention, divergence from alloy
  measured not hidden). 4 contract tests: golden shape, determinism,
  throw-on-unmappable, schema guard.
- Corpus × predicates: **case B fully green** — MINGGU count 3→1,
  resolve null→the real 13pt-high StaticText. **Case A (foodiary)
  green** — battery item count 0→1, resolve returns y<60 item.
- **Count-regression axis, MEASURED and bounded:** LP tab buttons
  alloy=1 / engine=0 (childless AXGroup) — asserted in the test as a
  documented regression; hit-test seam covers it (P1 asymmetry #3).
- Negative controls HOLD: sweepTriggered quiet on both engine trees at
  8 sample points; isContainerNode rejects screen-sized engine nodes in
  recentre mode.
- Verdict feeding P3: predicates consume the engine tree correctly via
  the factory; the fixes are real and the one regression is named,
  bounded, and covered by an existing seam. 9+4 corpus tests green;
  full suite 626/626; typecheck+lint clean.

### P2.5 — Inspector spacing re-parent (decoupled; ships on its own evidence)

User-reported: inspector can't figure out padding between elements visibly
in the same container. Root cause is lineage trust, not tree depth:

- `paddingToParent` (`shared/src/inspect-geometry.ts:8`) measures to the AX
  parent's rect. SwiftUI layout containers (VStack/HStack carrying the
  actual `.padding()`/`spacing:`) often expose NO AX element, or a wrapper
  `Other` whose rect is the union of children (padding reads ≈0).
- `siblingGaps` / `siblingsOf` (ax-tree.ts:116) require same `parentIndex`.
  Extra `Other` wrapper on one element → "not siblings" → `—`.

Fix: **geometric re-parenting** as experimental pure functions alongside the
existing ones (production wiring gated separately — see below):
`enclosureParent(nodes, n)` = smallest node whose rect strictly encloses n's;
`enclosureSiblings(nodes, n)` = axis-aligned neighbors within the same
enclosure cluster. Lineage demoted to tie-breaker.

Testability requirements:
1. **Ground truth with tolerance:** hand-measure expected padding/gap from
   lossless screenshots at known scale (px/pt from case metadata); acceptance
   = within ±2pt. Measurement procedure + values recorded per case in
   `case.json` (which edge pairs, which screenshots).
2. **Evaluated on BOTH trees:** pass rate of old (lineage) vs new
   (enclosure) on `tree-alloy.json` AND `tree-engine.json`, reported as a
   2×2. If the fix works on today's tree, it SHIPS INDEPENDENTLY of P3 —
   do not couple an unconditional win to the AX-depth decision.
3. **Property tests (invariants, corpus-independent):** gaps never negative
   (overlap = excluded, matching siblingGaps contract); no enclosing rect →
   null (honesty, never 0); determinism; overlapping cards (carousel case)
   stay NON-siblings — the geometric model must not fuse genuinely separate
   layers.
4. Deliverable: functions + tests + the 2×2 pass-rate table appended here.

### P3 — Decision gate (numeric, written down, then stop)

| Gate | Adopt | Partial | Reject |
|---|---|---|---|
| Corpus cases uniquely resolved on engine tree | ≥ 2/3 | 1/3–2/3 with wiring cost high | 0 |
| Count regressions (P2.4) | none unexplained | bounded + documented | any silent one |
| Stencil negative control | holds | holds | — |

- **Adopt**: extend `AxNode` (optional fields), tier the match predicate,
  keep stencil tier 3; files a normal implementation plan (server-side
  engine-tree client per fact #8) + DEFERRED entry.
- **Partial**: depth arrives via wrap surfaces only; no selector-layer
  schema change; stencil stays; corpus parked in DEFERRED as future evidence.
- **Reject**: corpus unmoved → failures are NOT walk-blindness →
  re-classify the taxonomy. Record why, honestly.

P2.5 ships iff its own 2×2 shows improvement with invariants green —
independent of the row above. DEFERRED.md updated either way (skill rule).

**P3 VERDICT (2026-09-13): ADOPT.** All three gate rows green, receipts:

| Gate | Threshold | Measured |
|---|---|---|
| Corpus uniquely resolved on engine tree | ≥2/3 | **2/3** (B: MINGGU 1-match resolve; A: Foodiary battery 0→1, y<60; miss: LP status bar — engine-side, hit-test n/a for cross-process) |
| Count regressions | bounded + documented | **LP tab buttons alloy 1 → engine 0** — asserted in `ax-depth-engine.test.ts`, covered by the hit-test seam (sweep.ts shape) |
| Stencil negative control | holds | **holds** (8 sample points × both engine trees, quiet) |

Scope of ADOPT (what the follow-up implementation plan must cover —
nothing wired by the spike itself):
1. Server-side engine-tree client (fact #8: serve/WS or subprocess — NOT
   the iframe surface; alloy_snapshot seam stays for now).
2. Factory graduates from `server/test/utils/` to `@crucible/shared`
   (exports-map edit is a REQUIRED step — lesson (i)); role→type table
   becomes shared constant.
3. Selector layer consumes engine tree as PRIMARY source for resolution
   + counting, alloy tree remains fallback; no schema change REQUIRED
   (P2 proved role→type mapping suffices; `role?` stays additive-optional).
4. Playback wiring behind the existing dispatch seam; corpus tests flip
   from RED (asserting failure) to GREEN (asserting the fix) at wiring
   time — that flip IS the negative-control receipt.
5. Fork-side check (P1 asymmetry #1): why LP loses status bar + tab
   buttons in the engine full tree — fix lands in the fork (skill rule),
   not worked around here.

Open item NOT adopted by this verdict: P2.5 (inspector re-parent) —
still pending its own evidence run (2×2 on both trees + property tests);
it ships independently per the rule above.

DEFERRED.md: entry added (AX-depth adoption — evidence committed, wiring
plan pending user gate).

---

## Exit criteria / deliverables

| Deliverable | Where | Machine-checkable? |
|---|---|---|
| Failure corpus + RED baseline test | `server/test/fixtures/ax-depth/` + vitest | ✅ asserts today's failures (P0 done) |
| Engine trees + factory + golden/determinism tests | `shared/src/` (or test utils) + fixtures | ✅ |
| Coverage + latency tables | `docs/research/2026-09-13-ax-depth-coverage.md` | script output |
| Predicate green/red + count-regression table | appended here | ✅ vitest corpus |
| Re-parent functions + 2×2 + property tests | `shared/src/inspect-geometry.ts` (experimental) | ✅ |
| Decision (adopt/partial/reject) + DEFERRED entry | `DEFERRED.md` | ✅ numeric gate (P3: ADOPT, 2026-09-13) |

Time-box: P0–P2 one working session each max. If P1 shows the corpus already
resolves, jump straight to P2→P3 with the good news.

## Risks

- **More nodes can hurt** (count regressions, worse ambiguity) — measured as
  a first-class column (P1.3, P2.4), not discovered post-adopt.
- **Factory is load-bearing** — flatten/index/hittable/role-mapping errors
  poison every downstream conclusion; hence golden + determinism + throw-on-
  unmappable tests BEFORE any predicate run.
- **Wrap timing**: if simdeck lands mid-spike, P1's CLI/serve path is
  replaced by the proxied wire — same JSON shape, findings transfer
  (fact #8).
- **Xcode 26 AXP drift**: capture sim OS + Xcode version per case (P0.2);
  anything odd in P1, re-check against the engine's own ax-inspector before
  blaming the tree.
- **Corpus rot**: LP app screens change; case.json carries app build +
  screen route so a future re-run can find the same state.
- **CI weight**: corpus tests are pure JSON → negligible; full vitest suite
  already needs `--maxWorkers=2` (memory) — corpus adds no device I/O.
