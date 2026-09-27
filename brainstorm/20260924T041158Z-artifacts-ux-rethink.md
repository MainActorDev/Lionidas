# Rethinking the artifacts collection UI/UX

- Source prompt: "I think we need to rethink the artifacts collection UI/UX design"
- Created: 2026-09-24T04:11:58Z
- Status: Questions open (scope narrowing — see 2026-09-24 follow-up)

## Goal and context

The evidence/artifacts UX grew by accretion and the swap-run feature just broke
its last load-bearing assumption. The user wants a rethink of how collected
artifacts (screenshots, videos, traffic) are presented — not a patch on the
current grouping.

Direct user signals this session (the trigger chain):

1. "All the artifacts only updated under the 'sg' variant section" — the
   evidence sheet filed a swap run's three worlds under one lane.
2. "The screenshot should have shown those three variants" — expected the
   evidence to *prove each world*, as stills.
3. Now: rethink the collection UI/UX as a whole.

Interpretation (not confirmed): the rethink should cover the whole artifacts
surface family, not only the lane-grouping bug — the bug is a symptom of a
model mismatch that will keep producing wrong-feeling UI.

## Confirmed inputs and decisions

Verified facts about the current surfaces (code, 2026-09-24):

- **Four distinct surfaces own artifacts today:**
  1. `RunDetailPage.vue` (398 lines) — run-level evidence strip (video +
     screenshot cards, every verdict; added this session), inline step
     thumbnails in the steps log (added this session), network log, raw block.
  2. `TriagePanel.vue` (109) — failed-step bundle only: reason + step evidence
     + run evidence (video/logs/network). Invisible for passing runs.
  3. `EvidenceSheet.vue` (237) — per-case gallery on TestCasesPage, grouped by
     **variant lanes** (latest finished run per `runs.variant_id`), filter
     pills, cinema mode with `TapOverlayVideo` (tap-overlay video player).
  4. `InspectOverlay.vue` — devtools-style node inspection (record-time).
- **Data model:** `evidence` rows keyed by `bundle_id` (= run id), `type`
  (screenshot/video/logs/network/diff); steps carry `evidence_ids_json`;
  world attribution exists only via `evaluated_json.swapTarget` on the step
  row (added this session, `e567b48`) — not on the evidence row itself.
- **Swap runs break the lane model:** one run enters via one variant
  (`runs.variant_id = 'sg'`) but captures N worlds. Current mitigation: `↹ my`
  badges on crossover shots inside the entry lane.
- **Weight:** a 25s drill run produces a 44MB video + 3 screenshots (~230KB
  each). Video dwarfs everything; screenshots are cheap.
- **Capture points:** per-expect screenshots, per-expect-screen screenshots
  (this session), zero-expect fallback frame, whole-run video. No frames for
  arrive/refresh/swap steps; no traffic→frame correlation.

## Exploration

### The underlying problem

Artifacts are currently **gallery-shaped** (bins by lane) but the domain is
**timeline-shaped** (one run = ordered steps, world transitions, traffic
events, frames at moments). Every mismatch the user hit this session traces to
that: worlds misfiled into lanes, passing runs with no triage surface, per-step
thumbs bolted onto a log line, video as an opaque 44MB blob disconnected from
the steps it spans.

### Options

**A. Timeline-first run evidence (unify around the run)**
Run detail becomes THE evidence surface: one vertical timeline where step rows,
world spans (colored segments showing which world was active), captured frames,
and matched traffic rows interleave in time order. Video scrubs in sync when
opened (cinema mode already exists as a player). EvidenceSheet stays as the
cross-run *coverage* view but reads the same item model.
- Fits: QA triage AND pass verification — "what did the app show when step 4
  ran" is answered in place, per world.
- Cost: biggest build; needs evidence rows to carry (step idx, world, ts)
  natively — a data-model change, not just UI.

**B. World-first gallery (fix the grouping axis)**
Keep the surfaces; reorganize EvidenceSheet around **worlds** instead of
lanes: each world a section (sg / my / empty / plain), frames grouped under the
world they prove, regardless of which run/lane captured them. Lane delete
becomes world-scoped purging.
- Fits: the immediate pain, cheapest honest fix; matches how the user *talked*
  about the evidence ("screenshot should show those three variants").
- Cost: doesn't fix run-detail fragmentation or the video blob; still
  gallery-shaped for a timeline-shaped domain.

**C. Item-model unification only (no layout rethink yet)**
Make every artifact item carry full provenance natively — `evidence` rows gain
`step_idx`, `world`, `captured_at`; all four surfaces render from one typed
stream. Layout stays as-is today, but every future UI (A or B) becomes a pure
view.
- Fits: if the user suspects the *layout* will change again (Android, web-app
  runs later), this is the durable substrate first.
- Cost: migration of existing rows (nullable columns, guarded ALTERs); no
  visible win by itself.

### Proposed direction (not accepted — for discussion)

