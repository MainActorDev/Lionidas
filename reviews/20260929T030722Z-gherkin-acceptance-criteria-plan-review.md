# Review — Gherkin narrate plan (20260929T030722Z)

- Reviewed: `plans/20260929T030722Z-gherkin-acceptance-criteria-plan.md` (status Ready, 2026-09-29)
- Sources: brainstorm `20260929T030722Z-gherkin-acceptance-criteria.md` incl. Decisions log; live code survey 2026-09-29 (`shared/src/case-yaml.ts`, `server/src/manual/playback.ts`, `server/src/db/schema.ts`, `server/src/routes/runs.ts`, `web/src/components/RunPanel.vue`, `server/src/alloy/runner.ts`)
- Verdict: **Ready for implementation** (after three plan edits below — all Medium, none architectural)

## Traceability

Every decision-log entry traces to plan work: per-step optional (`YamlStep.narrate`, parse guardrails), field name `narrate:` (grammar + emitter), render-at-run (Stage 2 persistence + Stage 3 RunPanel), impact survey honored (generic lift, whitelist, guarded ALTER, insStep, runs.ts SELECT *, RunPanel mapping). No extra commitments found; out-of-scope list correctly excludes the case-level block and form widget. Agent-defaults are flagged as reversible, not presented as operator decisions — correct.

## Findings

### F1 (Medium) — plan asserts a single common-tail stamp; code reality is "one loop, 18 push sites, 12+ `continue`s"

`parseStepList` (case-yaml.ts:210) is indeed ONE for-body — the plan's approach is sound — but most push sites `continue` immediately after pushing, so a "loop's common tail" after the for-body cannot see per-iteration push positions. The workable shape: capture `const stepsOutLenBefore = stepsOut.length` at loop top; stamp `narrate` on every step pushed this iteration (`for (let j = len; j < stepsOut.length; j++) stepsOut[j].narrate = …`) right before each `continue`/at iteration end. Not hard — but the plan's "one generic pass at the loop's common tail" as written would silently stamp nothing (all pushes already happened and continues skipped the tail).

**Correction:** Stage 1.2 rewrite — "stamp-at-iteration-end using length-captured-before push (handles all 18 sites incl. `continue` paths)". Verify: round-trip matrix must cover `setup:` section steps too (parseStepList is shared by setup+steps — plan only names "steps"; setup narrates must also round-trip).

### F2 (Medium) — no warnings channel exists in parseCaseYaml; the Gherkin soft check has nowhere to go

`parseCaseYaml` returns `{ ok, case, errors, runFlowNames }` — errors only (case-yaml.ts:91). The plan's "existing warnings channel" (Stage 1.3) does not exist. Options: (a) extend the parse result with `warnings: YamlError[]` (additive; callers ignore today) — cleanest; (b) demote to a prefix marker in errors with ok:true semantics — hacky, violates the error contract. Recommend (a).

**Correction:** Stage 1.3 — add `warnings?: YamlError[]` to the parse result (additive, defaulted) and emit the non-Gherkin notice there. Verify: server test asserts warnings present with ok:true for a prose narrate; UI save path does not block on warnings.

### F3 (Medium) — THIRD run_steps INSERT site the plan missed: `server/src/alloy/runner.ts:262,291`

The impact survey (and plan Stage 2.2) names only `insStep` (playback.ts:537). There are two more fixed-11-column INSERTs in the alloy runner (its own step rows — probe/recording lanes). If untouched: those inserts still succeed (column nullable, named-column INSERT ignores missing col) — **no breakage**, but narrate would be NULL on alloy-lane rows; that is acceptable if intended, or thread it if those lanes carry yaml steps. Confirm which lanes runner.ts serves (probe-only? recording playback?). Named-column INSERT means no crash either way — finding is about intent, not correctness.

**Correction:** Stage 2 gains one line: "alloy/runner.ts:262,291 INSERTs stay untouched — their lanes don't carry case yaml steps; narrate NULL is correct there (named-column inserts unaffected by the new column)." Verify: suite green (the INSERTs prove unaffected); if a future lane needs narrate, thread it then.

### F4 (Low) — byte-identical emit claim needs a real snapshot baseline

"absent → byte-identical yaml to today" is the right invariant, but must be tested against CURRENT emitter output captured before the change (the round-trip suite re-parses, which would mask a formatting-only regression). The plan says "snapshot the current emitter output first" — good — this finding just makes it an explicit acceptance artifact: store fixtures of pre-change emitted yaml for the full action-kind matrix, assert equality post-change.

### F5 (Low) — `Row extends PlanStep` mapping: narrate must be optional in the UI type

RunPanel.vue:20 `interface Row extends PlanStep` + :76-83 fetch mapping — adding `narrate` to PlanStep (shared) or Row (local) must be optional (`narrate?: string | null`), and the SSE handler (:135 `step.started`) must not assume presence (old-server events during rolling restart). Trivial, but worth a line in Stage 3.

## Human questions

None blocking. The three agent-defaults flagged in the plan (warn-only, single-line, yaml-only editor) stand as reasonable; veto anytime.

## Required plan edits (all Medium/Low, non-architectural)

1. Stage 1.2: stamp-at-iteration-end mechanism (F1); round-trip covers setup-section steps too.
2. Stage 1.3: introduce `warnings` in the parse result — channel does not exist today (F2).
3. Stage 2: one-line note on alloy/runner.ts INSERT sites — untouched by design (F3).
4. Stage 1.1/acceptance: pre-change emitter snapshots as explicit fixtures (F4); Stage 3: optional narrate in Row/PlanStep types + SSE null-tolerance (F5).

## Inspected on paper vs. requires execution

Paper: grammar threading feasibility (loop shape verified in source), persistence surfaces (3 INSERT sites found), event plumbing, render mapping, migration safety (guarded-ALTER precedent :237-246). Requires execution: emitter byte-parity across all action kinds, SSE live render, drill on device, full-suite regression.
