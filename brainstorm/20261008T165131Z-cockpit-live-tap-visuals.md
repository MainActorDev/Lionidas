# Live interaction visuals in the cockpit (tap/typing overlay)

- Source prompt: "When a testcase running, I want to see what the system
  interact with in the app. There was a visual overlay before that shows a
  button tapped and so on. And it also shows in the evidence. But I want to
  also brainstorm what kind of visual that I could choose. Use the sketches"
- Created: 2026-10-08T16:51:31Z
- Status: Direction selected — visual language via sketches (030, pick one)

## Goal and context

During a LIVE run in the cockpit, the operator watches the device stream but
cannot see WHERE the system is tapping/typing — that visual exists only in
(1) the runs-page RunPanel (fading circles, `step.tap` WS events) and
(2) recorded evidence videos (TapOverlayVideo + persisted `run_taps`).
The user wants the same (or better) overlay ON the cockpit's live stage —
and explicitly wants to CHOOSE the visual language from sketch variants.

## Confirmed inputs and decisions

- Verified facts (code read 2026-10-08):
  - `step.tap` WS event exists: `{runId, idx, x, y, logicalW, logicalH}`
    (server/src/ws/bus.ts:11) — fired by playback dispatch; typing lands at
    a spot too (playback.ts:1724 comment).
  - `step.started`/`step.finished` carry `flow`, `name`, `narrate` — enough
    for a LABEL per interaction, not just a dot.
  - Shared overlay math exists: `@crucible/shared/tap-overlay`
    (`overlayAt`, fade 1400ms) — reused by evidence player.
  - RunPanel already draws fading circles on live canvas (runs page).
  - Cockpit stage = StageBezel canvas; WS events already flow to the page.
  - Evidence side already works (docs/features/tap-overlay.md, Tier 2.2).
- User decision: visual language to be chosen from SKETCHES (this round).

## Exploration

The mechanical part is settled (WS `step.tap` → draw on stage canvas,
reuse `overlayAt` timing). The OPEN question is purely visual language.
Three candidates, each sketchable in isolation (a phone frame + a scripted
tap sequence on loop):

- **A — Ripple (current family)**: expanding circle + fade from the tap
  point. Matches evidence + RunPanel today = one language everywhere.
  Subtle; may be too quiet for "what is it doing RIGHT NOW" at a glance.
- **B — Crosshair + step label**: precise crosshair with the step name/
  narrate beside it (e.g. "tap · account_legal_privacy_row"). Maximum
  information; busier screen; labels need truncation rules.
- **C — Trace path**: connected numbered dots showing the interaction
  history of the current run (1→2→3, older fading). Tells the STORY of the
  flow, not just the instant; dots accumulate — long runs need a horizon
  (e.g. keep last 5).

Combinations are viable (B+C: labeled crosshair + fading trace).

## Sketches

`sketches/030-tap-visuals/` — a.html (ripple), b.html (crosshair+label),
c.html (trace path). Each is a self-contained phone-frame with a scripted
4-step tap sequence looping, Axiom tokens, so the language can be judged
in motion.

## Open questions

1. Which visual (A/B/C or a combo)? — answered by picking a sketch.
2. Should the cockpit also record taps for ITS evidence? (No work: same
   playback path persists run_taps regardless of which surface watched.)

## Next step

Pick the sketch → plan (small: WS wiring + chosen visual on StageBezel)
→ implement → live drill (run a case in cockpit, watch taps appear).
