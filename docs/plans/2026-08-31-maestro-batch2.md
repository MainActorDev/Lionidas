# Maestro Batch 2 Implementation Plan — A5 Subflows + A6 Resilient Selectors

> **For Hermes:** implement task-by-task with build/test verification between each. Human gate before Task 1.

**Goal:** replace coordinate-blind replay with selector-first resolution (label/type/identifier captured at record time), add runFlow subflows, and close the playback concurrency race (B5) — killing flaw #6 (cross-device replay failure).

**Architecture:** selectors are plain data inside `steps_json` (no schema migration). Recorder captures them pre-action via `alloy_snapshot` hit-test; playback resolves them against the live hierarchy per step, falling back to scaled then raw coordinates. Subflows expand flat at playback time (child steps inherit flow name + parent optionality), so the run loop stays single-pass.

**Tech:** TypeScript, better-sqlite3, vitest, Vue 3. No new dependencies, no schema changes.

**Verified integration points (this session, live code):**
- `session.ts:135-171` — manualTap/manualType dispatch then `recordStep` (post-action). Selector capture must happen BEFORE dispatch.
- `session.ts:49-65` — `recordStep` reads recording state, appends step, saves.
- `routes/templates.ts:104-149` — from-session copies `recording_json.steps` verbatim → selectors persist with zero route changes.
- `playback.ts:134-172` — step loop: substituteStep → dispatch → insStep(flow_name = t.name). Line 151: `target: { x: s.x, y: s.y }` — the coordinate blindness being fixed.
- `template-env.ts` — `substituteStep` types steps as tap/scroll/type; runFlow must pass through.
- AX audit (DEFERRED.md A6): LP app labels cover 75–92% of hittable nodes; identifiers are image assets (`ic_*`). Selector chain: identifier → label+type → coordinates.
- `startManualSession` (`session.ts:84-87`) — existing busy-device check pattern to reuse for B5.

---

### Task 1: Selector module — capture + resolve (TDD)

**Objective:** pure functions over snapshot node arrays: hit-test capture at record time, unique-match resolution at playback.

**Files:**
- Create: `server/src/manual/selector.ts`
- Test: `server/test/selector.test.ts`

**Step 1: Write failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { captureSelectorAt, resolveSelector } from '../src/manual/selector.ts';

const NODES = [
  { index: 0, type: 'Application', label: 'Lion Parcel', rect: { x: 0, y: 0, width: 428, height: 926 } },
  { index: 1, parentIndex: 0, type: 'Other', label: 'Home', rect: { x: 0, y: 0, width: 428, height: 926 }, hittable: true },
  { index: 2, parentIndex: 1, type: 'Button', label: 'Sign In', rect: { x: 20, y: 100, width: 120, height: 44 }, hittable: true },
  { index: 3, parentIndex: 1, type: 'Image', identifier: 'ic_barcode', rect: { x: 350, y: 60, width: 28, height: 28 }, hittable: true },
  { index: 4, parentIndex: 1, type: 'Other', label: 'Sign In', rect: { x: 20, y: 100, width: 120, height: 44 }, hittable: true }, // duplicate label, diff type
  { index: 5, parentIndex: 1, type: 'Other', rect: { x: 0, y: 200, width: 428, height: 60 }, hittable: true }, // no label/id — parent has one
  { index: 6, parentIndex: 1, type: 'Other', label: 'Banner', rect: { x: 0, y: 200, width: 428, height: 60 } },
];

describe('captureSelectorAt', () => {
  it('captures label+type of deepest hittable node at point', () => {
    expect(captureSelectorAt(NODES, 80, 122)).toEqual({ label: 'Sign In', type: 'Button' });
  });
  it('captures identifier when present (icons)', () => {
    const sel = captureSelectorAt(NODES, 364, 74);
    expect(sel?.identifier).toBe('ic_barcode');
  });
  it('walks to parent when hit node has no label/identifier', () => {
    // node 5 (Other, no label) → parent chain via parentIndex leads to node 1
    // 'Home' (hittable). Non-hittable sibling 'Banner' (6) is never walked to.
    expect(captureSelectorAt(NODES, 200, 230)?.label).toBe('Home');
  });
  it('returns null when nothing hittable contains the point', () => {
    expect(captureSelectorAt(NODES, -5, -5)).toBeNull();
  });
});

