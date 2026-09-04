# `contains:` + `ignoreCase:` Matching Modes Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** `contains: 'DATA COLLECTION'` matches nodes whose label *contains* the string, and `ignoreCase: true` makes any label matching case-insensitive — for `expect`, `tap` confirmation, and `type` targeting alike — as an authoring escape hatch for exact-match brittleness (section-numbered headings, reworded copy, partial labels, case drift).

**Architecture:** One semantic change in the shared predicate (`matchesSelector` gains a per-field `contains` mode), one representation change (the `contains:` body key rides from YAML into a `labelContains` field on the selector — NOT a runtime string re-parse), same exactly-one-match assertion discipline everywhere. Surfaces touched: selector predicate + probe, yaml parse/serialize round-trip, autocomplete (body-key + contains-value slots), run-detail rendering, guide.

**Tech Stack:** @crucible/shared (predicate types live server-side but the YAML round-trip is shared), server vitest, one live drill.

**Semantics (settled in discussion):**

| Aspect | Decision |
|---|---|
| Syntax | **`contains:` — a step-BODY key naming the matching mode** (user design, adopted over the `~` sigil in review): `- expect: { contains: 'DATA COLLECTION' }`. Works alongside `on:` wherever `on:` works (expect, tap confirmation, type targeting); `on:` + `contains:` on one step = parse error (one target) |
| Matching | label **contains** the value, case-SENSITIVE by default |
| Case | **`ignoreCase: true` — a step-BODY key (camelCase), orthogonal to the mode**: composes into a 2×2 matrix (on-exact / contains × sensitive / insensitive). Applies to `label` AND `labelContains` matching. NEVER applies to identifiers (asset ids are code constants — `ignoreCase` + identifier `on:` = parse error). `false`/absent = sensitive; the serializer never emits `ignoreCase: false`. The scalar `- expect: X` sugar carries no flags (exact-cs only) — mapping form required for `contains`/`ignoreCase` |
| Uniqueness | UNCHANGED — pass ⟺ exactly 1 distinct element (after the 04335ff same-rect dedup). A too-broad `contains` matching 4 headings = honest `ambiguous (4 matches)` |
| Scope | `contains:` is label-ONLY by construction (its key names the label operation — no routing ambiguity to guard, unlike a sigil). Identifiers stay exact via `on:` |
| Recorder | NEVER auto-emits `contains` (recorded selectors capture exact labels). It's hand-authored intent — as is `ignoreCase` |
| Env substitution | selector labels are NOT `${env}`-substituted today (only `text` and `runFlow` names are — substituteStep passes selector through); `contains` changes nothing there. Out of scope; noted in Task 6 |

---

## Current state (verified in code, 2026-09-04)

- Predicate: `server/src/manual/selector.ts:56` `matchesSelector` — `sel.label === undefined || n.label === sel.label` (exact `===`). Used by BOTH `countMatches` (expect/probe) and `resolveSelector` (tap confirmation) — one predicate, two pool policies.
- `countMatches` (selector.ts:63) dedups by rect origin as of 04335ff — contains-matching composes with that dedup naturally (filter first, then dedup).
- Yaml parse: `shared/src/case-yaml.ts:118-124` — `on:` → `{identifier}` iff `/^[a-z][a-z0-9_]*$/` else `{label}`. Scalar expect (`- expect: X`) → `{label: X}` (line 156). The `contains:` key slots in as a sibling body key — no routing ambiguity, no prefix stripping.
- Yaml serialize: `caseToYaml` line 209-213 — `on:` emits `sl.label ?? sl.identifier` raw. A `labelContains` field needs its own emission (`contains:` key).
- `YamlSelector` (shared) and `StepSelector` (server) are STRUCTURALLY IDENTICAL duplicates (`{identifier?, label?, type?}`) — both gain `labelContains?`, kept in lockstep manually (no import between them today; do NOT couple them now).
- Probe: `manualProbeSelector` (session.ts:235) takes the selector object and calls `countMatches` — contains flows through with zero changes once the predicate knows the field.
- Recorder commit gate: `recordExpectStep` (session.ts:252) appends whatever selector it's given; the sidebar's check-then-commit UX stays exact-only (recorder never emits `contains`).
- Playback expect: playback.ts:~469 `countMatches(nodesL, s.selector!)` — no change needed (predicate-level).
- evaluated_json / RunDetail rendering: `expect ${label ?? identifier}` (RunDetailPage.vue:55) — needs a mode-aware display for contains selectors (else the run detail shows a bare fragment with no indication it was a contains match).
- substituteStep passes `selector` through untouched (template-env.ts:30) — contains composes for free.
- Autocomplete `on-value` slot: `buildCompletions('on-value', …)` offers recorded labels raw. `contains:` joins the BODY-KEY sets (per-action legal keys) — value completions after it reuse the label vocabulary.

