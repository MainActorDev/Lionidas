# Assertions Implementation Plan — A7 (batch 3): expect-exists steps

> **For Hermes:** implement task-by-task with build/test verification between each. Human gate before Task 1.

**Goal:** convert templates from a replayer into a test suite — steps can carry
EXPECTATIONS ("after this tap, element `label:"Login"` must exist"), replayed as
existence checks that fail red when the app changed. Closes DEFERRED B12 (the
"weak green runs" conceptual flaw) and the discipline gap identified in the
2026-08-31 QA-workflow review: a test = action + expectation; today every
Crucible step is action-only, so a tap into the void passes green.

**Design in one paragraph:** reuse A6's selector machinery end-to-end. An
`expect` step is a step whose only payload is a selector (no coordinates
needed at replay — the check is resolution itself). Capture rides the
existing pre-action snapshot: when QA is recording and pauses on a screen,
"assert screen contains…" reads from the SAME live snapshot that selector
capture uses, so the assertion vocabulary is identical to what playback can
resolve. Playback runs expect steps AFTER the preceding action settles: it
takes a snapshot, resolves the selector, and pass/fail is simply
resolved-or-not — `resolveSelector`'s unique-match semantics already give us
"fail when gone OR ambiguous". `optional: true` degrades an expect to a soft
assertion (miss records skip, run stays green) exactly like A3.

**Non-goals (this batch):** value/text-equality assertions, image-diff
assertions, screenshot-baseline comparison (existing evidence remains), waits
beyond the existing settle semantics. Existence is the 80% case for UI smoke
("did we land on the right screen") — the rest waits for real demand.

**Tech:** TypeScript, better-sqlite3, vitest, Vue 3. No schema migration
(expect steps live inside `steps_json`), no new dependencies.

**Verified integration points (live code, this session):**
- `server/src/manual/playback.ts:179-214` — the exec loop: per-step substituteStep →
  selector resolve → dispatch → insStep with `resolvedBy` audit. Expect steps
  slot in as a new branch in `stepName` + the dispatch `if/else` chain.
- `server/src/manual/selector.ts` — `resolveSelector(nodes, selector)` returns
  `{x, y}` on UNIQUE match else null. That null is our fail signal; no changes needed.
- `server/src/manual/flows.ts` — `FlowStep` is structurally open
  (`[k: string]: unknown`); runFlow flattening passes unknown actions through
  verbatim (only `action === 'runFlow'` is intercepted) — expect steps in
  subflows need zero flows.ts changes. VERIFIED by reading the loop.
- `server/src/manual/template-env.ts` — `substituteStep` builds an explicit
  base; must add `expect` to its action union + pass `selector` through
  (same pattern as the batch-2 self-review catch).
- `server/src/routes/templates.ts` PATCH steps validation — copies steps
  verbatim (batch 2 verified); confirm no action whitelist blocks `expect`.
- `web/src/pages/TemplatesPage.vue:96-112` — `patchTemplate`,
  `parameterize`, `toggleOptional` patterns to copy for the add-assertion UI.
- `web/src/components/DeviceSidebar.vue` recorder — steps UI + the snapshot
  API the sidebar already calls for app state.
- LP AX audit (skill): labels cover 75–92% of hittable nodes — `label` is the
  assertion vocabulary; identifiers only for icon asserts.

