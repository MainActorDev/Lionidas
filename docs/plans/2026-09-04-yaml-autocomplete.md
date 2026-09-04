# YAML Editor Autocomplete — Slot-Aware Completions Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** The case YAML editor completes BOTH the grammar (keys, actions, directions) and the app's real vocabulary (recorded labels/identifiers, case names for runFlow, bundle ids, tags) — slot-aware, auto-quoted, skeleton snippets for new steps.

**Architecture:** Three layers. (1) A **vocabulary endpoint** aggregates distinct selector labels/identifiers (with usage counts + source case), case names, bundle ids, and tags from the `templates` table. (2) A **pure slot-context module** (`shared/`, regex-based line parse) maps (doc, cursor) → which slot the user is typing in — no CodeMirror dependency, fully unit-testable. (3) A **completion source** combines slot + vocabulary → CM6 `Completion[]`; wired into the existing lazy `useYamlEditor` via the `@codemirror/autocomplete` package (new dependency, additive; all existing CM deps already satisfy its peers).

**Tech Stack:** Fastify + better-sqlite3 (endpoint), `@crucible/shared` (slot context — same package as `case-yaml.ts`), CodeMirror 6 `@codemirror/autocomplete` (editor wiring).

**User-facing contract (from the concept discussion, approved):**
- Grammar completions stop typos; vocabulary completions stop context-switching.
- Slot-aware by line context; each slot has its own source (table in the concept message).
- Values insert auto-quoted exactly like `yamlScalar` would emit them.
- Completions apply inside already-open quotes.
- NO live-screen probing, NO full YAML AST, NO env completion (v1 scope).

---

## Current state (verified in code, 2026-09-04)

- Format grammar: `shared/src/case-yaml.ts` — top-level `name/tags/app/steps`; steps `- tap: { point: [x,y], on: …, optional: true }`, `- scroll: up|down|left|right`, `- type: { point/text/on/optional }`, `- runFlow: { name: …, optional }`, `- expect: 'label' | { on: …, optional }`. Body-key whitelist per action at case-yaml.ts:159 (`point/on/text/optional/id/name`). `on:` → identifier iff `/^[a-z][a-z0-9_]*$/` else label.
- `yamlScalar` (case-yaml.ts:240) is PRIVATE — the quoting rules must be reused, not re-implemented. **Export it** (it is pure).
- Steps in storage carry `selector: { label?, identifier? }` (recorded), plus `text`, `templateId`. `templates.tags_json`, `app_bundle_id`, `name` columns exist.
- Editor: `web/src/composables/useYamlEditor.ts` — CM6, lazy dynamic imports, extensions array at :90. Panel: `CaseEditorPanel.vue` (owns save/load; fetches `/api/templates/:id/yaml`).
- Validate route exists (`POST /api/templates/yaml/validate`, templates.ts:213) — the panel and save share one validator.
- `@codemirror/autocomplete` NOT installed (verified: not in package.json, exports absent from @codemirror/language & commands). Latest 6.20.3; deps = existing language/state/view + @lezer/common (already transitively present via lang-yaml).
- Tests live in `server/test/*.test.ts` (vitest, `migrateM1` in-memory DBs); shared has no test file yet — shared code is tested through server tests; a pure module CAN be tested directly with vitest from server (imports work via workspace package `@crucible/shared`).
- **[VERIFIED] shared package exports map**: `{"." : "./src/case-yaml.ts", "./case-yaml": "./src/case-yaml.ts"}` — new modules MUST add subpath exports (`./yaml-slots`, `./yaml-completions`) or imports fail under `module: nodenext`. Existing import style: `from '@crucible/shared/case-yaml'` (server + web + test all use it).
- **[VERIFIED] route registration signature**: `registerTemplateRoutes(app, db, dispatchDeps?)` — the vocabulary-route test registers with `(app, db)` exactly like the plan shows.
- **[VERIFIED] slotAt semantics against the test table** — two cases in the draft test were WRONG against the intended implementation:
  - `slotAt('name: x\nsteps:\n', 11)` — position 11 is the START of the `steps:` line, i.e. typing a top-level key from scratch → `top-key` ✓ correct as written.
  - `slotAt(doc('steps:\n  - '), 10)` — position 10 is exactly after `- ` → `step-action` ✓.
  - BUT `slotAt(doc(''), 0)` on an EMPTY doc: `before` = `''`, trimmed matches `/^[a-z]*$/i` → `top-key` ✓ fine.
  - The `tag-value` check `/\btags:\s*\[[^\]]*$/` runs BEFORE the step logic — `tags: [smo` matches ✓, and a step line can't contain `tags:` (not a valid body key) so ordering is safe.
  - The draft's `kv` regex (`/^(.*?):(\s*)(.*)$/` on `afterDash`) is UNDEFINED-redundant — `expect` without braces checks `!kv` but `kv` always matches when a colon exists. Simplify: scalar-expect detection = action is `expect` AND no `{` on the line after the action.