---

## Task 1: Predicate — `labelContains` + `ignoreCase` in `matchesSelector`

**Objective:** The one semantic change; everything else is plumbing.

**Files:**
- Modify: `server/src/manual/selector.ts` (StepSelector + matchesSelector + selectorLabel helper)
- Test: `server/test/selector.test.ts` (extend)

**Step 1 — failing tests:**

```ts
describe('matchesSelector — labelContains (contains: mode)', () => {
  const node = (label: string): SnapNode => ({ type: 'StaticText', label, rect: { x: 1, y: 1, width: 5, height: 5 } });

  it('contains matches substring, case-sensitive', () => {
    expect(matchesSelector(node('II. DATA COLLECTION'), { labelContains: 'DATA COLLECTION' })).toBe(true);
    expect(matchesSelector(node('II. DATA COLLECTION'), { labelContains: 'II. DATA' })).toBe(true);
    expect(matchesSelector(node('II. Data Collection'), { labelContains: 'DATA COLLECTION' })).toBe(false); // case
    expect(matchesSelector(node('DATA COLLECTION'), { labelContains: 'data collection' })).toBe(false);
  });
  it('contains composes with countMatches dedup: two same-rect exposures of one heading count 1', () => {
    const nodes = [
      node('II. DATA COLLECTION'),                      // rect (1,1)
      { type: 'Other', label: 'II. DATA COLLECTION', rect: { x: 1, y: 1, width: 9, height: 9 } }, // same origin → dedup
      node('III. DATA MANAGEMENT'),                     // different position
    ];
    expect(countMatches(nodes, { labelContains: 'DATA' })).toBe(2); // heading II + heading III, dedup applied
  });
  it('contains still requires uniqueness to pass — probe reports honest counts', () => {
    const nodes = [node('DATA COLLECTION'), node('DATA MANAGEMENT, USE & DISCLOSURE')];
    expect(countMatches(nodes, { labelContains: 'DATA' })).toBe(2);
    expect(countMatches(nodes, { labelContains: 'COLLECTION' })).toBe(1);
  });
  it('labelContains and label are mutually exclusive at the TYPE level (never both set)', () => {
    // the type allows it; the yaml parser guarantees it; the predicate ignores
    // label when labelContains is set (defensive, documented)
    expect(matchesSelector(node('II. DATA COLLECTION'), { labelContains: 'DATA', label: 'nope' } as StepSelector)).toBe(true);
  });
  it('exact selectors unchanged (regression)', () => {
    expect(matchesSelector(node('Beranda'), { label: 'Beranda' })).toBe(true);
    expect(matchesSelector(node('Beranda'), { label: 'Beranda ' })).toBe(false);
  });
});

describe('matchesSelector — ignoreCase (case-insensitive mode)', () => {
  const node = (label: string): SnapNode => ({ type: 'StaticText', label, rect: { x: 1, y: 1, width: 5, height: 5 } });

  it('ignoreCase composes with EXACT label matching', () => {
    expect(matchesSelector(node('Beranda'), { label: 'BERANDA', ignoreCase: true })).toBe(true);
    expect(matchesSelector(node('BERANDA'), { label: 'beranda', ignoreCase: true })).toBe(true);
    expect(matchesSelector(node('Beranda'), { label: 'BERANDA' })).toBe(false); // flag absent = sensitive (regression)
  });
  it('ignoreCase composes with CONTAINS matching', () => {
    expect(matchesSelector(node('II. Data Collection'), { labelContains: 'DATA COLLECTION', ignoreCase: true })).toBe(true);
    expect(matchesSelector(node('II. Data Collection'), { labelContains: 'data collection', ignoreCase: true })).toBe(true);
    expect(matchesSelector(node('II. Data Collection'), { labelContains: 'data collection' })).toBe(false);
  });
  it('ignoreCase NEVER applies to identifiers (code constants)', () => {
    // predicate level: identifier compare stays exact regardless of the flag
    const ic: SnapNode = { type: 'Image', identifier: 'ic_Barcode', rect: { x: 1, y: 1, width: 5, height: 5 } };
    expect(matchesSelector(ic, { identifier: 'ic_barcode', ignoreCase: true })).toBe(false);
    expect(matchesSelector(ic, { identifier: 'ic_Barcode', ignoreCase: true })).toBe(true);
  });
  it('type matching is unaffected by ignoreCase (type ids are code constants)', () => {
    expect(matchesSelector({ type: 'StaticText', label: 'X', rect: { x: 1, y: 1, width: 5, height: 5 } }, { label: 'X', type: 'statictext', ignoreCase: true })).toBe(false);
  });
});

describe('selectorLabel (human rendering)', () => {
  it('contains marker for contains-mode; plain for exact; ? for empty', () => {
    expect(selectorLabel({ labelContains: 'DATA' })).toBe('contains: DATA');
    expect(selectorLabel({ label: 'Beranda' })).toBe('Beranda');
    expect(selectorLabel({ identifier: 'ic_barcode' })).toBe('ic_barcode');
    expect(selectorLabel({})).toBe('?');
  });
  it('ignoreCase renders as a suffix marker', () => {
    expect(selectorLabel({ labelContains: 'DATA', ignoreCase: true })).toBe('contains: DATA (ignore case)');
    expect(selectorLabel({ label: 'Beranda', ignoreCase: true })).toBe('Beranda (ignore case)');
  });
});
```