describe('resolveSelector', () => {
  it('resolves unique hittable match to rect center', () => {
    expect(resolveSelector(NODES, { label: 'Sign In', type: 'Button' })).toEqual({ x: 80, y: 122 });
  });
  it('resolves by identifier alone', () => {
    expect(resolveSelector(NODES, { identifier: 'ic_barcode' })).toEqual({ x: 364, y: 74 });
  });
  it('returns null on ambiguous (2+ matches)', () => {
    // label-only: matches node 2 (Button) AND node 4 (Other) → ambiguous
    expect(resolveSelector(NODES, { label: 'Sign In' })).toBeNull();
  });
  it('returns null when gone (no match)', () => {
    expect(resolveSelector(NODES, { label: 'Deleted' })).toBeNull();
  });
});
```

**Step 2:** `pnpm vitest run test/selector.test.ts` → FAIL (module missing).

**Step 3: Implement**

```ts
/** A6 element selectors: captured at record time from the live hierarchy,
 *  resolved at playback. Chain: identifier (icons) → label+type (SwiftUI
 *  text) → coordinates (last-resort fallback, scaled cross-device). */
export interface StepSelector { identifier?: string; label?: string; type?: string }

export interface SnapNode {
  index?: number; parentIndex?: number; type?: string; label?: string;
  identifier?: string; hittable?: boolean;
  rect?: { x: number; y: number; width: number; height: number };
}

function contains(n: SnapNode, x: number, y: number): boolean {
  const r = n.rect;
  return !!r && x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
}

/** Deepest hittable node containing (x,y); walks up through ancestors that
 *  carry no label AND no identifier until something addressable is found. */
export function captureSelectorAt(nodes: SnapNode[], x: number, y: number): StepSelector | null {
  const hits = nodes.filter((n) => n.hittable && contains(n, x, y));
  if (hits.length === 0) return null;
  let node = hits.reduce((small, n) =>
    (n.rect!.width * n.rect!.height < small.rect!.width * small.rect!.height ? n : small));
  while (node && !node.identifier && !node.label) {
    const parent = nodes.find((n) => n.index === node.parentIndex);
    if (!parent || !contains(parent, x, y)) break;
    node = parent;
  }
  if (!node.identifier && !node.label) return null;
  const sel: StepSelector = {};
  if (node.identifier) sel.identifier = node.identifier;
  if (node.label) sel.label = node.label;
  if (node.type) sel.type = node.type;
  return sel;
}

/** Unique hittable match → its rect center. null = gone or ambiguous
 *  (caller falls back to coordinates and logs it). */
export function resolveSelector(nodes: SnapNode[], sel: StepSelector): { x: number; y: number } | null {
  const matches = nodes.filter((n) =>
    (sel.identifier === undefined || n.identifier === sel.identifier) &&
    (sel.label === undefined || n.label === sel.label) &&
    (sel.type === undefined || n.type === sel.type));
  const hittable = matches.filter((n) => n.hittable && n.rect);
  const pool = hittable.length > 0 ? hittable : matches.filter((n) => n.rect);
  if (pool.length !== 1) return null;
  const r = pool[0]!.rect!;
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
}
```

**Step 4:** tests PASS. **Step 5:** `git commit -m "selectors: capture/resolve module (A6 core)"`.

---

### Task 2: Record-time capture in manualTap/manualType

**Objective:** every recorded tap/type carries the selector of what was hit, captured pre-action.

**Files:**
- Modify: `server/src/manual/session.ts:19-22` (RecordedStep union + `selector?`), `:44-47` (StepInput), `:135-145` (manualTap), `:159-171` (manualType), `:49-65` (recordStep signature)

**Changes:**

1. `RecordedStep` tap/type variants gain `selector: StepSelector | null`. Import type from `./selector.ts`.
2. `recordStep(deps, sessionId, step, selector: StepSelector | null = null)` — include `selector` on tap/type steps only (scroll: none, meaningless).
3. New helper in session.ts:

```ts
/** Pre-action hierarchy hit-test (A6): best-effort — a snapshot failure must
 *  not fail the interaction; step just records selector: null. */