---

## Task 1: Export `yamlScalar` + shared slot-context module

**Objective:** Pure function: given the full doc text and a cursor offset, classify the slot; also expose the quoting helper.

**Files:**
- Modify: `shared/src/case-yaml.ts` (export `yamlScalar`)
- Create: `shared/src/yaml-slots.ts`
- Test: `server/test/yaml-slots.test.ts` (imports `@crucible/shared` — same path server tests already use for case-yaml; [VERIFY] the exact import specifier used by existing consumers first)

**Step 1 — failing test:**

```ts
import { describe, it, expect } from 'vitest';
import { slotAt, yamlQuote } from '@crucible/shared/yaml-slots';
import { yamlQuote as q2 } from '@crucible/shared/case-yaml';

describe('slotAt', () => {
  it('top-level key slot at column 0 of an empty/new doc region', () => {
    expect(slotAt('name: x\nsteps:\n', 11)).toBe('top-key');   // cursor at start of the "steps:" line
    expect(slotAt('', 0)).toBe('top-key');
  });

  it('step-action slot right after "- "', () => {
    expect(slotAt('steps:\n  - ', 10)).toBe('step-action');
  });

  it('direction slot after "scroll: "', () => {
    expect(slotAt('steps:\n  - scroll: ', 16)).toBe('direction');
  });

  it('body-key slot inside a tap mapping, typing a key name', () => {
    const y = 'steps:\n  - tap: { po';
    expect(slotAt(y, y.length)).toBe('body-key');
  });

  it('on-value slot after "on: "', () => {
    const y = 'steps:\n  - tap: { point: [1, 2], on: Be';
    expect(slotAt(y, y.length)).toBe('on-value');
  });

  it('runFlow name slot', () => {
    const y = 'steps:\n  - runFlow: { name: lo';
    expect(slotAt(y, y.length)).toBe('runflow-name');
  });

  it('app slot after "app: "', () => {
    const y = 'name: x\napp: com.l';
    expect(slotAt(y, y.length)).toBe('app-value');
  });

  it('tag slot inside tags: [...]', () => {
    const y = 'name: x\ntags: [smo';
    expect(slotAt(y, y.length)).toBe('tag-value');
  });

  it('quoted on-value: cursor inside the quotes still completes', () => {
    const y = "steps:\n  - expect: { on: 'Ber";
    expect(slotAt(y, y.length)).toBe('on-value');
  });

  it('text slot after "text: " → no vocabulary (free text)', () => {
    const y = 'steps:\n  - type: { text: hun';
    expect(slotAt(y, y.length)).toBe('none');
  });

  it('scalar expect (no braces) after "- expect: "', () => {
    const y = 'steps:\n  - expect: Ber';
    expect(slotAt(y, y.length)).toBe('on-value');
  });

  it('free text after "name: " top-level → none (arbitrary case names)', () => {
    const y = 'name: tn';
    expect(slotAt(y, y.length)).toBe('none');
  });
});

describe('yamlQuote (re-exported from case-yaml)', () => {
  it('quotes exactly like the serializer would', () => {
    expect(yamlQuote('Beranda')).toBe('Beranda');
    expect(yamlQuote('Log in to get the best shipping rates.')).toBe("'Log in to get the best shipping rates.'");
    expect(yamlQuote('ic_barcode')).toBe('ic_barcode');
    expect(yamlQuote('true')).toBe("'true'");   // looks like a bool → quoted
    expect(yamlQuote('')).toBe("''");
    expect(yamlQuote('It\'s here')).toBe("'It''s here'");   // quote doubling
    // the re-export IS the same function — no drift possible
    expect(yamlQuote).toBe(q2);
  });
});
```