(`matchesSelector` needs exporting for direct tests — it IS exported at selector.ts:56. `selectorLabel` is new — exported.)

**Step 2 — verify failure** → **Step 3 — implement:**

```ts
export interface StepSelector { identifier?: string; label?: string; labelContains?: string; ignoreCase?: boolean; type?: string }

/** Shared match PREDICATE … labelContains (the `contains:` yaml key) = substring match;
 *  ignoreCase lowercases BOTH sides for label/labelContains ONLY —
 *  identifiers and types are code constants and never case-fold.
 *  labelContains takes precedence over label when both are present (the
 *  parser never emits both — defensive order here). */
export function matchesSelector(n: SnapNode, sel: StepSelector): boolean {
  if (sel.identifier !== undefined && n.identifier !== sel.identifier) return false;
  const fold = (s: string): string => (sel.ignoreCase === true ? s.toLowerCase() : s);
  if (sel.labelContains !== undefined) {
    if (typeof n.label !== 'string' || !fold(n.label).includes(fold(sel.labelContains))) return false;
  } else if (sel.label !== undefined && fold(n.label ?? '') !== fold(sel.label)) return false;
  return sel.type === undefined || n.type === sel.type;
}

/** Human form of a selector for run steps/reasons: `contains: frag` for
 *  contains-mode, ` (ignore case)` suffix when the flag is set. */
export function selectorLabel(sel: StepSelector): string {
  const base = sel.labelContains !== undefined ? `contains: ${sel.labelContains}` : sel.label ?? sel.identifier ?? '?';
  return sel.ignoreCase === true ? `${base} (ignore case)` : base;
}
```

**Step 4 — verify pass** (new + all existing selector/expect suites). **Step 5 — commit:** `feat(selectors): labelContains + ignoreCase predicate — ~ substring, case-folded matching`

---

## Task 2: YAML round-trip — `contains:` key ↔ `labelContains`, `ignoreCase:` key ↔ flag

**Objective:** Parse `contains: x` → `{labelContains: x}` and `ignoreCase: true` → flag; serialize back; validation errors for misuse.

