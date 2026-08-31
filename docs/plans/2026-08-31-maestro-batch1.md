# Maestro Batch 1 — Templating Core (A1–A4) Implementation Plan

> **For Hermes:** implement task-by-task with build/test verification between each. Human gate before Task 1.

**Goal:** Templates become parameterized, selectable regression configs — `${env.KEY}` substitution (A1), evaluated-step audit logging (A4), tags + play-all (A2), optional steps (A3).

**Architecture:** One new pure module (`template-env.ts`) owns `${env.KEY}` resolution. Playback gains a pre-dispatch resolution pass that (a) fails deterministically on missing keys, (b) writes the post-substitution step to `run_steps.evaluated_json`. Tags are a nullable JSON column filtered in SQL. Play-all sequences completions via a new done-promise from playback. UI: TemplatesPage gets tag chips/filter/play-all/parameterize/optional-checkbox.

**Tech Stack:** Fastify + better-sqlite3 (guarded ALTERs), Vue 3 TemplatesPage, vitest.

**Source of record:** `DEFERRED.md` §A1–A4. Out of scope: A5 subflows, A6 selectors, B-flaws (except a minimal per-run wait cap inside play-all — a wedged run must not wedge the batch).

**Verified integration points** (read this session):
- Step loop + `PlaybackStep` + fire-and-forget inner async: `server/src/manual/playback.ts:24-31, 101-171`
- Play route (body: udid/triggeredBy/scenarioId): `server/src/routes/manual.ts:156-169`
- Templates CRUD + from-session: `server/src/routes/templates.ts:49-150`
- Guarded ALTER pattern: `server/src/db/schema.ts:216-219`
- `run_steps` INSERT (10 cols): `playback.ts:120-123`

---

### Task 1: `template-env.ts` — resolver (TDD)

**Files:** Create `server/src/manual/template-env.ts`, `server/test/template-env.test.ts`

**Step 1 — failing test:**

```ts
import { describe, it, expect } from 'vitest';
import { expandEnvText, substituteStep } from '../src/manual/template-env.ts';

describe('expandEnvText', () => {
  it('resolves ${env.KEY} inside surrounding text', () => {
    expect(expandEnvText('user=${env.USER}!', { USER: 'budi' })).toBe('user=budi!');
  });
  it('multiple refs in one string', () => {
    expect(expandEnvText('${env.A}-${env.B}', { A: 'x', B: 'y' })).toBe('x-y');
  });
  it('returns null on missing key (deterministic fail, no partial typing)', () => {
    expect(expandEnvText('${env.MISSING}', {})).toBeNull();
  });
  it('plain text without refs passes through', () => {
    expect(expandEnvText('hello', {})).toBe('hello');
  });
});

describe('substituteStep', () => {
  it('substitutes text on type steps, leaves tap/scroll untouched', () => {
    const s = substituteStep({ idx: 1, action: 'type', x: 5, y: 6, text: '${env.PW}' }, { PW: 's3cret' });
    expect(s).toEqual({ idx: 1, action: 'type', x: 5, y: 6, text: 's3cret' });
    expect(substituteStep({ idx: 2, action: 'tap', x: 1, y: 2 }, {})).toEqual({ idx: 2, action: 'tap', x: 1, y: 2 });
  });
  it('returns error field on missing key instead of throwing', () => {
    const r = substituteStep({ idx: 1, action: 'type', text: '${env.NOPE}' }, {});
    expect(r.error).toBe('missing env: NOPE');
  });
});
```

**Step 2:** `pnpm vitest run test/template-env.test.ts` → FAIL (module missing).

**Step 3 — implementation:**

```ts
/** Maestro-style env templating: ${env.KEY} refs resolve at playback time.
 *  Missing key = null (caller fails the step BEFORE dispatch — never type a
 *  half-resolved string). Pure module: no db, no alloy. */
export interface SubstitutedStep {
  idx: number; action: 'tap' | 'scroll' | 'type';
  x?: number; y?: number; direction?: 'up' | 'down' | 'left' | 'right';
  text?: string;
  /** set when an env ref could not be resolved */
  error?: string;
}

const REF = /\$\{env\.([A-Za-z0-9_]+)\}/g;

export function expandEnvText(text: string, env: Record<string, string>): string | null {
  let missing: string | null = null;
  const out = text.replace(REF, (_m, key: string) => {
    const v = env[key];
    if (v === undefined) { missing = key; return ''; }
    return v;
  });
  return missing ? null : out;
}

export function substituteStep(s: { idx: number; action: 'tap' | 'scroll' | 'type'; x?: number; y?: number; direction?: 'up' | 'down' | 'left' | 'right'; text?: string; optional?: boolean }, env: Record<string, string>): SubstitutedStep {
  const base: SubstitutedStep = { idx: s.idx, action: s.action, ...(s.x !== undefined ? { x: s.x } : {}), ...(s.y !== undefined ? { y: s.y } : {}), ...(s.direction ? { direction: s.direction } : {}) };
  if (s.text === undefined) return base;
  const expanded = expandEnvText(s.text, env);
  return expanded === null ? { ...base, error: `missing env: ${s.text.match(REF)?.[0] ?? ''}` } : { ...base, text: expanded };
}
```

