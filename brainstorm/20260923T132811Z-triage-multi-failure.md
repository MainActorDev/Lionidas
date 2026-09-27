# Triage Section — Multi-Failure UX

- Source prompt: "what if the triage showing 2 failing test cases? how the UI would look like? I think the triage section need to be brainstormed further"
- Created: 2026-09-23T13:28:11Z
- Status: Closed — withdrawn by user ("ignore it. I was under the impression I was viewing a 'suite detail' turn out runner detail is a test case run detail", 2026-09-23). The multi-failure question was based on misreading the page's scope; `/runs/:id` is a single case's run. No action taken; artifact kept for the record.

## Goal and context

Today TriagePanel shows one failed-step picker row (`✕ flow-name` buttons) and one bundle card for whichever step was clicked. The user is asking what happens with **multiple failures** and wants the section's UX thought through properly rather than accreted.

**Interpretation (not user-confirmed):** "2 failing test cases" likely means 2 failed *steps/flows within this run* (the panel's current model — a run is one case). The panel should make comparing/acting on multiple failures natural.

## Confirmed inputs and decisions (verified 2026-09-23)

- **Zero multi-failure runs exist in the DB**: 118 runs with exactly 1 failed step, 250 with 0. Never 2+. The playback engine aborts remaining steps after a failure — multiple failures per run are structurally rare *today* (only rerun-fragment paths could produce them).
- TriagePanel model: `failedSteps` (status `fail`/`error`) → click loads `/api/runs/:id/steps/:idx/triage` bundle (step + evidence + run evidence + repro context). Single-bundle display, no selection state beyond the fetch, no per-failure isolation.
- Step statuses in DB: `pass`/`fail`/`skip` (short forms).
- Evidence avg 0.0/run historically; the failing drill run carries 1 screenshot + 1 video (16MB).
- The panel duplicates context the page now shows better: ticket/artifact/launch-args meta rows repeat the `raw` disclosure; re-run fragment + copy cmd are the unique actions.

## Exploration

### The real problem (evidence)

With 2+ failures the current UI breaks quietly: the picker row grows buttons, clicking swaps the card's content with no visual anchoring of *which* failure you're reading, the reason text and thumbnails jump around, and re-run/rerunId state (a single ref) points at whichever step was last clicked — cross-step contamination. And since multi-failure never occurs in the data, this is design for a state that exists structurally but not yet empirically.

### Option A — One card per failure (stacked) ✅ PROPOSED

Render every failed step as its **own** card, all visible, no picker: `✕ <flow> · <duration>` header, reason log-block, thumbnails, actions. Zero clicks to see everything; each failure's actions are isolated by construction (own rerunId, own copy state).

- **Wins:** no selection state to get wrong; comparison is side-by-side; degrades to today's single case exactly.
- **Costs:** 2+ cards of vertical height; evidence thumbnails ×N (capped 220px, so bounded).

### Option B — Tabs per failure

Picker buttons become tabs; card shows the active failure.

- **Rejected:** tab = hidden content; with only 2-3 failures ever, hiding is pure loss. Also keeps the single-ref state contamination problem unless rebuilt.

### Option C — Merge into the steps log (failed rows expand inline)

Drop the separate section; the steps disclosure's failed rows become expandable (reason + evidence nested under the row).

- **Attractive but premature:** couples triage to the steps grid and loses the "what needs my attention" framing; bigger rewrite of both components.

### Shared moves (any option)

- De-duplicate context: ticket/artifact/launch-args rows drop (page's `raw` owns them); card keeps only step-scoped content + actions.
- `re-run fragment` + `copy cmd` stay per-failure; rerun result link stays scoped.
- Panel only renders when failures exist (unchanged).

## Open questions

1. **Confirm the model:** is "2 failing test cases" (a) 2 failed flows within one run — Option A's assumption, or (b) 2 failed *cases* in a batch, which is not this page's concern (runs log / overview own that)? This changes whether anything ships now.
2. **Ship now or park?** Given 0 multi-failure runs exist, Option A can ship as cheap future-proofing (it also simplifies the single case), or wait until the engine actually produces multi-failures. My recommendation: ship A — it's simpler than the current picker even for one failure.

## Next step

Answer the two questions → plan → sketches if the visual shape is contested (A is mostly structural, sketches optional) → implement.
