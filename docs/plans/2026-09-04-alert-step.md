# Alert Step — `alert: accept|dismiss` — Scoped Plan

> **For Hermes:** TDD, small batches, commit per task. Live drills at the end.
> **Context:** drills `run_4fa0516e`/`run_0a5c1ddd` — Sign-Up tap raises "Sign in to
> your Apple Account" (sim has no Apple ID). Interceptor names it and fails the run;
> the case can never pass. `alert:` gives cases a declared way to clear dialogs.

## Design (pinned before tasks)

**Syntax** — scalar action, like `scroll`:

```yaml
setup:
  - alert: dismiss
steps:
  - tap: { point: [147, 649], on: Sign Up }
  - alert: dismiss
```

- Value MUST be `accept` or `dismiss` (parser error otherwise).
- No body keys, no `when:`, no `optional:` — inherently conditional (no-op skip
  when nothing is up), so both modifiers are meaningless and rejected.
  - `when:` on scalar action already errors via the keys.length===2 branch
    (message says "cannot ride on a scalar action") — extend that message to
    name `optional:` too, or generalize: any second key on a scalar action.
- Allowed in BOTH `setup:` and `steps:` (unlike `when:`, this is a legitimate
  mid-flow action — the Apple sheet appears AFTER Sign-Up, not at start).

**Playback semantics:**

- Dispatch `alloy_alert { action: accept|dismiss }`.
  - ok:true → pass (a dialog was up and was cleared).
  - ok:false "alert not found" → **skip**, reason `no alert up` (no-op).
  - ok:false other → step fails with the engine message (never masked).
- `optional: true` on alert step? Parser rejects (see above) — a failed
  dismiss-with-error is always a real failure worth surfacing.
- No sig-before/after work: an alert clear is not screen-change verified
  (the dialog dismissal is itself the observable; post-snapshot adds nothing).
- stepName: `alert accept` / `alert dismiss`.

**Interceptor rule change (the one behavioral coupling):**

