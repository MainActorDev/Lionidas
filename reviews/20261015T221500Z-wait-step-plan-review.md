# Review — Wait Step Implementation Plan

- Plan reviewed: `plans/20261015T221500Z-wait-step-plan.md` (READY), against brainstorm 20261015T220500Z and the live code seams
- Evidence: `shared/src/case-yaml.ts` (ACTIONS set, step interface, serializer), `server/src/manual/playback.ts` (step dispatch + labels), `server/src/manual/engine-input.ts` (timing/abort patterns), sess_c556d7c0-918 (the splash evidence)
- Review date: 2026-10-15
- Verdict: **Needs revision** — 1 High, 3 Medium; all plan-text corrections, no open user decisions.

## Coverage

Both locked decisions trace: "both forms" → grammar § and executor §; 10s default → grammar. The honest-failure and proceed-immediately properties are testable and staged. What was checked on paper: grammar fits the existing ACTIONS/serializer shapes; probe reuse matches how expect/expectScreen resolve; abort-chunking matches engine-input precedent. What needs execution: the live drill, obviously, and poll-cadence behavior under load.

## Findings

### R1 — HIGH: the plan's grammar collides with the YAML flow-mapping style already used

- Location: Grammar §
- Evidence: existing steps use `key: value` and inline maps (`tap: { on: x }`, `expect: { on: "Save" }`, `expect screen: a.b`). The plan's `wait: { until: screen: splash.dismissed, timeout: 10s }` is a NESTED inline map (`until:` whose value is itself `screen: splash.dismissed`) — YAML parses that as `{until: {screen: 'splash.dismissed'}, timeout: '10s'}`, fine, BUT the shorthand `wait: { until: home_login_bar_login_button }` makes `until` ambiguous between identifier-string and nested-map — exactly the ambiguity class the case-yaml parser resolves today with explicit `on:`/`text:` keys.
- Consequence: parser bugs and validator confusion; round-trip drift between the two condition spellings.
- Correction: disambiguate by shape rule: `until:` value is EITHER a bare string (identifier-or-label at runtime — matches `on:` precedent) OR a map with EXACTLY ONE of `text:` / `screen:` (`screen:` value uses `a.b` dotted form, NOT nested `screen: splash.dismissed` inside until). So: `wait: { until: "Get Started" }` (bare = text-or-identifier), `wait: { until: text: "Get Started" }` (explicit text), `wait: { until: screen: splash.dismissed }` — and the plan drops the doubly-nested example. Document: bare string tries identifier first, then label (same resolution order as `on:`).
- Verify fix: grammar tests cover all three spellings + the dropped nested form is INVALID.

### R2 — MEDIUM: "condition-wait first without launch is refused" conflicts with runFlow/child-case reuse and `arrive:` ordering

- Location: Validation §
- Evidence: the plan refuses a condition-wait as the FIRST step when no arrive/launch setup exists — but a runFlow CHILD case may legitimately begin with a wait (the parent already launched), and setup blocks can contain `ensure login` which launches. The rule as written can false-refuse legitimate compositions.
- Consequence: validator blocks valid cases; users add pointless `wait: 0ms` workarounds.
- Correction: weaken to a WARNING, not a refusal (validation messages already have severity precedent), and scope it: warn only when the wait is the first step of the OUTER case AND no setup block exists. runFlow children never warn.
- Verify fix: validation tests cover outer-warn, child-nowarn, setup-present-nowarn.

### R3 — MEDIUM: missing timeout semantics for the TIME form + missing duration BOUNDS

- Location: Grammar § / Engine §
- Evidence: the time form has no cap. A typo (`wait: 1s` intended, `wait: 1h` typed — or `wait: 999999999`) stalls a run for hours while holding a device. Also `timeout:` on condition form lacks a stated max.
- Consequence: one fat-fingered case wedges a simulator for a shift.
- Correction: bounds — time-form sleep max 60s (reject beyond with the limit quoted); condition timeout max 120s. Both overridable later via per-app settings if a real case appears; defaults documented in the grammar section.
- Verify fix: grammar tests assert the bounds errors.

### R4 — LOW: evidence field plan says {form,target,timeoutMs,elapsedMs,outcome} but steps table columns aren't named

- Location: Engine § evidence
- Evidence: existing step evidence columns are (from playback) status/error + narrate; arbitrary JSON fields need a documented home — likely the existing detail/narrate path or a new json column decision.
- Consequence: implementer invents storage at the last minute (schema drift class).
- Correction: plan states: wait details ride the EXISTING step result text + a compact JSON blob appended to the step's log line (`wait {"mode":"until","target":"splash.dismissed","timeoutMs":10000,"elapsedMs":5231,"outcome":"met"}`) — no schema change this pass.
- Verify fix: executor test asserts the log line shape.

## Questions for the human

None blocking.

## Necessary edits

1. R1: until-value shape rule (bare string | one-key map text:/screen: dotted); drop doubly-nested example; document bare = identifier-then-label
2. R2: first-step rule downgraded to warning, scoped to outer-case-without-setup; children exempt
3. R3: bounds — time ≤60s, timeout ≤120s, errors quote limits
4. R4: evidence = step log line + compact JSON, no schema change

## Remains for implementation

Poll cadence under load; live drill timing; round-trip fidelity of `for:`/`timeout:`.