async function captureSelector(deps: ManualDeps, udid: string, x: number, y: number): Promise<StepSelector | null> {
  try {
    const alloy = crucibleAlloy();
    const snap = (await alloy.dispatch('alloy_snapshot', { udid, interactiveOnly: false }, deps.dispatchDeps)) as
      | { ok: true; result: { nodes?: SnapNode[] } }
      | { ok: false };
    if (!snap.ok) return null;
    return captureSelectorAt(snap.result.nodes ?? [], x, y);
  } catch { return null; }
}
```

4. In `manualTap`: before the `alloy_act` dispatch, `const recordingOn = readRecording(deps, sessionId).on;` then `const selector = recordingOn ? await captureSelector(deps, s.udid, x, y) : null;` — pass to `recordStep`. Same in `manualType`. (Extra readRecording read per tap is a local SQLite hit; snapshot only fires when recording is on.)

**Verify:** manual session on LP app → tap Sign In with recording on → `GET /api/manual/:id/record` shows `"selector": {"label":"Sign In","type":"Button"}`-shaped field; tap an icon shows `identifier`.

**Step:** typecheck + `git commit -m "recorder: capture element selectors pre-action (A6a)"`.

---

### Task 3: Playback selector-first resolution + resolvedBy audit

**Objective:** replay resolves the selector against the live hierarchy; logs which path resolved.

**Files:**
- Modify: `server/src/manual/playback.ts` — `PlaybackStep` gains `selector?: { identifier?: string; label?: string; type?: string }`; step loop tap/type branches.

**Changes in the loop (replacing lines 150-153 input build):**

```ts
// A6b: selector-first resolution against the LIVE hierarchy — coordinates
// are the fallback, not the plan.
let target: { x?: number; y: number | undefined };
let resolvedBy: 'selector' | 'coordinate-fallback' | 'coordinate';
if ((s.action === 'tap' || s.action === 'type') && s.selector && (s.selector.identifier || s.selector.label)) {
  const snap = (await alloy.dispatch('alloy_snapshot', { udid, interactiveOnly: false }, deps.dispatchDeps)) as
    | { ok: true; result: { nodes?: SnapNode[] } } | { ok: false };
  const hit = snap.ok ? resolveSelector(snap.result.nodes ?? [], s.selector) : null;
  if (hit) { target = { x: hit.x, y: hit.y }; resolvedBy = 'selector'; }
  else { target = { x: s.x, y: s.y }; resolvedBy = 'coordinate-fallback'; }
} else { target = { x: s.x, y: s.y }; resolvedBy = 'coordinate'; }
let input: Record<string, unknown>;
if (s.action === 'tap') input = { udid, action: 'press', target: { x: target.x, y: target.y }, settle: true };
else if (s.action === 'scroll') input = { udid, action: 'scroll', direction: s.direction, settle: true };
else input = { udid, action: 'fill', target: { x: target.x, y: target.y }, text: resolved.text ?? '', settle: true };
```

And every `insStep.run(..., JSON.stringify(resolved))` in the try/catch becomes `JSON.stringify({ ...resolved, resolvedBy })` — evaluated_json records the resolution path (UI shows it in Task 7).

Note: `substituteStep` builds a fresh base object from explicit fields — it does **not** spread unknown fields. Task 6 therefore also adds `selector` to its input/output types so it survives the round trip (runFlow passthrough likewise).

**Verify:** template with a selector step → play on same device → run_steps.evaluated_json shows `"resolvedBy":"selector"`. Then break the selector (PATCH label to a bogus value) → play → `"resolvedBy":"coordinate-fallback"`, run still executes.

**Step:** typecheck + vitest + `git commit -m "playback: selector-first resolution with resolvedBy audit (A6b)"`.

---

### Task 4: Scaled-coordinate fallback for selector-less steps

**Objective:** old templates (and fallback coords) survive different-size devices — flaw #6's quick fix.

**Files:**
- Modify: `server/src/manual/playback.ts` — after the `alloy_apps open` succeeds, before the step loop.

**Changes:**

```ts
// cross-device scaling (flaw #6): scale recorded coords by target/recorded
// logical dims — applied only to steps WITHOUT a usable selector.
let targetW: number | null = null; let targetH: number | null = null;
try {
  const snap = (await alloy.dispatch('alloy_snapshot', { udid, interactiveOnly: false }, deps.dispatchDeps)) as
    | { ok: true; result: { nodes?: Array<{ rect?: { width: number; height: number } }> } } | { ok: false };
  if (snap.ok) { const r = snap.result.nodes?.[0]?.rect; if (r) { targetW = r.width; targetH = r.height; } }
} catch { /* dims best-effort */ }
const scaleX = targetW && t.logical_w && t.logical_w > 0 ? targetW / t.logical_w : 1;
const scaleY = targetH && t.logical_h && t.logical_h > 0 ? targetH / t.logical_h : 1;
```

In the Task 3 coordinate branches, when `(scaleX !== 1 || scaleY !== 1)` and the step has no usable selector: `target = { x: Math.round(s.x! * scaleX), y: Math.round(s.y! * scaleY) }`, `resolvedBy = 'coordinate-scaled'`. Selector steps need no scaling (live rect). Extend the `resolvedBy` union type accordingly.

**Verify:** unit-style check via live API — template recorded at 428×926 played on a 375-pt device logs `"resolvedBy":"coordinate-scaled"` for selector-less steps.

**Step:** `git commit -m "playback: cross-device coordinate scaling for selector-less steps (flaw 6)"`.

---

### Task 5: expandFlows — subflow flattening (TDD)

**Objective:** pure expansion of runFlow steps into a flat step list with flow names + optionality propagation + cycle guard.

**Files:**
- Create: `server/src/manual/flows.ts`
- Test: `server/test/flows.test.ts`

**Step 1: Failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { expandFlows } from '../src/manual/flows.ts';

const TPLS: Record<string, { name: string; steps: Array<Record<string, unknown>> }> = {
  login: { name: 'login', steps: [{ idx: 0, action: 'tap', x: 1, y: 1 }, { idx: 1, action: 'type', x: 2, y: 2, text: 'a' }] },
  home: { name: 'home-check', steps: [{ idx: 0, action: 'runFlow', templateId: 'login' }, { idx: 1, action: 'scroll', direction: 'up' }] },
  wrap: { name: 'wrap', steps: [{ idx: 0, action: 'runFlow', templateId: 'home', optional: true }] },
  self: { name: 'self', steps: [{ idx: 0, action: 'runFlow', templateId: 'self' }] },
};
const load = (id: string) => TPLS[id] ?? null;

describe('expandFlows', () => {
  it('inlines child steps, tags them with child flow name, renumbers', () => {
    const out = expandFlows(TPLS['home']!.steps, load);
    expect(out.map((s) => [s.idx, s.flow])).toEqual([[0, 'login'], [1, 'login'], [2, undefined]]);
  });
  it('non-runFlow steps pass through untouched', () => {
    const out = expandFlows(TPLS['login']!.steps, load);
    expect(out[0]).toEqual({ idx: 0, action: 'tap', x: 1, y: 1 });
  });
  it('optional runFlow marks child steps optional', () => {
    const out = expandFlows(TPLS['wrap']!.steps, load);
    expect(out.every((s) => s.optional === true)).toBe(true);
    expect(out.every((s) => typeof s.flow === 'string')).toBe(true);
  });
  it('cycles throw', () => {
    expect(() => expandFlows(TPLS['self']!.steps, load)).toThrow(/cycle/);
  });
  it('missing template throws', () => {
    expect(() => expandFlows([{ idx: 0, action: 'runFlow', templateId: 'nope' }], load)).toThrow(/not found/);
  });
  it('same subflow twice (not a cycle) is allowed', () => {
    const out = expandFlows([{ idx: 0, action: 'runFlow', templateId: 'login' }, { idx: 1, action: 'runFlow', templateId: 'login' }], load);
    expect(out).toHaveLength(4);
  });
  it('depth > 5 throws', () => {
    const deep: Record<string, { name: string; steps: Array<Record<string, unknown>> }> = {};
    for (let i = 0; i < 8; i++) deep[`t${i}`] = { name: `t${i}`, steps: [{ idx: 0, action: 'runFlow', templateId: `t${i + 1}` }] };
    deep['t8'] = { name: 't8', steps: [{ idx: 0, action: 'tap', x: 0, y: 0 }] };
    expect(() => expandFlows(deep['t0']!.steps, (id) => deep[id] ?? null)).toThrow(/nesting/);
  });
});
```

