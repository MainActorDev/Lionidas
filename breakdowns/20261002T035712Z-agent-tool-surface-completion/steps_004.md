# Step 4 — Prompt/instructions + docs + live Hermes drill + closeout

- **Status:** Ready
- **Plan:** rev 2, Stage S4, conditions 4–7
- **Repo:** Step 3 head · **Depends on:** Steps 1–3 gated green

## Outcome

The agent knows and uses the new surface; docs updated; a live Hermes drill exercises evidence + validate + screens; all repo gates green.

## Implementation

### 4a. system-prompt.ts additions (terse)

- **Failure triage flow:** on a failed run — `run.triage.get` (reason/timing/evidence) → `evidence.get` (inline screenshot when ≤1MB) → `case.versions` (what changed) → `flakes.list` (is it flaky?) → THEN judge and propose a fix or a selector-trust note.
- **Validate-first:** for non-trivial drafts call `case.validate` before `case.draft.save`.
- **Screens writes:** full-list rule + revision echo (the refusal messages explain; the prompt just says "registry writes need the FULL screen list and the current revision").
- **Recipes:** read `recipes.get` before drafting `ensure login/logout` steps.

### 4b. docs/agent.md — tool table gains all 14 (read tier grows: evidence/triage/versions/flakes/search/recipes; write tier: folders/duplicate/move/screens/validate).

### 4c. Instructions smoke — initialize contains: 'Failure triage', 'case.validate', 'FULL screen list', 'recipes.get'.

### 4d. THE DRILL (live, Hermes after restart; fallback this session's terminal)

Prompt: *"Show me the evidence for the most recent failed run, tell me why it failed, then validate this yaml without saving: name: Drill Check\napp: com.lionparcel.consumer\nsteps:\n  - expect screen: checkout-summary.settled\n    narrate: Given the summary settled"*

Expected: `runs.history {status:'failed'}` → `run.triage.get` + `evidence.get` (inline if screenshot exists) → judgment; `case.validate` → ok, NOTHING saved (template count pinned in the log). If no failed run exists in the live DB, create the expectation honestly in the log (skip evidence leg, note why). Second drill leg: register a screen via `screens.draft.save` full-list flow (fetch → add `drill-probe` screen → echo revision) and confirm via screens.registry.

### 4e. Closeout gates

`pnpm vitest run` full · web build · cli suite · butler clean · registry sweep (no activate/delete/play/device tool names) re-asserted in the suite · push. Update `docs/agent-drills.md` with the trace + ids.

## Completion gate

- [ ] instructions carry the new sections (smoke output pasted in drill log)
- [ ] drill completed with real ids; validate-saves-nothing pinned; screens full-list flow exercised
- [ ] docs updated; all repo gates green; pushed