**C then B, with A as the destination.** Concretely: first give evidence rows
native provenance (C — small, honest, unblocks everything; the current
`swapTarget`-via-step-join is already straining), then regroup the gallery by
world (B — directly answers what the user expected to see). Defer the full
timeline (A) until there's a second case type exercising it — one drill case
isn't enough pressure to justify the run-detail rebuild, and the timeline
idea should be sketched against real usage first (Crucible UI convention:
concept + sketches before code).

Challenge to the premise worth stating: part of the pain is that **video is
doing a job screenshots should do**. The user watched the video to learn the
refresh mechanism (navigate-away-and-back). If each world/step transition
captured a labeled frame, most "what happened" questions answer without
scrubbing 44MB. Making stills primary and video the deep-dive might remove
more pain than any grouping change.

### Edge cases to keep in view

- Runs that fail before any step (gate aborts) — fallback frame exists; a
  timeline must still render something honest.
- Pre-rename history: old lanes (`my`/`empty` standalone runs) coexisting with
  swap runs in one gallery; regrouping must not lie about old data.
- Retention: video weight × run frequency; purge UX (lane delete today) must
  map to whatever grouping wins.
- Multi-device later: provenance should include device, not just run.

## Open questions

1. **Primary audience for the first rework:** failure triage (QA debugging) or
   pass verification (proof/coverage)? This decides whether run detail or the
   case gallery gets the rework budget first.
2. **Video's role:** keep whole-run video as a first-class artifact (and pay
   retention), or demote to opt-in/deep-dive with stills as primary evidence?
3. **Scope of this rework:** UI-only regrouping (fast), or include the
   evidence-row provenance migration (C) now that only a handful of runs exist
   to migrate?

## Follow-up (2026-09-24, narrows the problem)

User prompt: "The concern is regarding the new test case run behavior. Because,
right now the 'sg' variant showing three screenshots and one video. Meanwhile
the other cases is only the screenshot is correct. So if it only one video, we
need to rethink the layout"

**Confirmed facts (live, run_f30a0ed0 + gallery):**
- The swap run's lane shows **3 screenshots + 1 video** in one flat row.
- Old per-lane runs show **1 screenshot + 1 video** each — a consistent
  1:1 rhythm the eye learns.
- The mixed row breaks the layout's rhythm: a 44MB whole-run video card sits
  as an equal peer of three per-world stills that each prove a different
  fact. One card answers "what happened overall"; three answer "what did each
  world show". Same grid, different jobs.

**The real asymmetry (analysis):** video is RUN-scoped; screenshots are
STEP/WORLD-scoped. The flat card row flattens two scopes into one grid —
that's the layout smell, not just "too many cards". When the swap case makes
step-scoped evidence multiply (3, 5, 9 worlds...), the run-scoped card
dilutes the gallery further.

**Layout options (not accepted — for discussion):**

- **B1. Two-tier lane:** screenshots row first (the proof), video as a full-
  width strip BELOW the shots (the chronology) — run-scoped media visually
  subordinated, world badges carry the reading. Cheapest; fixes the rhythm.
- **B2. Video demoted to the lane header:** a "▶ whole run" affordance on the
  grp-head line (next to "passed · 3 shots"), not a card in the row. Row
  becomes screenshots-only — uniform 1:1 rhythm per world. Cinema still
  plays it.
- **B3. Hybrid scope grouping:** cards grouped in mini-clusters per world
  (sg[1] my[1] empty[1]) with a single video cluster — visually encodes the
  scope difference. Most structure, most code.

Recommendation (proposal): **B2** — the video card was always redundant in the
row (it duplicates the run the lane already represents; its stamp even says
"whole run"), and per-world stills are the actual product of a swap case. B1
is the fallback if the video deserves more presence.

This narrows Open question 2 toward "video = deep-dive affordance, not a
gallery card" but does NOT settle it — B1 vs B2 is exactly that question
expressed as layout.

**Sketch review correction (2026-09-24, user):** the first sketch round
faithfully rendered the CURRENT grouping — a swap run filed entirely under
its entry lane ("sg" showing my/empty shots with ↹ badges). The user's
reaction ("why does sg show other variants' screenshots?") shows the badge
mitigation does not fix the mental model: **a lane labeled sg must not
display other worlds.** Corrected sketch semantics:

- A swap run renders as its OWN lane labeled "swap run" with the world
  sequence in the meta line (`sg → my → empty · run_id · time`), distinct
  from single-world lanes.
- Each screenshot's PRIMARY stamp is its world (sg / my / empty), not
  "expect" — the card answers "which reality is this frame proving".
- Single-world lanes (legacy per-lane runs) keep their variant id as the
  lane label and as the stamp.

This reframes the layout question: it is not "where does the video card go"
but "what is a lane when a run spans worlds". The lane axis becomes RUN
TYPE (single-world vs swap), and world identity moves to the card. B1/B2
video placement still applies within the swap lane.

## Next step

Answer the three questions → pick the slice (likely C+B) → sketch the world-
grouped gallery and (if chosen) the timeline concept before any code, per the
Crucible UI convention.