Note: error message includes the first unresolved ref. Simplify `substituteStep`'s missing-key branch to extract the key: iterate `s.text.match(REF)` and return `missing env: ${key}` for the first key absent from env.

**Step 4:** tests PASS. **Step 5:** `git commit -m "templating: env resolver module (A1 core)"`.

---

### Task 2: schema — `tags_json`, `evaluated_json` (guarded ALTERs)

**Files:** Modify `server/src/db/schema.ts` (after line 219, same array/pattern as existing ALTERs)

```ts
// Maestro batch 1: template tags (filtered regression selection) + evaluated
// step logging (post-substitution audit truth)
'ALTER TABLE templates ADD COLUMN tags_json TEXT',
'ALTER TABLE run_steps ADD COLUMN evaluated_json TEXT',
```

Both nullable — old rows and every existing INSERT stay valid (backward-compat check ✓). `rowToTemplate` maps `tags: r.tags_json ? JSON.parse(r.tags_json) : []`.

**Verify:** restart server; `curl /api/templates` still 200; existing rows return `tags: []`. Commit.

---

### Task 3: playback — substitution + evaluated logging + missing-env fail

**Files:** Modify `server/src/manual/playback.ts`

1. Import `{ substituteStep }`; `runTemplatePlayback` opts gain `env?: Record<string, string>`.
2. In the step loop, before building the alloy input:

```ts
const resolved = substituteStep(s, opts.env ?? {});
if (resolved.error) {
  runStatus = 'failed';
  insStep.run(runId, s.idx, t.name, stepName(s), 'fail', resolved.error, t0, 0, '[]', JSON.stringify(resolved));
  // remaining steps skipped, same as dispatch failure
  for (const rest of steps.filter((x) => x.idx > s.idx)) {
    insStep.run(runId, rest.idx, t.name, stepName(rest), 'skip', 'not reached', Date.now(), 0, '[]', null);
  }
  break;
}
```

**Self-review fix:** skip rows bind JS `null` for `evaluated_json` — a bound `'NULL'` string would store the literal text `"NULL"` (better-sqlite3 binds params, not SQL keywords). Same for any not-applicable column.

3. `insStep` INSERT gains `evaluated_json` (11th column): pass `JSON.stringify(resolved)` on pass rows too — audit truth for every executed step, `${...}` or not.
4. Dispatch uses `resolved.text` for fill input.
5. Missing-env on an `optional` step (Task 4 interplay): still fails the run — a missing credential is a config error, not a transient UI miss. Note in code comment.

**Verify:** `pnpm typecheck`; `pnpm vitest run` (77 still green). Commit.

---

### Task 4: playback — `optional: true` steps

**Files:** Modify `server/src/manual/playback.ts` (`PlaybackStep` + loop)

1. `PlaybackStep` gains `optional?: boolean`.
2. Loop catch-block: `if (s.optional) { insStep.run(..., 'skip', \`optional miss: ${msg}\`, ...); continue; }` — run stays green.
3. Recorder save path (`routes/templates.ts` from-session + patch) already stores raw steps JSON — `optional` round-trips with zero changes there.

**Verify:** typecheck + vitest. Commit.

---

### Task 5: playback — done-promise (enables play-all)

**Files:** Modify `server/src/manual/playback.ts`, `server/src/routes/manual.ts`

Refactor inner `void (async () => {...})()` into a named promise the function returns alongside runId:

```ts
const done = (async () => { /* existing body */ })();
return { runId, done };
```

Single play route: `const { runId } = await runTemplatePlayback(...)` — unchanged behavior (done ignored). Changing the return shape is a breaking API for any other caller — grep `runTemplatePlayback` first; this session verified the only caller is `routes/manual.ts:160` (baselines.ts calls a different runner). [VERIFY] again before editing.

**Verify:** typecheck; single play still returns `{runId}` and runs. Commit.

---

### Task 6: routes — env on play, tags filter, play-all