**Files:**
- Modify: `shared/src/case-yaml.ts` (YamlSelector + the `sel()` router + scalar-expect + caseToYaml emission + body-key whitelist)
- Test: `server/test/case-yaml.test.ts` (extend)

**Parse rules (the `sel()` router, replacing lines 118-124):**

```ts
const sel = (b: Record<string, unknown>): YamlSelector | undefined => {
  const on = b['on'];
  const contains = b['contains'];
  const rawIc = b['ignoreCase'];
  if (rawIc !== undefined && rawIc !== true && rawIc !== false) {
    errors.push({ line: 1, message: `step ${i + 1}: ignoreCase must be true or false (got ${JSON.stringify(rawIc)})` });
    return undefined;
  }
  const ignoreCase = rawIc === true;   // false normalizes away
  if (on !== undefined && contains !== undefined) {
    errors.push({ line: 1, message: `step ${i + 1}: 'on' and 'contains' are mutually exclusive — one target per step` });
    return undefined;
  }
  if (contains !== undefined) {
    if (typeof contains !== 'string' || !contains.trim()) {
      errors.push({ line: 1, message: `step ${i + 1}: 'contains' needs a non-empty fragment` });
      return undefined;
    }
    return { labelContains: contains.trim(), ...(ignoreCase ? { ignoreCase: true } : {}) };
  }
  if (typeof on === 'string' && on.trim()) {
    const v = on.trim();
    if (/^[a-z][a-z0-9_]*$/.test(v)) {
      if (ignoreCase) errors.push({ line: 1, message: `step ${i + 1}: ignoreCase never applies to identifiers (asset ids are exact); use 'contains' or a label` });
      return { identifier: v };
    }
    return { label: v, ...(ignoreCase ? { ignoreCase: true } : {}) };
  }
  return undefined;
};
```

Note: BOTH `contains` and `ignoreCase` must join the **body-key whitelist** at case-yaml.ts:159 (`['point','on','text','optional','id','name']` → `+ 'contains', 'ignoreCase'`) or every flag-using step errors "unknown key".

The **scalar expect** form is untouched (`- expect: X` → exact label — sugar carries no flags, no contains; documented).

**Serialize (`caseToYaml` emission — contains renders as its own key, flags after):**

```ts
// selector value emission: labelContains renders via the 'contains' key
const selKey = (sel: unknown): { key: string; value: string } | undefined => {
  const sl = sel as YamlSelector | undefined;
  if (!sl) return undefined;
  if (sl.labelContains !== undefined) return { key: 'contains', value: sl.labelContains };
  if (sl.label !== undefined) return { key: 'on', value: sl.label };
  if (sl.identifier !== undefined) return { key: 'on', value: sl.identifier };
  return undefined;
};
// flag suffix (only when true — never emit false):
const icSuffix = (sel: unknown): string => ((sel as YamlSelector | undefined)?.ignoreCase === true ? ', ignoreCase: true' : '');
// emission order pinned: point, text, on/contains, ignoreCase, optional
```

⚠ serializer composition detail: `optSuffix` currently appends `, optional: true`; `icSuffix` comma-joins the same way. Keep emission order stable: `point, text, on|contains, ignoreCase, optional` (tests pin it).

**Validation additions (errors, not silent):**
- `on:` + `contains:` on the same step → error (mutually exclusive — one target)
- `contains: ''` / non-string → error (`needs a non-empty fragment`)
- `ignoreCase: true` + identifier `on:` → error (asset ids never case-fold)
- `ignoreCase: <non-boolean>` → error (`must be true`; `false` normalizes away)
- `{label: x, labelContains: y}` cannot arrive from YAML (parser emits one or the other) — no extra check needed at this layer

**Tests (round-trip + errors):**

```ts
it('parses contains: X → labelContains; serializes back as contains: key', …);
it('parses ignoreCase: true → flag on label and contains forms; serializes back as body key', …);
it('ignoreCase: false normalizes away (serializer omits; parse treats as absent)', …);
it('on + contains on one step → parse error (mutually exclusive)', …);
it('contains: "" → error', …);
it('ignoreCase + identifier on: → parse error', …);
it('ignoreCase: "yes" (non-bool) → parse error', …);
it('scalar expect X unchanged (sugar carries no flags) (regression)', …);
it('exact/identifier parsing unchanged (regression)', …);
it('round-trip: parse(caseToYaml(step)) === step for all selector kinds × flags', …);
```

