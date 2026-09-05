# Tier 1 from the Baguette Steal-List — Grid Sweep & Two-Source Truth

> **For Hermes:** TDD. Every task ends with full-suite green + tsc clean +
> signature scan CLEAN. Commit per task. Live drill at the end (Task 7):
> tnc re-recorded WITH sweep-recovered selectors; privacy regression must
> stay green. Decisions locked with user 2026-09-05. Source analysis:
> `docs/research/2026-09-05-baguette-steal-list.md`.

## Problem (from the week's failure taxonomy)

`alloy_snapshot` returns a tree with SwiftUI blind spots: childless
AXGroups (tab bars, nav bars) whose buttons never appear. Symptom chain:
selector miss → coordinate fallback → tap lands on layout, not control.
Post-tap verification (already shipped) catches the lie and fails honestly,
but the run still fails — honest, not successful. We want selector hits
even when the traversal lies, because a selector hit means a correct,
recentred, verified tap.

## Where it lives (verified in code, 2026-09-05)

- `server/src/manual/selector.ts` — pure selector domain: `captureSelectorAt`,
  `matchesSelector`, `countMatches`, `resolveSelector` (confirm|recentre).
  No engine dispatch there — playback injects snapshots.
- 848-line `playback.ts` calls `alloy.dispatch('alloy_snapshot', …)`
  directly at 6 call sites (settle gates, expect poll, step resolve,
  when-guard, dims read).
- Engine seam: `server/src/alloy/responses.ts` `decodeSnapshotResult`.
- Evidence recorder already captures per-expect screenshots — sweep
  evidence ride-along reuses it.
- NO point hit-test endpoint exists on the engine today (`baguette
  describe-ui --x --y` equivalent absent).

## Design decisions (locked)

1. **Sweep = fallback, never the primary path.** Trigger: selector miss
   after settle budget expiry AND hierarchy signals blindness near the
   target. Trigger predicate (pure, tested): `sweepTriggered(nodes, x, y)`
   — true when the recorded point sits inside a childless container of
   width ≥ 200pt with no labeled descendant covering the point.
   Rationale: primary-path sweeping adds dispatch cost to every step and
   masks real UI absence (a genuinely missing button would be swept into
   a hit → false pass). Fallback-only keeps failure honesty.
2. **5-point probe stencil, geometry-only.** Center + 4 quarter-points of
   the covering container's rect. ≈ one snapshot round-trip worst case.
   No screen-wide 32pt grid — that's a recording-time tool in Baguette;
   we're a playback-time fallback with a budget.
3. **Merging = match predicate, not tree graft.** We don't need tree
   surgery — we need a hit for THIS selector. Probe results pass through
   the existing `matchesSelector`; any node satisfying the selector at
   any probe point = hit. Zero new domain concepts.
4. **Budget: 1 sweep per step, inside the existing settle budget.** No
   extra wall-clock beyond the probes themselves.
5. **Reporting honesty.** `resolvedBy` gains `'selector-sweep'`; reason
   strings say "recovered by sweep" so run rows tell the story.
6. **expects get the cheap variant; when-guards get nothing.** Expect
   terminal miss ⇒ ONE probe at the expect's recorded coordinate (hit ⇒
   matched=1 "recovered by sweep"). Today's expect schema carries no x/y
   — add it at capture time (schema-additive; old cases without coords
   simply don't probe). When-guards carry no coordinates and run before
   taps: they stay tree-only. Locked.
7. **Probe-found nodes enrich the stored hierarchy snapshot** for
   triage/review — the wall shows what was actually there. Additive.
8. **Plan doc is historical.** Verdicts live in commits + tests; the
   steal-list gets "implemented: <commit>" pointer lines at the end.

## Tasks

### Task 0 — Engine surface survey (read-only, ~15min, before Task 2)

List the engine's dispatch verbs live (alloy help / runner command
registry) and record which exist: point hit-test query, coordinate-
filtered element query, `describe-ui --x --y`. Design Task 2 around the
answer. **If nothing exists:** the sweep evaluates the 5-point stencil
against the snapshot already in hand (zero extra round-trips — still
catches the tabbar case, because the walk DID return the container, just
not its children… so tree-only analysis may see nothing new — therefore
Task 2 MUST find a real point-query path or the sweep degrades to
no-op). This task decides which.