**Step 2 — verify failure:** `npx vitest run test/yaml-slots.test.ts` → FAIL (module missing).

**Step 3 — implement** `shared/src/yaml-slots.ts`:

```ts
/** Slot classification for the case-YAML editor's autocomplete: given the
 *  doc and a cursor offset, decide WHICH slot the user is typing in. Pure
 *  regex line-context (the format is line-shaped by construction —
 *  caseToYaml emits one line per step); NO yaml re-parse, NO CodeMirror
 *  dependency. Returns 'none' when unsure — the completion source then
 *  offers nothing (fails safe, never wrong). */
export type YamlSlot =
  | 'top-key'        // typing a top-level key (name/tags/app/steps)
  | 'step-action'    // right after "- " — offer action skeletons
  | 'body-key'       // typing a key inside an action's { … }
  | 'direction'      // after "scroll: "
  | 'on-value'       // after "on: " or "- expect: " — label/identifier vocab
  | 'runflow-name'   // after "runFlow: { name: " or "- runFlow: "
  | 'app-value'      // after "app: "
  | 'tag-value'      // inside tags: [ … ]
  | 'none';

export function slotAt(doc: string, cursor: number): YamlSlot {
  // find the current line (up to cursor, not past it)
  const lineStart = doc.lastIndexOf('\n', cursor - 1) + 1;
  const before = doc.slice(lineStart, cursor);   // text on this line before the cursor

  // inside a top-level tags list?
  if (/\btags:\s*\[[^\]]*$/.test(before)) return 'tag-value';

  // step context: this line (or a recent one) opened a step. Steps are
  // single-line; the step action is on the same line as its body.
  const stepMatch = /^(\s*)-\s/.exec(before);
  const isStepLine = stepMatch !== null;
  const afterDash = isStepLine ? before.slice(stepMatch![0].length) : '';

  // key-position vs value-position on the line:
  // last ":" not inside brackets/quotes governs
  const kv = /^(.*?):(\s*)(.*)$/.exec(afterDash);

  if (isStepLine) {
    if (afterDash === '') return 'step-action';
    const action = /^(\w+)\s*:/.exec(afterDash)?.[1];
    if (!action) return 'none';
    if (action === 'scroll') return 'direction';
    if (action === 'expect' && !kv) return 'on-value';       // "- expect: Ber"
    if (action === 'runFlow') {
      return /name:\s*'?[^']*$/.test(afterDash) ? 'runflow-name' : 'none';
    }
    // tap / type / expect mapping: are we typing a KEY or a VALUE?
    const inValue = /(?:\b(?:on|name|app):\s*)[^,}]*$/.test(afterDash);
    if (inValue && /(?:\bon:|name)\s*:\s*('?)[^,}'"]*$/.test(afterDash)) {
      return action === 'expect' || action === 'tap' || action === 'type' ? 'on-value' : 'none';
    }
    if (/^[a-z]*$/.test(afterDash.split(/[:,]/).pop() ?? '')) return 'body-key';
    return 'none';
  }

  // top-level: key position?
  if (/^[a-z]*$/i.test(before.trim())) return 'top-key';
  if (/^app:\s*/.test(before)) return 'app-value';
  if (/^tags:\s*\[[^\]]*$/.test(before)) return 'tag-value';
  return 'none';
}
```

(The regexes above are the DESIGN — the implementer refines against the test table until all cases pass; the tests are the contract. Add edge tests freely while implementing: multi-step docs, cursor mid-line, `{ }` already closed, `optional: true` trailing.)

Also export from case-yaml.ts:

```ts
/** Quoting for completion inserts — MUST match the serializer exactly or
 *  picking a value can produce a doc the validator rejects. */
export const yamlQuote = yamlScalar;
```