**Files:** Modify `server/src/routes/manual.ts` (play + play-all), `server/src/routes/templates.ts` (list filter)

1. **Play route** body gains `env?: Record<string, string>` → passed through to playback opts.
2. **Tags filter** in `GET /api/templates`: `?tags=smoke,login` (comma list, AND semantics — a regression suite composes by intersection) + `?app=<bundleId>`. SQL: filter in JS over rows (JSON column, small table) — `rows.filter(r => want.every(t => tags(r).includes(t)))`.
3. **Play-all**: `POST /api/templates/play-all` body `{ tags?, app?, udid?, triggeredBy?, scenarioId?, env? }`:
   - Select templates with the same filter logic (shared helper, DRY with #2).
   - Zero matches → 400 `no templates match`.
   - Sequential: `for (const t of sel) { const { runId, done } = await runTemplatePlayback(...); await Promise.race([done, sleep(5 * 60_000)]); }` — 5-min per-run cap so a wedged run can't wedge the batch (scoped slice of B2; full watchdog stays deferred).
   - Returns `{ runIds }`.

**Verify:** typecheck + vitest; curl play-all with a tag matching one template → one runId, run completes. Commit.

---

### Task 7: templates routes — tags write path

**Files:** Modify `server/src/routes/templates.ts`

- `from-session`, `POST`, `PATCH` accept `tags?: string[]`; store `JSON.stringify(b.tags ?? null)`; PATCH merges/replace semantics: replace when provided (matches name/description behavior). `rowToTemplate` parses.
- Validation: strings, trimmed, non-empty, dedup; max 8 tags (guard against chip soup).

**Verify:** typecheck; curl create+list round-trip with tags. Commit.

---

### Task 8: UI — TemplatesPage

**Files:** Modify `web/src/pages/TemplatesPage.vue`

1. **Tag chips** on each template row + **filter box** (`tags=…, app=…` → refetch with query params).
2. **Play all (filtered)** button → `POST /api/templates/play-all` with current filter + optional env dialog (simple `window.prompt` pair: `KEY=value` lines → parsed to object; self-explanatory placeholder text).
3. **Parameterize**: expanded step row → "parameterize" button → `prompt('env key name (e.g. PASSWORD)')` → step.text becomes `${env.NAME}` → PATCH template. This is the plaintext-secret fix (B10) — literal stays until the user parameterizes.
4. **Optional checkbox** per step → PATCH steps with `optional`.
5. **Evaluated display**: run steps render in `web/src/pages/RunDetailPage.vue:7-89` (fetched from `/api/runs/:runId/steps`, table with #/flow/status/duration/reason). Patch there: `Step` interface + steps table gain `evaluated_json` → when present and different from the template step's `name`, show a muted second line under the step row. Target file verified this session — do NOT patch TemplatesPage for this.

**Verify:** `npx vue-tsc --noEmit` clean; manual click-through on dev server. Commit.

---

### Task 9: live verification round + docs

1. Restart server; on the booted iPhone record a short type+tap flow → save template.
2. Parameterize the typed step → `steps_json` contains `${env.X}` (assert via sqlite3).
3. Play with `{"env":{"X":"hello"}}` → run passes; `run_steps.evaluated_json` contains `hello`; template row contains no literal.
4. Play with empty env → run fails, reason `missing env: X`, nothing typed.
5. Tag it `smoke` → `?tags=smoke` returns it → play-all runs it.
6. Optional step that misses → run green, step `skip / optional miss: …`.
7. Update `DEFERRED.md`: A1–A4 → built (moved out per the file's rule); note B10 resolved-by-A1.
8. Final commit.

---

## Risks / trade-offs

- **evaluated_json stores resolved secrets** (audit truth vs leakage). Accepted for local-first tool; traffic bodies already sit in the same DB. Revisit with B11 if Crucible ever leaves localhost.
- **Play-all sequential + poll-free** thanks to done-promise; still no cross-request concurrency guard (B5 stays deferred — play-all itself is one serialized chain).
- **AND tag semantics** chosen over OR — regression suites compose by intersection; OR is a one-line change if QA disagrees.
- **`window.prompt`** for env entry + parameterize: zero new components, self-explanatory; replace with proper modal if it grates.

## Self-review (filled after drafting — see chat)

- [x] All paths verified against live code this session (not memory)
- [x] Backward compat: both new columns nullable; `optional`/`env` optional fields; old templates unchanged
- [x] Return-shape change in Task 5 scoped by caller grep
- [x] Missing-env ≠ optional-miss (config error vs transient miss) — decided, documented
- [x] Play-all can't hang (per-run cap)