### Task 1 — Pure sweep core (`server/src/manual/sweep.ts`)

`sweepTriggered(nodes, x, y): boolean` — recorded point inside a
childless container ≥200pt wide, no labeled node covering the point.
`probePoints(rect): {x,y}[]` — center + 4 quarter-points, clamped inside.
`sweepFind(probeFn, sel, probes): Promise<SnapNode|null>` — run probes
through `probeFn` (injected), filter through `matchesSelector`, first
hit wins, all-miss ⇒ null.

Tests (`server/test/sweep.test.ts`): trigger fires on childless-tabbar
fixture; silent on healthy tree; silent when point covered by a labeled
node; stencil geometry; sweepFind first-hit-wins; all-miss ⇒ null.
TDD gate: observe red before green.

### Task 2 — Point-query dispatch (`server/src/alloy/probe.ts`)

`probeAt(udid, x, y): Promise<SnapNode[]>` built on whatever Task 0
found (dedicated verb if it exists; else the narrowest composite that
queries elements AT a point). Injectable into playback deps; tests use
fakes; one live smoke against a booted sim (tap-target readback).

### Task 3 — Wire into tap/type resolve (playback.ts)

In the settle loop's terminal-miss branch: if `sweepTriggered`, run the
5-point stencil via `sweepFind`; hit ⇒ resolve FROM THE PROBE NODE: tap its rect center, with the same
container-rejection guard (`isContainerNode`) and the distance audit
computed directly (probe nodes are NOT in the tree — `resolveSelector`
cannot see them; self-review catch). `resolvedBy='selector-sweep'`;
miss ⇒ existing coordinate fallback. Reason strings note sweep recovery.

Integration test: childless-tabbar hierarchy fixture, selector for the
tab button, fake probe returning the button at a quarter-point; assert
resolvedBy + reason + recentre audit path.

### Task 4 — Expect single-point probe

Terminal miss on expect-with-selector: if the expect carries recorded
x/y, ONE `probeAt`; matched nodes (after the same-origin collapse rule
from `countMatches` — a probe can return the double-exposed container +
StaticText pair: one visual element, not ambiguity) ⇒ matched=1, reason
notes "recovered by sweep".

Capture-side (both required, self-review catch):
- `recordExpectStep` (server/src/manual/session.ts:248) gains x/y — its
  caller (the web probe) already holds the point.
- YAML serializer: `YamlStep` has `x?/y?` but the expect emitter must
  SERIALIZE them, else playback-from-YAML silently loses coords. Parser
  side: x?/y? already tolerated on expects (STEP_KEYS).
Old cases without coords: no probe, honest miss (downlevel-safe).

### Task 5 — Hierarchy enrichment + bus stats

Probe-found nodes unioned into the `run_steps` hierarchy snapshot
(additive payload field). `sweep.stats` bus event (probes fired, hits,
latency) for the drill report and future UI surfacing.

### Task 6 — Docs

`docs/features/sweep.md` (problem, pipeline, why fallback-only, why
5-point, how it shows in run rows; pin measured probe latency). Seed
`docs/features/` by moving `docs/ci.md` under it + index. Deeper
features-doc migration is explicitly OUT of scope here.

### Task 7 — Live drill + steal-list annotations

Re-record tnc (coordinates predate cross-device honesty rules) — its
record path gets selectors via `captureSelectorAt`; anything the
recorder misses still gets the playback sweep. Drill asserts: tnc green
with sweep-recovered selectors, privacy regression green, `sweep.stats`
collected. Annotate steal-list Tier 1 entries with implemented-commits.
