# Review — login recipe as steps plan (20260930T044550Z)

- Reviewed: `plans/20260930T044550Z-login-recipe-as-steps-plan.md` (status Ready, 2026-09-30)
- Sources: brainstorm `20260930T044550Z-login-recipe-as-steps.md` + Decisions log; live code survey 2026-09-30 (playback.ts ensure-login walk :1231-1487 incl. resilientFill closure and sessionVia; main step loop :656+; case-yaml exports; app-screens validators; PR #11 state)
- Verdict: **Needs revision** (2026-09-30) → **plan rev 2 applies F1-F6; Ready for implementation** (operator: "apply the six edits. then proceed in the same branch (feat/logout-recipe-registry)")

## Traceability

Decisions 1–3 trace directly (steps-form; per-app env names; doc-only panel). Decisions 4–6 are flagged agent-derived in the plan itself — correct handling. No extra commitments found. Acceptance checks cover every decision including the OTP synthetic and both live preflight paths.

## Findings

### F1 (High) — the plan says "reuse the fill primitives" but the codebase has TWO different fill behaviors, and the plan silently picks one

Verified in source:
- `resilientFill` (playback.ts:1415+) — the login walk's fill: retry + **mask-parity dots verification** (counts typed dots to prove the fill landed on secure fields). Closure over runId/alloy/watchdog.
- The main step loop's `type` (:930-960) — plain `alloy_act fill` dispatch, NO dots verification, NO retry.

The plan's Stage 3 says the step player "reuses the same primitives (…the resilient-fill dots-verification…)" but a recipe `type` step played through plain step machinery would LOSE the verification that today's login fill has — the exact live bug class (custom/secure fields confirming falsely) the dots check was built for. Conversely, always-on dots checking is wrong for plain-text fields (no mask).

**Correction:** Stage 3 must specify the unification explicitly: extract `resilientFill(x, y, text, {verifyMask: 'auto'})` as a shared helper — mask-parity check only when the fill came back unconfirmed AND the field masks (probe or attempt-and-check), retry once otherwise; the recipe step player AND the case `type` path both route through it. Acceptance: a test where the engine reports fill-not-confirmed on a masked field → retry fires → pass; plain field → no dots path.

### F2 (Medium) — PR #11 dependency is OPEN, and the plan defers the base question to build time

Verified: PR #11 state OPEN (mergedAt null, 2026-09-30). The plan builds on #11's `app_login`-canonical state + yaml-carry. Options: base the branch on #11's branch (stacked PR), or wait for merge. The plan says "ask operator" at build time — that's fine, but the PLAN should record the two concrete options so the choice is one word at build time, not a re-derivation.

**Correction:** Branch section lists both options explicitly (stack on `feat/logout-recipe-registry`, or start after merge).

### F3 (Medium) — validator reuse: `parseStepList` is NOT exported; the plan's "reuse the case parser" needs an exact seam

Verified: case-yaml.ts exports `parseCaseYaml` (whole-document) but `parseStepList` is module-private (:216). `validateAppLogin` needs step-LIST validation on a fragment. Options: (a) export a `parseStepsFragment(steps: unknown[]): { steps; errors }` wrapper from case-yaml; (b) validate by synthesizing a full case doc (`name: x\nsteps: <yaml>`) and parsing — hacky, error-prefix noise. Recommend (a).

**Correction:** Stage 1 names the new export `parseStepsFragment` (or equivalent) in shared/case-yaml.ts, unit-tested, and the validator consumes it; recipe step errors carry step-indexed prefixes.

### F4 (Low) — `verify.via` survives in the walk but the new recipe shape's validator section doesn't mention it

Verified: `sessionVia` (:1250, :1343) taps a control before state polling (state lives on another screen). The plan's recipe yaml shows `verify: {screen, state}` only. If the validator drops `via`, the int-dev recipe's future edits lose a working capability; if it keeps it, the shape must document it.

**Correction:** Stage 1 validator: `verify` allows optional `via` (same rules as today); plan's recipe example updated.

### F5 (Low) — panel validation UX: plan's Stage 4 wavers between client validation and save-then-show-errors

The parenthetical explores both and lands on "save-then-show-errors" — acceptable (single validator source, no duplication), but state it as the decision and note the doc textarea gets no live squiggles this round (doc parity with LogoutFlowPanel, which is fine).

### F6 (Low) — migration env-name derivation: "first case that references it" is underdetermined for multi-case apps

The int-dev app has TWO cases with identical refs today, so it works here; but the rule "first case" makes migration output depend on row order for other apps. Cheap fix: prefer the MOST-COMMON ref across referencing cases, fall back to first, then placeholder.

## Human questions

None blocking — all findings have mechanical corrections.

## Required plan edits

1. Stage 3: explicit fill unification (shared `resilientFill` helper; mask-aware verification; both callers route through it) + the masked-field retry test (F1).
2. Branch section: both dependency options stated (F2).
3. Stage 1: `parseStepsFragment` export named as the seam (F3).
4. Stage 1 + recipe example: `verify.via` optional, kept (F4).
5. Stage 4: decide save-then-show-errors, note no live doc squiggles (F5).
6. Stage 5 migration: most-common-ref rule (F6).

## Inspected on paper vs. requires execution

Paper: both existing fill paths enumerated from source; walk structure and sessionVia; parser export surface; validator rules; PR states; migration input data (the 2 cases' refs verified identical). Requires execution: the unified fill behavior under a faking engine, recipe playback end-to-end, migration on the live DB, live drill on device.