**Commit:** `feat(case-yaml): contains + ignoreCase keys — parse/serialize round-trip + validation`

---

## Task 3: Playback + probe flow-through

**Objective:** Nothing to change in the happy path — verify it end-to-end with tests + the drill. The one real gap: **fail reasons must show the matching mode** or triage misreads the selector.

**Files:**
- Modify: `server/src/manual/playback.ts` (expect fail-reason formatting — find the `not found:`/`ambiguous` sites and mark contains-mode via the shared `selectorLabel` helper)
- Modify: `server/src/manual/playback.ts:76` **`stepName()`** — `expect ${label ?? identifier}` must become contains-aware via the shared `selectorLabel` helper (self-review catch: this feeds `run_steps.name`, the most-visible rendering surface — steps table, run panel)
- Modify: `web/src/pages/RunDetailPage.vue:55` (uses the shared selectorLabel helper — `expect contains: X` / `(ignore case)`)
- Test: `server/test/playback-expect.test.ts` (extend — contains pass + contains ambiguous cases)

**[VERIFIED during self-review — three render sites, not two]** every place a selector becomes human text must be mode-aware or the UI lies by omission:
1. `playback.ts:76` `stepName()` — routed through `selectorLabel()`. This feeds `run_steps.name` (the steps table the panel lists) — the MOST visible surface, and the draft missed it.
2. `playback.ts:486-487` — fail reasons JSON.stringify the whole selector (`labelContains` lands in the JSON automatically = machine-OK); wrap with a readable form: `not found: contains: DATA COLLECTION ({"labelContains":…})`.
3. `RunDetailPage.vue:55` — the `↳ expect` provenance line: `expect.label ?? expect.identifier` → contains-aware.

Rendering goes through the ONE `selectorLabel()` helper defined in Task 1 (contains marker + `(ignore case)` suffix) — do NOT re-define it here; import it at all three sites.

Playback fail reasons (from the live data earlier): `` not found: {"label":"DATA COLLECTION"} `` and `` ambiguous (5 matches): {"label":…} `` — the selector is JSON.stringify'd. With `labelContains` in the object the JSON already carries it, but human-readable triage wants the mode visible at a glance; render as `contains: DATA COLLECTION` in the reason string (keep the JSON for machines).

**Tests:**

```ts
it('expect contains: passes when exactly one heading contains it', …);
it('expect contains: fails ambiguous (2) when two headings contain it — reason carries contains:', …);
it('expect contains: + ignoreCase passes against differently-cased screen text', …); // e.g. contains: 'data collection' finds 'II. DATA COLLECTION'
it('tap with contains: selector: confirmation path unaffected (resolvedBy unchanged)', …); // via existing tap-resolution harness
```

**Commit:** `feat(playback): contains-expect execution + mode-marked fail reasons`

---

## Task 4: Recorder/probe + run-detail rendering

Mostly verification (probe flows through the predicate). Two small UI touches:

- **RunDetailPage** (from Task 3) — the `↳ expect` line shows `contains: fragment · matched N`.
- **Recorder sidebar "assert screen contains…"**: the CHECK (probe) box gains nothing — contains is not authorable there (recorded asserts stay exact; `contains` is hand-authored). But the probe ROUTE accepts `labelContains` selectors so API users can pre-flight a fragment they intend to paste into yaml: `manualProbeSelector` takes the selector object already — zero change; add one test proving `POST /api/manual/:id/probe-selector {selector: {labelContains: 'DATA'}}` returns the honest count.

**Commit:** `feat(run-detail): contains-aware rendering; probe accepts labelContains (verified)`

---

## Task 5: Autocomplete — `contains` and `ignoreCase` as body keys