- Run-start gate: if a dialog is up AND the case's FIRST step (setup or main)
  is an `alert:` step → do NOT fail the run; let that step handle it.
  - Rationale: the case declares "I clear dialogs"; failing at the gate would
    make the declared handler unreachable — the exact bug shape we just fixed
    for setup (early return past claims).
  - Simpler alternative considered: drop the gate entirely, rely on the alert
    step. REJECTED: the gate catches UNDECLARED dialogs before a single tap
    goes into the void (run_a9ccdf19's value).
- Mid-run no-change correlation: unchanged. If an undeclared dialog blocks a
    tap, the correlation still fires. A declared `alert:` step right before
    would have cleared it — the case author's job.

**Storage/routes/web:** no schema change (action rides in steps_json/
setup_json rows like every other action). Outline: kind `alert`, detail =
accept/dismiss. STEP_LABEL += alert. Completions: `alert:` skeleton offering
accept/dismiss.

## Self-review findings (verified against code, folded in)

1. **[fixes plan] `ACTIONS` set is the parser's gate** (`case-yaml.ts:44`): every
   action not in `ACTIONS` errors "unknown action" at line 145 BEFORE any
   action-specific branch. Task 1.2 must add `'alert'` there first, else the
   alert branch is unreachable. Trivial but plan-order matters.
2. **[fixes plan] runFlow `optional` inheritance orphans alert steps**: `flows.ts:22`
   spreads `optional` onto child steps, and my PlaybackStep typing means a
   child `alert` step inside a runFlow inherits fine — BUT the plan's parser
   rule "no `optional:` on alert" only guards AUTHORED yaml. Inherited
   optional on an expanded child alert is harmless (playback alert branch
   ignores `optional` — skip-on-no-alert is already the behavior). Verified
   the child spread carries `[k: string]: unknown` so no type error. No
   change needed; documented so it isn't "fixed" later.
3. **[fixes plan] yaml-slots has no 'alert-value' slot** — `detectSlot`
   (yaml-slots.ts:30-45) special-cases `scroll`→direction and `runFlow`→name.
   Alert needs the same one-line branch: `if (action === 'alert') return
   'alert-value';` plus the union member + completions list (accept/dismiss).
   The plan's Task 3.2 "reuse direction-slot pattern" is now concrete.
4. **[confirmed] serializer scalar pattern** — scroll emits `  - scroll: down`
   as a bare scalar line (case-yaml.ts:325); alert copies that shape exactly.
5. **[confirmed] step-name sites** — playback.ts:83/92 (stepName/stepLabel)
   and CaseEditorPanel STEP_LABEL:47 are the complete set of action unions in
   the web/server; `web` has no other per-action switch (outline falls back
   to raw kind).
6. **[behavioral risk accepted] gate-defer reads execSteps[0] AFTER setup
   prepend + expansion** — setup steps are prepended at line ~424, expansion
   before that; the gate sits at ~447. execSteps[0] is therefore the true
   first-executed step including runFlow expansion. Correct as planned. One
   subtlety: if setup starts with `tap` (not alert) and a dialog is up, the
   gate still fails the run — CORRECT (the tap would go into the void; the
   author should put `alert: dismiss` first if they expect a start dialog).
7. **[test debt flagged] `yaml-completions.test.ts:27`** asserts the exact
   action list — Task 3 must update it to include `alert` (same as the earlier
   `when`/`setup` updates).

## Tasks

### Task 1 — parser (`shared/src/case-yaml.ts`, tests in `server/test/case-yaml.test.ts`)

1. `YamlStep.action` union += `'alert'`; new field `alertAction?: 'accept' | 'dismiss'`.
2. In `parseStepList`: handle scalar body `'accept'`/`'dismiss'` under key
   `alert` → `{ action: 'alert', alertAction }`; any other scalar → error
   `alert needs accept or dismiss`.
3. Scalar-sibling guard: today `keys.length === 2 && keys.includes('when')`
   errors. Generalize to: second key is `when` OR `optional` → error naming
   both ("alert takes no modifiers").
4. `when:` guard (attachWhen): reject on alert action ("when only guards
   tap/type/expect (got alert)").
5. Serializer: emit `  - alert: accept` / `  - alert: dismiss` (scalar line);
   round-trip test.

### Task 2 — playback (`server/src/manual/playback.ts`, tests `server/test/playback-setup.test.ts`)

1. `PlaybackStep` action union += `'alert'`; `alertAction?: 'accept' | 'dismiss'`.
2. stepName/stepLabel: alert branches.
3. Step loop: alert action → dispatch alloy_alert accept/dismiss;
   ok:false+not-found → skip 'no alert up'; ok:true → pass; ok:false other →
   fail. NO sig tracking, no screenChanged, no watchdog change (alert dispatch
   is fast; watchdog already races every dispatch).
4. Run-start interceptor: before failing on a present dialog, check
   `execSteps[0]?.action === 'alert'` → skip the gate failure (log via
   step-0 note? no — just don't fail; the alert step itself will pass/skip).
5. Tests: dialog-up+alert-first-step → run proceeds, alert step passes; no
   dialog → alert step skips; engine error on dismiss → step fails.

### Task 3 — web + completions (`CaseEditorPanel.vue`, `shared/src/yaml-completions.ts`)

1. STEP_LABEL += `alert: 'alert'`; outline detail = accept/dismiss.
2. Completions: step-action skeleton `alert: dismiss` with detail "accept or
   dismiss a system alert"; alert-value slot offering accept/dismiss (reuse
   direction-slot pattern if yaml-slots has one; else static two-item list).

### Task 4 — drills (live, fresh install)

1. Author the privacy case with `alert: dismiss` after Sign-Up.
2. Run → expect: setup dismisses onboarding, Sign-Up tap raises sheet, alert
   step clears it, Privacy Policy tap lands, expect matches → **green run**.
3. Negative: remove the alert step → mid-run correlation names the sheet
   (already proven; one confirm run).

## Edge cases (self-review list)

| # | Case | Decision |
|---|---|---|
| 1 | `alert: Accept` (wrong case) | Error — exact match only (engine expects lowercase) |
| 2 | `alert: { action: dismiss }` (map body) | Error — scalar only, message points to `alert: dismiss` |
| 3 | alert in setup + dialog at run start | Gate defers to the step (Task 2.4); step clears it |
| 4 | alert step when engine alert tool unsupported | ok:false other → step fails honestly |
| 5 | Multiple dialogs queued (dismiss one, next appears) | Each alert step clears one; correlation catches strays |
| 6 | alert step INSIDE a runFlow child flow | Allowed — same step engine; no special-casing |
| 7 | `optional: true` on alert | Parser error (scalar-action guard) |
| 8 | Recording (manual session) an alert press | Out of scope v1 — manual session records taps; alert handling stays playback-authored |
| 9 | alert step as very first MAIN step (no setup) | Gate-defer logic reads execSteps[0] regardless of flow tag |
| 10 | Serializer ordering with mixed setup steps | alert lines emit in stored order; no grouping |

## Out of scope

- `permissions:` pre-grant block (TCC writes are broken on this Xcode anyway).
- Recording alert interactions during manual capture.
- Alert-text matching (`alert: dismiss, if: Apple`) — name-only v1.