(Re-export, not copy — one quoting rule forever.)

**Step 4 — verify pass** (all slot tests + quote tests).
**Step 5 — commit:** `feat(yaml-editor): shared slot-context module + exported yamlQuote`

---

## Task 2: Vocabulary endpoint

**Objective:** `GET /api/templates/vocabulary` — everything the completion slots need, one fetch.

**Files:**
- Modify: `server/src/routes/templates.ts`
- Test: `server/test/vocabulary-route.test.ts` (`app.inject`, forge.editor pattern)

Response shape:

```jsonc
{
  "selectors": [
    { "value": "Beranda", "kind": "label", "uses": 7, "cases": ["tnc", "login"] },
    { "value": "ic_barcode", "kind": "identifier", "uses": 3, "cases": ["scan"] }
  ],
  "caseNames": ["tnc", "privacy policy", "login-flow"],
  "apps": ["com.lioparcel.services.consumer.int-dev"],
  "tags": ["smoke", "regression"]
}
```

**Step 1 — failing test:**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { migrateM1 } from '../src/db/schema.ts';
import { registerTemplateRoutes } from '../src/routes/templates.ts';

let db: Database.Database; let app: FastifyInstance;
beforeEach(async () => {
  db = new Database(':memory:'); migrateM1(db);
  app = Fastify();
  registerTemplateRoutes(app, db);
  await app.ready();
});
afterEach(async () => { await app.close(); db.close(); });

function seed(id: string, name: string, steps: unknown[], opts: { tags?: string[]; app?: string } = {}): void {
  db.prepare(`INSERT INTO templates(id, name, udid, steps_json, app_bundle_id, tags_json, created_by, created_at, updated_at)
              VALUES (?, ?, 'sim', ?, ?, ?, 'qa', 0, 0)`)
    .run(id, name, JSON.stringify(steps), opts.app ?? null, JSON.stringify(opts.tags ?? []));
}