**Objective:** The body-key completions already offer legal keys per action — `contains`/`ignoreCase` simply join the sets. Value-slot completions after `contains:` offer recorded labels (they're label fragments by definition).

**Files:**
- Modify: `shared/src/yaml-completions.ts` (BODY_KEYS sets + a `contains-value` source)
- Modify: `shared/src/yaml-slots.ts` (recognize `contains:` value position → new slot `contains-value`)
- Modify: `web/src/composables/useYamlEditor.ts` (map the new slot; pass the typed fragment to buildCompletions — currently hardcoded `''`)
- Test: `server/test/yaml-completions.test.ts` + `server/test/yaml-slots.test.ts` (extend)

Behavior:
- `body-key` for tap/type/expect gains `contains` (and `ignoreCase` where a label/contains selector is legal): typing `cont` inside `{ … }` offers `contains: ` with hint "label CONTAINS this text".
- `slotAt`: after `contains: ` (quoted or not) → `contains-value` slot; `buildCompletions('contains-value', vocab)` offers recorded labels as fragments (apply = yamlQuote(value); detail "contains fragment · uses N"). Identifiers are NOT offered (contains is label-only).
- The `on-value` slot is unchanged (exact vocabulary as today).

**Tests:**

```ts
it('body-key for expect offers on/contains/ignoreCase/optional', …);
it('body-key for tap offers point/on/contains/ignoreCase/optional', …);
it('slotAt classifies contains-value after "contains: "', …);
it('contains-value offers recorded LABELS only (no identifiers), quoted applies', …);
it('empty vocabulary → contains-value [] (grammar slots unaffected)', …);
```

**Commit:** `feat(yaml-editor): contains/ignoreCase completions + contains-value slot`

---

## Task 6: Guide + skill + drill close-out

- GuidePage "yaml editing": the `on:` row gains a sentence — "`contains:` instead of `on:` matches text CONTAINING the value (`contains: 'DATA COLLECTION'` catches `II. DATA COLLECTION`) — still needs exactly one match to pass". The body-keys row documents `ignoreCase: true` — "capitalization stops mattering for label matches (`on: beranda, ignoreCase: true`); never applies to asset ids".
- Skill: append to the expect/assertions bullets — the `contains:` + `ignoreCase` contract (2×2 matrix), the rect-dedup interaction, ignoreCase-never-folds-identifiers/types, recorder-never-emits rule, on/contains mutual exclusion.
- **Live drill (the motivating case):** edit `privacy policy` via the YAML API/UI to `expect: { contains: 'DATA COLLECTION' }`, play, expect **passed** (`contains` matches the single `II. DATA COLLECTION` heading after dedup — `I. DEFINITION` and `III. DATA MANAGEMENT…` do NOT contain the fragment, so uniqueness holds). Then a negative drill: `contains: 'DATA'` → honest `ambiguous (2)` (headings II and III both contain DATA). Then the case-insensitive drill: `expect: { contains: 'data collection', ignoreCase: true }` → **passed** (same single heading, folded). Screenshot the run detail showing `contains:`/`(ignore case)` in the provenance line.

**Env-substitution note (settled):** selector labels are NOT `${env}`-substituted today (only `text` and `runFlow` names are — verified in template-env.ts: selector passes through). `contains` changes nothing there; fragments with env vars would need that feature first. Out of scope; noted.

---

## Verification gates (every task)

```bash
cd ai/crucible/server && pnpm typecheck && pnpm lint && npx vitest run
cd ai/crucible/web && npx vue-tsc --noEmit && node node_modules/vite/bin/vite.js build
```

## Edge cases analyzed

| # | Case | Behavior |
|---|---|---|
| 1 | `contains: 'DATA'` matching several headings | `ambiguous (N)` — honest; the tool refuses to guess which one you meant |
| 2 | `contains:` + same-rect double-exposure | Dedup (04335ff) applies AFTER contains-filtering — one heading still counts once |
| 3 | Labels containing/starting with `~` | No special meaning anymore — plain exact labels via `on:`; the sigil design's escape hatch is moot |
| 4 | `contains: 'ic_barcode'` (identifier-looking fragment) | No parse error exists for this in the key design (the sigil needed one; the key names the operation, so intent is unambiguous) — it simply does a label-contains match, finds nothing, fails honest `not found` |
| 5 | `contains: ''` empty fragment | Parse error (`needs a non-empty fragment`) |
| 6 | Fragment with special yaml chars (`contains: 'Masuk: Daftar'`) | Quoted form; parser reads the value post-yaml — works |
| 7 | Case sensitivity surprises (`contains: 'data collection'` vs `DATA COLLECTION` screen text) | Fails not-found honestly — that's what `ignoreCase: true` is for |
| 8 | Recorder-probed asserts | Still exact-only; `contains` never auto-recorded |
| 9 | Probe route with labelContains | Works (predicate-level) — API users can pre-flight |
| 10 | Old clients reading new steps_json | `labelContains` unknown field → those consumers ignore it (structural types); playback of OLD cases unaffected (no field = exact) |
| 11 | Autocomplete inside quotes (`contains: 'Be`) | `from` lands after the opening quote (existing mechanism); contains-value slot test covers it |
| 12 | tap `contains:` confirmation | Same predicate — if exactly one node contains the fragment, confirmation holds; ambiguity → coordinate fallback as today (logged) |
| 13 | **`contains` + `on` on the same step** | Parse error (mutually exclusive) — replaces the sigil design's collision/escape class entirely |
| 14 | **Scalar expect form stays exact-only** | `- expect: X` sugar carries no flags or contains — mapping form required; regression-pinned |
| 15 | **API/storage sets labelContains directly** (bypassing yaml) | No parser guard applies — the predicate does a label-contains match regardless of fragment shape; works or fails honestly. API is a trusted surface, same as today's raw label values |
| 16 | **evaluated_json / API consumers expecting `{label}` only** | `expect: {labelContains}` field addition is additive JSON; RunDetail's type gains the field (Task 3). No migration — old runs lack the field, renderer falls back |
| 17 | **`ignoreCase` on the `expect` SCALAR form** | Impossible by construction (scalar has no body); the mapping form is required — error message when attempted on a mapping with a non-bool value |
| 18 | **`ignoreCase: true` + `type:` selector field** | Flag folds labels only; `type` stays exact (code constant) — predicate test pins this |
| 19 | **Turkish-i / locale folds** (`toLowerCase` is locale-sensitive in JS for a few codepoints) | Node's default fold is fine for app labels (ASCII-dominant); note only — a locale-aware fold is out of scope until a real case appears |
| 20 | **Serializer flag order** (`on, ignoreCase, optional` vs user-typed different order) | Parser is order-insensitive (yaml mapping); serializer emits ONE stable order and round-trip tests pin it — diffs stay clean |

## Risks / tradeoffs

- **Two structural selector types to keep in lockstep** (`YamlSelector` shared, `StepSelector` server) — pre-existing duplication; this adds one field to each. A unification refactor is tempting and OUT of scope.
- **Contains + label-reuse-heavy screens** (LP Home: "Login" ×3) — over-broad fragments fail ambiguous fast, which is the design working; the guide + autocomplete `contains` detail nudge toward precise fragments.
- **No case-insensitive option in v1** — ~~deliberate~~ **SUPERSEDED (this revision)**: matching modes ship as step-BODY keys (`contains:`, `ignoreCase:`) — user's design, adopted after challenging the `~` sigil: a body key is self-documenting, grep-able, joins the existing per-action key grammar AND the body-key autocomplete for free, and eliminates the sigil's whole error surface (escape hatches, prefix stripping, typed-mode detection). Storage was always going to be `selector.labelContains` — the sigil was surface syntax only.

## Plain-English summary

Today `on:` matches the exact, whole label. Write `contains:` instead and it matches any label CONTAINING the value — so `contains: 'DATA COLLECTION'` asserts the section heading even if its numbering (`II.`) changes. Add `ignoreCase: true` to the step and capitalization stops mattering — `contains: 'data collection'` then finds `II. DATA COLLECTION`. The two compose: pick contains or exact, sensitive or not. The rule stays strict about uniqueness in all four combinations: exactly one matching element on screen or the step fails honestly (zero = not found, many = ambiguous). Works in expects, tap confirmations, and the autocomplete; the recorder keeps capturing exact labels — `contains` and `ignoreCase` are things you type when you mean them.
