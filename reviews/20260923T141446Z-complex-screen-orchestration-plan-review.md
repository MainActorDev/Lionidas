# Review — Complex-Screen Orchestration Plan (R2)

- Plan reviewed: `plans/20260923T141446Z-complex-screen-orchestration-plan.md` (2026-09-23, Status: Ready)
- Evidence: `server/src/forge/state.ts` + `proxy.ts` (read 2026-09-23 — singleton forge state, single `activeRunId`, `activateScenario` replaces the whole preset set); `playback.ts` comment confirming parallel batches on two devices exist; brainstorm artifact + decisions; presets schema (match modes exact/glob/regex).
- **Verdict: Needs revision** — one High (S5 depends on run-scoped preset activation that does not exist), two Mediums, two Lows. All correctable in plan text; F1 additionally adds one enforcement task to S5.

## Traceability

All six decision-log items trace to stages and acceptance checks. Stage ordering is sound (surface → sets → registry → schema → verbs → proof). The seq-exists correction (D4) was verified independently and is accurate.

## Findings

### F1 — HIGH · S5 assumes run-scoped preset activation; forge is a singleton

- **Location:** S5 `world:` verb; edge case "Concurrent runs sharing one proxy … verify in tests."
- **Evidence:** `forge/state.ts` — one `activeRunId: string | null`, `activateScenario(presetRows)` **replaces** the active preset set globally; all writers serialize through one promise chain, but there is exactly one active set. Concurrent runs are real today (`playback.ts`: "parallel batches on two devices" in the pruning guard). The plan's parenthetical "preset activation already keyed by activeRunId" is false — attribution is run-keyed, *activation is not*.
- **Consequence:** Two concurrent scenario-carrying runs already clobber each other's presets today (pre-existing); S5's mid-run swaps make it worse — swaps interleave, guard 1 observes the wrong run's traffic, both runs fail flaky. The plan's core mechanism silently assumes infrastructure that isn't there.
- **Correction (applied):** Plan now states the truth and adds enforcement: **scenario-carrying runs (activation today, `world:` swaps in S5) hold the forge preset state exclusively** — starting one while another is active fails fast 409 `FORGE_IN_USE` (and the T7 pre-flight checks it). Per-run preset selection (header/device-keyed matching) recorded as the future scale-out, explicitly not in scope. Restore semantics defined: post-run restore returns to pre-run state regardless of swaps.
- **Verify:** test — second scenario run during an active one 409s; swap sequence restores pre-run presets.

### F2 — MEDIUM · S2 conflict detection is underspecified (glob/regex overlap undecidable)

- **Location:** S2 "match-rule conflicts across the union rejected."
- **Evidence:** Presets match by exact/glob/regex; general overlap between two regex/glob patterns is undecidable. As written, a correct implementation is impossible and any implementation will invent semantics.
- **Correction (applied):** Conflict = duplicate `(method, path_pattern)` pair across the union (decidable, catches the real case — two scenarios shipping the same endpoint). Glob/regex *shadowing* (one pattern plausibly containing another) is a save-time warning listing the pair, not an error.
- **Verify:** tests for duplicate-reject + shadow-warn cases.

### F3 — MEDIUM · Guard 1's observation mechanism unnamed

- **Location:** S5 guard 1 ("the proxy must observe ≥1 request…").
- **Evidence:** Traffic rows already carry `run_id` + preset id (`logTraffic`), so verification is implementable, but the plan doesn't say how the step learns a request landed.
- **Correction (applied):** Mechanism named: world-step polls the traffic table (in-process DB query keyed by run + preset-id set) on a short interval within the budget; the polling helper is injectable for tests. No new proxy API needed.
- **Verify:** guard tests use the injectable poller (observing / not-observing).

### F4 — LOW · Guard 3's implementation borrows tapsmith's specifics

- **Evidence:** "reuse tapsmith's 12% edge exclusion" describes *their* code. Ours: screenshot via existing `alloy_screenshot` + pixel scan excluding top/bottom 12% bands; all-near-black → `DISPLAY_DEAD`.
- **Correction (applied):** seam named concretely.

### F5 — LOW · Guard 2's default (8) is derived from an analogy, not measurement

- **Evidence:** "~60 halved for safety" is a guess imported from a different app.
- **Correction (applied):** stays 8 as a *starting default*, explicitly labeled provisional, per-case configurable, and S6's drill logs swap counts so the default can be tuned from our own data.

## What was inspected vs. execution-required

Inspected on paper: decision traceability, stage ordering, forge state concurrency (the F1 source), seq/guards existence (D4 re-verified), lift-equivalence strategy, snapshot-determinism design, acceptance coverage per stage. Requires execution: everything in S1–S6 acceptance (notably guard pass/fail tests, lift equivalence, the live drill).