**Step 2:** FAIL (module missing). **Step 3: Implement**

```ts
/** A5 subflows: flatten runFlow steps into a flat executable list at playback
 *  time. Child steps get flow = child template name (run_steps.flow_name shows
 *  provenance) and inherit the runFlow step's optional flag. Cycle guard walks
 *  the DFS path only — the same subflow may be referenced twice. */
export interface FlowStep { idx: number; action: string; flow?: string; templateId?: string; optional?: boolean; [k: string]: unknown }

export function expandFlows(
  steps: FlowStep[],
  loadTemplate: (id: string) => { name: string; steps: FlowStep[] } | null,
  path: string[] = [],
  depth = 0,
): FlowStep[] {
  if (depth > 5) throw new Error('subflow nesting > 5');
  const out: FlowStep[] = [];
  for (const s of steps) {
    if (s.action !== 'runFlow') { out.push(s); continue; }
    const id = String(s.templateId ?? '');
    if (path.includes(id)) throw new Error(`subflow cycle: ${[...path, id].join(' → ')}`);
    const child = loadTemplate(id);
    if (!child) throw new Error(`subflow template not found: ${id}`);
    const childSteps = expandFlows(child.steps, loadTemplate, [...path, id], depth + 1)
      .map((cs) => ({ ...cs, flow: cs.flow ?? child.name, optional: s.optional ? true : cs.optional }));
    out.push(...childSteps);
  }
  return out.map((s, i) => ({ ...s, idx: i }));
}
```