describe('GET /api/templates/vocabulary', () => {
  it('aggregates selectors with uses + source cases, ranked by uses', async () => {
    seed('tpl_1', 'tnc', [
      { idx: 0, action: 'tap', x: 1, y: 2, selector: { label: 'Beranda' } },
      { idx: 1, action: 'expect', selector: { label: 'Beranda' } },
      { idx: 2, action: 'tap', x: 3, y: 4, selector: { identifier: 'ic_barcode' } },
    ], { tags: ['smoke'] });
    seed('tpl_2', 'scan', [
      { idx: 0, action: 'tap', x: 5, y: 6, selector: { label: 'Beranda' } },
    ], { app: 'com.x.y', tags: ['smoke', 'regression'] });
    const r = await app.inject({ method: 'GET', url: '/api/templates/vocabulary' });
    expect(r.statusCode).toBe(200);
    const b = r.json() as { selectors: Array<{ value: string; kind: string; uses: number; cases: string[] }> };
    const ber = b.selectors.find((s) => s.value === 'Beranda')!;
    expect(ber.uses).toBe(3);
    expect(ber.cases).toEqual(['tnc', 'scan']);
    // ranked: Beranda(3) before ic_barcode(1)
    expect(b.selectors[0]!.value).toBe('Beranda');
  });

  it('caseNames exclude nothing (all names — even 1-step cases); apps/tags distinct', async () => {
    seed('tpl_1', 'tnc', [{ idx: 0, action: 'scroll', direction: 'down' }], { tags: ['smoke'] });
    seed('tpl_2', 'other', [{ idx: 0, action: 'scroll', direction: 'up' }], { app: 'com.a.b', tags: ['smoke', 'rc'] });
    const b = (await (await app.inject({ method: 'GET', url: '/api/templates/vocabulary' })).json()) as
      { caseNames: string[]; apps: string[]; tags: string[] };
    expect(b.caseNames).toEqual(['tnc', 'other']);
    expect(b.apps).toEqual(['com.a.b']);
    expect(b.tags).toEqual(['smoke', 'rc']);
  });

  it('tolerates malformed steps_json (skips bad rows)', async () => {
    db.prepare(`INSERT INTO templates(id, name, udid, steps_json, tags_json, created_by, created_at, updated_at)
                VALUES ('tpl_bad', 'bad', 'sim', '{not json', '[]', 'qa', 0, 0)`).run();
    const r = await app.inject({ method: 'GET', url: '/api/templates/vocabulary' });
    expect(r.statusCode).toBe(200);   // never 500s on bad data
  });
});
```

**Step 2 — verify failure** (route 404s).
**Step 3 — implement** in templates.ts:

```ts
  /** Vocabulary for the YAML editor's autocomplete: every distinct selector
   *  (label + identifier) ever recorded with usage counts and source cases,
   *  plus case names (runFlow targets), bundle ids, tags. One fetch per
   *  editor open; pure aggregation, no device contact. */
  app.get('/api/templates/vocabulary', async () => {
    const rows = db.prepare('SELECT name, steps_json, app_bundle_id, tags_json FROM templates').all() as
      Array<{ name: string; steps_json: string; app_bundle_id: string | null; tags_json: string | null }>;
    const selMap = new Map<string, { value: string; kind: 'label' | 'identifier'; uses: number; cases: Set<string> }>();
    const caseNames: string[] = [];
    const apps = new Set<string>();
    const tags = new Set<string>();
    for (const r of rows) {
      caseNames.push(r.name);
      if (r.app_bundle_id) apps.add(r.app_bundle_id);
      for (const t of (JSON.parse(r.tags_json ?? '[]') as unknown[])) if (typeof t === 'string' && t.trim()) tags.add(t.trim());
      try {
        for (const s of JSON.parse(r.steps_json) as Array<Record<string, unknown>>) {
          const sel = s['selector'] as { label?: unknown; identifier?: unknown } | undefined;
          for (const [k, kind] of [['label', 'label'], ['identifier', 'identifier']] as const) {
            const v = sel?.[k];
            if (typeof v === 'string' && v.trim()) {
              const key = `${kind}:${v}`;
              const e = selMap.get(key) ?? { value: v, kind, uses: 0, cases: new Set<string>() };
              e.uses += 1; e.cases.add(r.name);
              selMap.set(key, e);
            }
          }
        }
      } catch { /* malformed steps_json — skip row's selectors */ }
    }
    return {
      selectors: [...selMap.values()]
        .sort((a, b) => b.uses - a.uses || a.value.localeCompare(b.value))
        .map((e) => ({ value: e.value, kind: e.kind, uses: e.uses, cases: [...e.cases] })),
      caseNames,
      apps: [...apps],
      tags: [...tags],
    };
  });
```

**Step 4 — verify pass.** **Step 5 — commit:** `feat(yaml-editor): vocabulary aggregation endpoint`

---

## Task 3: Completion source (pure) + CM wiring

**Objective:** `buildCompletions(slot, vocab, typed)` → `Completion[]` (pure, testable), then wire `autocompletion()` into `useYamlEditor` with vocabulary injected via a new `mount` parameter.

**Files:**
- Create: `web/src/lib/yaml-completions.ts`
- Test: `server/test/../..` — NO: web has no vitest. Pure module tested via a tiny node script? **Decision:** put the pure builder in `shared/src/yaml-completions.ts` (workspace package — testable from server vitest like yaml-slots), and the CM glue stays in `web/src/composables/useYamlEditor.ts` (verified by Playwright drill in Task 4).
- Modify: `web/package.json` (+`@codemirror/autocomplete`), `web/src/composables/useYamlEditor.ts`, `web/src/components/CaseEditorPanel.vue` (fetch vocabulary, pass to mount)

**Step 1 — failing test** (`server/test/yaml-completions.test.ts`):

⚠ **quoting decision (resolved during self-review):** `apply` is the FINAL doc text. For value slots the dropdown `label` shows the RAW value, `apply` = `yamlQuote(value)` — EXCEPT when the cursor sits inside an already-open quote (then `apply` = raw value, else we'd double-quote). Tests encode that contract via `yamlQuote(...)` calls, not hardcoded strings:

```ts
import { describe, it, expect } from 'vitest';
import { buildCompletions, type EditorVocabulary } from '@crucible/shared/yaml-completions';
import { yamlQuote } from '@crucible/shared/case-yaml';