**Semantics decisions (settled):**
1. `expect` never dispatches anything. It only observes.
2. Expect failure is a HARD fail by default (that's the point); `optional`
   makes it soft (skip + green) for "dismiss-if-shown" style guards.
3. Failure detail MUST name the selector and say why: `not found` vs
   `ambiguous (N matches)` — parseable by QA without opening code.
4. `resolvedBy`-style audit: expect steps record `{"expect": selector,
   "matched": N}` in evaluated_json — the run detail shows what was checked.
5. Record-time capture is post-action by default (assert what the screen
   shows after the last step); a pre-action assert equals just adding it
   before the action in the step list. No special ordering machinery.

---

### Task 1: expect-step playback (TDD, server)

**Objective:** replay an `expect` step: resolve selector against live
hierarchy → pass / fail(with reason) / optional-skip; never dispatch.

**Files:**
- Modify: `server/src/manual/playback.ts` (PlaybackStep union, stepName, loop branch)
- Modify: `server/src/manual/template-env.ts` (action union + selector passthrough)
- Test: `server/test/playback-expect.test.ts` (create)

**Step 1 — failing tests** (fake alloy dispatch + in-memory db, mirroring
`test/playback.test.ts` harness):

```ts
const nodes = (labels: string[]): SnapNode[] => labels.map((label, i) => ({
  index: i, type: 'StaticText', label, rect: { x: 0, y: 0, width: 10, height: 10 },
  hittable: true, ref: `n${i}`, parentIndex: -1,
}));

it('expect: unique label match → pass', async () => {
  // steps: [{ idx: 0, action: 'expect', selector: { label: 'Login', type: 'StaticText' } }]
  // fake snapshot returns nodes(['Home', 'Login']) → step pass, evaluated: { expect: {...}, matched: 1 }
});
it('expect: absent label → hard fail with named selector', async () => {
  // nodes(['Home']) → run failed, step fail, reason contains "expect" + "not found" + the label
});
it('expect: ambiguous (2 matches) → hard fail "ambiguous (2)"', async () => { /* nodes(['Login','Login']) */ });
it('expect optional: miss → skip, run stays green', async () => { /* optional: true */ });
it('expect never dispatches alloy_act', async () => {
  // fake alloy throws on any 'alloy_act' dispatch → run must still pass
});
it('expect in subflow flattens and runs with flow provenance', async () => {
  // parent runFlow → child expect step carries flow name in run_steps
});
```

**Step 2:** FAIL (no expect branch). **Step 3: implement** — in the exec loop,
after the selector-resolution block, before dispatch:

```ts
if (s.action === 'expect') {
  const snap = (await alloy.dispatch('alloy_snapshot', { udid, interactiveOnly: false }, deps.dispatchDeps)) as
    | { ok: true; result: { nodes?: SnapNode[] } } | { ok: false };
  const nodesL = snap.ok ? snap.result.nodes ?? [] : [];
  const matches = nodesL.filter(matchSelector(nodesL, s.selector)).length; // matchSelector exported from selector.ts
  if (matches === 1) {
    insStep.run(runId, s.idx, s.flow ?? t.name, stepName(s), 'pass', null, t0, Date.now() - t0, '[]',
      JSON.stringify({ ...resolved, expect: s.selector, matched: matches }));
  } else {
    const reason = matches === 0 ? `not found: ${JSON.stringify(s.selector)}` : `ambiguous (${matches} matches): ${JSON.stringify(s.selector)}`;
    if (s.optional) { insStep.run(runId, s.idx, s.flow ?? t.name, stepName(s), 'skip', `optional expect miss: ${reason}`, t0, Date.now() - t0, '[]', JSON.stringify({ ...resolved, expect: s.selector, matched: matches })); continue; }
    runStatus = 'failed';
    insStep.run(runId, s.idx, s.flow ?? t.name, stepName(s), 'fail', reason, t0, Date.now() - t0, '[]', JSON.stringify({ ...resolved, expect: s.selector, matched: matches }));
    // remaining steps skipped (existing pattern)
  }
  continue;
}
```

Prereq: export a `countMatches(nodes, selector): number` from `selector.ts`
— share the MATCH PREDICATE with `resolveSelector` (the identifier/label/type
filter), but do NOT reuse its pool policy: resolveSelector prefers hittable
nodes because it taps; an existence assertion counts ALL matching nodes
(asserting non-hittable StaticText content is legitimate). Concretely:
extract `matchesSelector(n, sel): boolean` + `countMatches = nodes.filter(...).length`;
resolveSelector keeps its hittable-pool fallback internally. Two pool
policies, one predicate — that's the drift-safe split (B8 precedent).
`stepName`:
`if (s.action === 'expect') return 'expect ' + (s.selector?.label ?? s.selector?.identifier ?? '?')`.

**Verify:** `pnpm vitest run test/playback-expect.test.ts` 6/6; full suite + typecheck green.
**Commit:** `playback: expect steps — existence assertions via selector resolve (A7)`.

---

### Task 2: routes accept expect steps (validation parity)

**Objective:** PATCH/POST steps arrays containing `expect` persist; no
whitelist silently strips them; from-session path unaffected (recorder never
emits expect — that's the sidebar's add-step, Task 4).

**Files:** Modify `server/src/routes/templates.ts` (only if a validation
whitelist exists — grep first; batch-2 read showed verbatim copy).

**Verify:** round-trip test: create template with an expect step via POST →
GET returns it byte-identical; PATCH steps preserves expect entries.
**Commit:** `routes: expect steps round-trip (validation parity)`.

---

### Task 3: capture — "assert screen contains" in the recorder sidebar

**Objective:** while recording (or editing a saved template), QA can add an
expectation sourced from the LIVE hierarchy: type/pick a label → the sidebar
shows "1 match · will assert" vs "0 matches · cannot assert" before saving.

**Files:**
- Modify: `web/src/components/DeviceSidebar.vue` (recorder block: "+ assertion" control)
- Modify: `server/src/routes/manual.ts` (tiny helper route: `POST /api/manual/:id/probe-selector` → runs snapshot + countMatches → `{ matched, sampleRect }` — reuses Task 1's countMatches server-side, zero client-side hierarchy logic)

**UX (matching Axiom conventions, plain English):**
- Button `+ assert screen contains…` in the recorder footer.
- Input with datalist of current screen's hittable labels (from a fresh
  snapshot the route returns alongside matched count).
- Live feedback line: `✓ 1 match — assertion will check for this` /
  `✕ 0 matches — nothing to assert yet` / `? N>1 matches — ambiguous, pick another`.
- Save appends `{ idx: next, action: 'expect', selector: { label, type } }`
  via the existing recording_json append path (new action type tolerated by
  recordStep's Step union — add the variant).

**Verify:** live on booted sim with LP app: add assertion on "Login" → 1
match; on garbage → 0 matches feedback; template steps show the expect row.
**Commit:** `recorder: assert-screen-contains capture with live match feedback (A7)`.

---

### Task 4: templates page — expect steps visible + editable

**Objective:** the suite page shows expectations as first-class steps; QA can
toggle optional, delete, and add an expect step to an EXISTING template
without re-recording (the maintenance path — most assertions get added
retroactively after a first failure).

**Files:**
- Modify: `web/src/pages/TemplatesPage.vue` (`Step` union + `stepLabel` expect
  branch + `addExpectation(t)` via `patchTemplate` + ⚓-style chip showing the
  asserted selector)

**stepLabel:** `expect "Login"` · chip `⚓ label:Login` (title: full selector JSON).
`addExpectation`: `window.prompt('assert screen contains (label):')` → PATCH appends
`{ idx: steps.length, action: 'expect', selector: { label } }` (type optional).
Toggle-optional checkbox already exists — expect steps inherit it (soft assert).

**Verify:** `npx vue-tsc --noEmit` clean; Vite transform 200; manual add +
delete + optional-toggle on a live template.
**Commit:** `ui/templates: expect steps — add/list/optional (A7)`.

---

### Task 5: run detail — assertion verdicts rendered

**Objective:** failed expects render as first-class failures; evaluated_json
`expect` field shown as `↳ expect label:Login · matched 1` (or `matched 0`).

**Files:**
- Modify: `web/src/pages/RunDetailPage.vue` (`evaluatedText` expect branch;
  failure reason already renders via the existing reason column).

**Verify:** replay the Task-3 template with a deliberately broken assertion
(label patched to garbage) → run detail shows red step with
`not found: {"label":"…"}`; fix the label → green with `matched: 1`.
**Commit:** `ui/runs: expect verdicts in run detail (A7)`.

---

### Task 6: live verification round (both pages, real device)

1. **Green path:** record LP login-ish flow → add assertion "Login" post-tap
   via Task 3 UI → save → play → run green, expect step `matched 1`.
2. **Red path (the money test):** replay after the app moved (or patch the
   label to garbage) → run RED at the expect step, reason `not found`, later
   steps skipped — the replayer is now a tester.
3. **Ambiguous path:** assert a label that appears twice → RED `ambiguous (2)`.
4. **Soft path:** same as 2 with `optional: true` → skip, run green.
5. **Subflow:** child template containing an expect, played via parent
   runFlow → flow provenance in run_steps, same verdicts.
6. **Cross-device:** play the asserted template on the SE sim → selector
   resolution (A6) makes the assertion device-independent by construction —
   verify green there too.
7. Cleanup: delete verification templates/sessions.

---

### Task 7: docs + DEFERRED close-out

- DEFERRED.md: B12 entry removed (built — expect steps shipped), fixed-list
  gains "weak green runs — B12, via A7 expect steps". Note remaining
  assertion families NOT built (value equality, image diff) as rejected-for-now
  with trigger "first real demand".
- crucible skill: batch-3 section (semantics table: hard-fail default,
  optional=soft, matched-count audit, ambiguity=fail) + reference file
  `references/assertions-expect-steps.md` with the live-verification matrix.
- Commit: `docs: A7 assertions shipped — B12 closed`.

---

## Self-review (executed at draft time — findings folded in)

- [x] **Executed each planned test against its own fixture data** (batch-2
  lesson (a)): nodes(['Login','Login']) really is ambiguous under
  resolveSelector's unique-match rule; nodes(['Home']) + expect Login is the
  true not-found case; the "never dispatches" test uses a throwing fake —
  all six assertions match the implementation as written.
- [x] **Both ends of every data-flow link** (lesson (b)): run detail renders
  from `SELECT *` (evaluated_json free); templates PATCH copies steps
  verbatim (no whitelist to fight — Task 2 is a confirmation, may be a no-op
  commit); flows.ts passes unknown actions through (verified by reading the
  loop — only runFlow intercepted).
- [x] **Factual claims re-checked against live code** (lesson (c)):
  substituteStep builds an explicit base → expect's selector needs an
  explicit type addition (the exact batch-2 miss); PlaybackStep dispatch
  chain is if/else on action — a new branch is additive; insStep call shape
  verified against playback.ts:195.
- [x] Match logic shares the PREDICATE with resolveSelector but keeps a
  separate pool policy (count all matches vs hittable-preferring) — verified
  against live selector.ts: resolveSelector's pool fallback would silently
  under-count non-hittable text; existence assertions must not inherit that.
- [x] Backward compat: templates without expect steps replay byte-identically
  (expect branch is `continue`-guarded, never entered).
- [x] Honest failure vocabulary: not-found vs ambiguous are distinct,
  selectable strings — QA can act differently on each.
- [x] Record-time UX teaches itself (network-page rule): match-count
  feedback BEFORE save prevents "asserted the wrong thing" authoring bugs.
- [x] No coordinates recorded for expect steps — device-independence by
  construction (no scaling branch needed in the expect path).

## Risks / open questions

- **Timing/settle:** expect runs immediately after the previous action's
  settle; a slow screen transition could false-red. Mitigation: existing
  `settle: true` on actions + ONE retry after 750ms in the expect branch
  (cheap, bounded — NOT a general wait framework; note in code).
- **Label volatility:** SwiftUI list rows reuse labels → ambiguous on some
  screens; that's an honest red ("pick a better selector"), matching the A6
  audit. Type narrowing (label+type) already supported in the selector shape.
- **Text-equality assertions deliberately deferred** — existence covers
  smoke/regression landing checks; equality needs text extraction from
  snapshot nodes (exists in `label` already) but the authoring UX is where
  the cost is. Trigger: first real demand.

**Human gate: approve below before Task 1 starts.**