**Step 4:** PASS. **Step 5:** `git commit -m "flows: expandFlows flattening with cycle guard (A5 core)"`.

---

### Task 6: Playback wiring — subflows, runFlow passthrough, B5 device guard

**Objective:** the loop executes expanded steps with per-step flow names; runFlow steps substitute cleanly; two plays can't race one device.

**Files:**
- Modify: `server/src/manual/playback.ts` (loop + guard), `server/src/manual/template-env.ts` (type passthrough)

**Changes:**

1. **template-env.ts** — widen the step union in `substituteStep` with `| { idx: number; action: 'runFlow'; templateId: string; optional?: boolean }` **and add `selector?: StepSelector` to the input/output shapes** (base spread: `...(s.selector ? { selector: s.selector } : {})`) so both survive the round trip. runFlow has no text to substitute; the tap/scroll/type text logic never touches it.
2. **playback.ts** — `PlaybackStep` gains `templateId?: string; flow?: string`.
3. **stepName** (`playback.ts:46-50`): add `if (s.action === 'runFlow') return `run flow ${s.templateId ?? '?'}`;`
4. **Expansion before the loop** (inside `done`, after `open` succeeds):

```ts
// A5: expand subflows flat — child steps carry flow + inherited optional
let steps: PlaybackStep[];
try {
  steps = expandFlows(rawSteps, (id) => {
    const row = deps.db.prepare('SELECT name, steps_json FROM templates WHERE id = ?').get(id) as { name: string; steps_json: string } | undefined;
    return row ? { name: row.name, steps: JSON.parse(row.steps_json) as PlaybackStep[] } : null;
  }) as PlaybackStep[];
} catch (err) {
  throw new Error(`subflow expansion failed: ${err instanceof Error ? err.message : String(err)}`);
}
```

(`rawSteps` = the current steps source; the existing catch at `playback.ts:173` already aborts the run with the message in `runs.note`.)

5. **insStep flow_name** (`playback.ts:156` and siblings): `t.name` → `(s.flow ?? t.name)` in all five insStep call sites in the loop.
6. **B5 guard** at the top of `runTemplatePlayback`, before the runs-row INSERT:

```ts
const busy = deps.db
  .prepare(`SELECT 1 FROM runs WHERE device_udid = ? AND status IN ('queued','running') LIMIT 1`)
  .get(udid);
if (busy) throw new PlaybackError('DEVICE_BUSY', 'a run or manual session is active on this device — wait or abort it');
```

Export `PlaybackError` (mirror `ManualSessionError`); route maps it to HTTP 409. Unlike the manual-start check, this blocks on manual sessions too — correct: two drivers on one device is the race we demoed.