const vocab: EditorVocabulary = {
  selectors: [
    { value: 'Beranda', kind: 'label', uses: 3, cases: ['tnc', 'scan'] },
    { value: 'ic_barcode', kind: 'identifier', uses: 1, cases: ['scan'] },
  ],
  caseNames: ['tnc', 'login-flow'],
  apps: ['com.lioparcel.services.consumer.int-dev'],
  tags: ['smoke', 'regression'],
};

describe('buildCompletions', () => {
  it('top-key offers the four top-level keys with detail text', () => {
    const cs = buildCompletions('top-key', vocab, '');
    expect(cs.map((c) => c.label)).toEqual(['name', 'tags', 'app', 'steps']);
    expect(cs.every((c) => c.detail)).toBe(true);
  });

  it('step-action offers skeletons with point placeholders', () => {
    const cs = buildCompletions('step-action', vocab, '');
    const tap = cs.find((c) => c.label === 'tap')!;
    expect(String(tap.apply)).toContain('point: [');      // skeleton, not bare word
    expect(String(tap.apply)).toContain('on: ');
    expect(cs.map((c) => c.label)).toEqual(['tap', 'scroll', 'type', 'runFlow', 'expect']);
  });

  it('direction offers exactly the four directions', () => {
    expect(buildCompletions('direction', vocab, '').map((c) => c.label)).toEqual(['up', 'down', 'left', 'right']);
  });

  it('body-key for tap offers point/on/optional (no text)', () => {
    expect(buildCompletions('body-key', vocab, '', 'tap').map((c) => c.label)).toEqual(['point', 'on', 'optional']);
  });
  it('body-key for type adds text', () => {
    expect(buildCompletions('body-key', vocab, '', 'type').map((c) => c.label)).toEqual(['point', 'text', 'on', 'optional']);
  });

  it('on-value: label = raw value, apply = yamlQuote(value), detail carries uses + cases', () => {
    const cs = buildCompletions('on-value', vocab, 'Be');
    const ber = cs.find((c) => c.label === 'Beranda')!;
    expect(ber.apply).toBe(yamlQuote('Beranda'));          // 'Beranda' — plain-safe stays unquoted
    expect(ber.detail).toContain('label');
    expect(ber.detail).toContain('3');
    expect(ber.detail).toContain('tnc');
  });

  it('on-value quotes hostile labels on apply', () => {
    const v2 = { ...vocab, selectors: [{ value: 'Log in to get the best rates.', kind: 'label', uses: 1, cases: ['x'] }] };
    const c = buildCompletions('on-value', v2, 'Log').find((x) => x.label.includes('Log'))!;
    expect(c.apply).toBe(yamlQuote('Log in to get the best rates.'));   // quoted — validator-safe
  });

  it('runflow-name offers case names quoted; app-value offers bundle ids; tag-value offers tags', () => {
    expect(buildCompletions('runflow-name', vocab, '').map((c) => c.apply)).toEqual(vocab.caseNames.map(yamlQuote));
    expect(buildCompletions('app-value', vocab, '').map((c) => c.label)).toEqual(vocab.apps);
    expect(buildCompletions('tag-value', vocab, '').map((c) => c.label)).toEqual(vocab.tags);
  });

  it('empty vocabulary → value slots return [] (grammar slots unaffected)', () => {
    const empty: EditorVocabulary = { selectors: [], caseNames: [], apps: [], tags: [] };
    expect(buildCompletions('on-value', empty, '')).toEqual([]);
    expect(buildCompletions('direction', empty, '').length).toBe(4);
  });
});
```

Skeletons (step-action slot) — `apply` templates (cursor lands after insert; keep them one-line, matching caseToYaml shapes):

```
tap:     tap: { point: [0, 0], on: '' }
scroll:  scroll: down
type:    type: { text: '', on: '' }
runFlow: runFlow: { name: '' }
expect:  expect: ''
```

(`''` placeholders parse as valid yaml per yamlScalar — empty string quotes to `''` — so a freshly-inserted skeleton validates with only "needs point/label" style errors at most. The doc comment must say: placeholders are deliberately valid-but-empty so validation guides filling them.)

CM6 `Completion` shape (structural, no import needed in shared — keep it type-structural):

```ts
export interface VocabCompletion {
  label: string;          // dropdown text (raw value / key / skeleton label)
  detail?: string;        // right-aligned: kind · uses · source cases
  apply: string;          // FINAL inserted text (quoted for value slots)
  type?: 'keyword' | 'text' | 'function';  // CM icon class hint
  boost?: number;         // negative = lower rank
}
```

`buildCompletions(slot, vocab, typed, action?)` — `action` scopes body-key sets (tap/type/expect/runFlow differ). Filtering by `typed` is CM's job (fuzzy match built in) — `buildCompletions` returns the FULL set for the slot; do not pre-filter (keeps the function trivial and CM's ranking intact).

**Step 2 — verify failure.**
**Step 3 — implement** `shared/src/yaml-completions.ts` + export from the package index ([VERIFY] how `@crucible/shared` exposes modules — check its package.json exports map; likely `./case-yaml` subpath style — mirror it with `./yaml-slots` and `./yaml-completions`).

**Step 4 — verify pass.**
**Step 5 — commit:** `feat(yaml-editor): pure completion builder (slot × vocabulary)`

**Package wiring (both shared modules):** `shared/package.json` `exports` gains `"./yaml-slots": "./src/yaml-slots.ts"` and `"./yaml-completions": "./src/yaml-completions.ts"` — the map currently only exposes `.` and `./case-yaml`; without subpath entries imports fail under `module: nodenext` (this is the EXACT class the yaml-test-cases session hit). `EditorVocabulary` type lives in `yaml-completions.ts` and mirrors the endpoint's response shape exactly.

---

## Task 4: Editor wiring — autocompletion in useYamlEditor + panel fetch

**Objective:** The editor offers completions; vocabulary loads once per panel open.

**Files:**
- Modify: `web/package.json` (+`@codemirror/autocomplete@^6.20.3`), install
- Modify: `web/src/composables/useYamlEditor.ts`:
  - `mount(el, initial, onSave, vocab?: EditorVocabulary)` — new optional 4th param; default = grammar-only completions (endpoint down or old caller → still useful)
  - dynamic-import `@codemirror/autocomplete` alongside the others; extensions gain `autocompletion({ override: [source] })`
  - the source: `(ctx) => { const slot = slotAt(docText, ctx.pos); if (slot === 'none') return null; return { from, options } }` — `from` = word-start before cursor (CM contract: complete from the typed prefix; for value slots with an open quote, start AFTER the quote char). Compute `from` by scanning back from `ctx.pos` to the last char in `[\s,{[:\[]`+1 — [VERIFY] against CM docs behavior with `explicit: true` (Ctrl-Space) too.
- Modify: `web/src/components/CaseEditorPanel.vue`: on open, `fetch('/api/templates/vocabulary')` (best-effort, catch → undefined) and pass to `mount` — the call site is `CaseEditorPanel.vue:97` (`await ed.mount(editorHost.value, yaml, save)` gains the 4th arg; [VERIFIED] single call site).

**Keymap:** add `completionKeymap` (from the autocomplete package) after defaultKeymap so Tab/arrows/Enter behave inside the dropdown. ⚠ Enter-accept vs ⌘↵ save must not collide — completionKeymap's Enter only fires when a completion is ACTIVE (CM handles this); verify in the drill.

**Verification (Step: Playwright drill):**
1. Open the tnc case editor; type `  - ` on a fresh line under steps → dropdown shows the 5 skeletons.
2. Pick `tap` → skeleton inserted with placeholders.
3. On a `on: ` value type `Be` → dropdown shows `Beranda` (uses 3 · tnc, scan); Enter → inserted as `Beranda` (unquoted — plain-safe) or quoted if it contains special chars.
4. Type `scroll: ` → 4 directions only.
5. ⌘↵ still saves (no completion interference).
Fresh navigation before declaring done (HMR rule). Screenshot + vision for the dropdown rendering (Axiom: dark dropdown, readable).

**Commit:** `feat(yaml-editor): slot-aware autocompletion wired into the editor`

---

## Task 5: Guide + skill close-out

- GuidePage "yaml editing" card: add a meta-row — "autocomplete: the editor knows the format AND your app — labels, identifiers, case names, and tags come from your own recorded cases; ⌃Space opens the list; values insert pre-quoted".
- crucible SKILL.md: append to the yaml-test-cases bullet — completions design (slots × vocabulary), the shared-package location of the pure parts, the endpoint, and the drill findings.

---

## Verification gates (every task)

```bash
cd ai/crucible/server && pnpm typecheck && pnpm lint && npx vitest run
cd ai/crucible/web && npx vue-tsc --noEmit && node node_modules/vite/bin/vite.js build
```

⛔ Gate commits on the gate's OWN exit code; never piped (skill rule).

## Edge cases analyzed

| # | Case | Behavior |
|---|---|---|
| 1 | Vocabulary endpoint down / old caller | `mount` without vocab → grammar-only completions (keys, actions, directions, skeletons). Editor never breaks. |
| 2 | Cursor inside quotes (`on: 'Ber`) | Slot still `on-value` (regex tolerates the quote); `from` lands after the opening quote; `apply` is unquoted-in-quote → picking `Beranda` completes `'Beranda'`. ⚠ test this case explicitly in the drill — quote-in-quote double-quoting is the classic bug here. Resolution rule: if the char before `from` is a quote, apply RAW value (no yamlQuote). |
| 3 | Empty templates DB | Empty vocab lists → value slots show no suggestions (grammar still works). |
| 4 | Malformed steps_json rows | Route skips them (tested); editor unaffected. |
| 5 | Label containing a quote (`It's`) | `yamlQuote` doubles it (`'It''s'`) — apply carries the escaped form; validator accepts (same function). |
| 6 | Cursor mid-line (not at EOL) | `slotAt` uses text BEFORE cursor only — classification is prefix-safe; CM handles the rest of the line. |
| 7 | Same label as label AND identifier (e.g. `settings` matches the id regex) | Both entries appear, distinguished by `kind` in `detail` (label · identifier). Dedup NOT attempted — ambiguity visible beats hidden. |
| 8 | Large DB (hundreds of cases) | Endpoint is one table scan + JSON parse per row — fine locally; completions list capped visually by CM's max-render. |
| 9 | User typed a full valid value already | CM's fuzzy filter still shows it as the top match; Enter accepts what's typed. No harm. |
| 10 | runFlow referencing the case ITSELF | Vocabulary includes its own name (route doesn't exclude) — playback's cycle guard (depth cap) already handles self/loop refs. Completion is not the enforcement layer. |
| 11 | `apply` for skeletons contains `''` placeholders | Deliberate (valid-but-empty); save-time validation guides filling. Documented in the module. |
| 12 | Enter accepting a completion vs ⌘↵ save | completionKeymap's Enter is shadowed while the dropdown is open; ⌘↵ (Mod-Enter) never conflicts. Drill case 5 proves it. |
| 13 | Names with `: ` or leading `-` (yaml-hostile case names) | `yamlQuote` handles both (test: `'dev: login'` round-trips through the validator). |

## Risks / tradeoffs

- **Regex slot-classification can misfire on hand-written exotic yaml** — fails safe (`'none'` → no suggestions). The format is line-shaped by construction; AST parsing is the escalation if real usage produces misfires.
- **Vocabulary freshness** — fetched once per panel open; a run recorded in another tab isn't in the list until reopen. Acceptable v1; refresh-on-focus is a two-line follow-up.
- **`@codemirror/autocomplete` adds ~15KB gz to the lazy editor chunk only** — main bundle untouched (editor is already lazy).

## Plain-English summary

The case editor gets autocomplete that knows two things: the yaml FORMAT (so typos in keys and actions stop happening — pick a skeleton instead) and YOUR APP'S VOCABULARY (every label, icon identifier, case name, and tag you've ever recorded — so you stop switching tabs to look up "what was that button called"). It appears as you type in the right places, inserts values correctly quoted, and works even when the vocabulary service is unreachable (grammar still completes).