**Verify:** template B (runFlow → template A) plays → run_steps rows show `flow_name` from A for its steps, parent name after; B5: start manual session on device, POST play → 409 DEVICE_BUSY.

**Step:** typecheck + vitest + `git commit -m "playback: subflow execution, flow names, device busy guard (A5+B5)"`.

---

### Task 7: UI — selector chips, subflow display/add, resolvedBy

**Files:**
- Modify: `web/src/pages/TemplatesPage.vue` (step list + add-subflow), `web/src/pages/RunDetailPage.vue` (evaluatedText)

**Changes:**

1. **TemplatesPage** `Step` interface gains `selector?: { identifier?: string; label?: string; type?: string }; templateId?: string`. `stepLabel` adds: runFlow → `run flow: <template name>` (resolve from loaded `templates` list by id, fall back to the id). Step row renders a chip after the label when `s.selector` exists: `{{ s.selector.identifier ?? s.selector.label }}` (title shows full selector JSON). Expanded body gains a `+ subflow` button → `window.prompt('subflow template name:')` → match against loaded templates → PATCH steps appending `{ idx: steps.length, action: 'runFlow', templateId }`; no match → alert.
2. **RunDetailPage** `evaluatedText`: append resolution provenance — after the summary string, `${ev.resolvedBy ? ' · ' + ev.resolvedBy : ''}`.

**Verify:** `npx vue-tsc --noEmit` clean; Vite transform 200 on both pages; manual render check in browser.

**Step:** `git commit -m "ui: selector chips, subflow add/display, resolvedBy in evaluated (A5/A6)"`.

---

### Task 8: Live verification round

**Objective:** prove the batch against the real app, both devices.

1. **Record with selectors:** manual session on LP app (iPhone 16 Pro, 428×926), recording on — tap tracking field, type, tap an icon tab, scroll → save as template. Confirm steps carry selectors (icons → identifier, text → label+type).
2. **Same-device replay:** play → all selector steps `resolvedBy:"selector"` in evaluated_json; run green.
3. **Cross-device replay:** boot the SE-family sim (375-pt), play the SAME template → selector steps resolve on the smaller screen (`resolvedBy:"selector"`), selector-less steps show `coordinate-scaled`. Run green or fails only where genuinely broken.
4. **Broken-selector fallback:** PATCH one selector label to bogus → play → `coordinate-fallback` logged, step still attempts.
5. **Subflow:** template A = 2-tap flow; template B = runFlow A + scroll. Play B → run detail shows A's steps under A's flow name, renumbered, then B's.
6. **B5:** with a manual session open on the device, POST play → 409.
7. Cleanup: delete verification templates, finish sessions.

---

### Task 9: Docs close-out

- DEFERRED.md: remove A5 + A6 entries (shipped), remove flaw #6 (cross-device replay — fixed by A6+scaling), mark B5 fixed in the header's fixed-list, note remaining backlog (B1-B4, B7-B9, B11-B12).
- Commit `docs: batch 2 shipped — A5/A6 out, flaw 6 + B5 closed`.

---

## Self-review (fill after drafting)

- [ ] All paths verified against live code this session (not memory)
- [ ] Backward compat: steps without selectors → coordinate path (today's behavior); steps_json needs no migration
- [ ] Cycles guarded by DFS path, duplicates allowed, depth capped
- [ ] runFlow + optional semantics: child failure skips remaining child steps (loop's existing break) but parent continues — matches A3 semantics
- [ ] B5 guard blocks manual sessions too (two drivers = the demoed race)
- [ ] No secrets in steps_json beyond what batch 1 already addressed (env refs)

## Risks / open questions

- **Snapshot-per-selector-step cost** (~200-500ms each): acceptable for QA regression; if it grates, cache per N ms — deferred deliberately.
- **Ambiguous labels** (Settings showed 3× "Account"): resolveSelector returns null → coordinate fallback with audit trail. QA re-records or the app adds identifiers later. Not silently wrong — logged.
- **SwiftUI list reuse**: same label appears once per cell instance (e.g., every "Track" button in a list) → ambiguous → fallback. Honest limitation, documented.
- **Subflow expansion loads templates at play time**: a child edited after parent creation takes effect on next play (data, not snapshot) — Maestro-consistent.

**Human gate: approve below before Task 1 starts.**
