# YAML test cases — authoring format, editor, split panel

Date: 2026-09-03 · Status: APPROVED — building (design variant A2 chosen: viewport-locked split panel; includes the tier-2 coordinate-fallback scaling fix)
Scope: web + server. No engine changes.

---

## What is this plan about? (plain English)

Today a test case's steps are internal JSON — you can see them in the case
table's expander, but reading or changing them means clicking through rows of
checkboxes and inputs. This plan makes every case editable as **YAML text**,
Maestro-style: a plain, readable file you can read like a script and edit like
code — with syntax highlighting, in a **split panel** next to the case table
so you keep your context while editing.

The YAML is a *view and editor* for the same data — not a new storage format.
Storage stays `steps_json`; nothing about playback, plans, or evidence
changes. One source of truth, two editors (the step rows you have today, the
YAML split panel added by this plan).

---

## The YAML format (the definitions)

Case = metadata + ordered steps. Field names follow the INTERNAL step shape
(`action/x/y/direction/text/optional/selector/templateId`) so the mapping is
lossless in both directions — no third vocabulary to maintain.

```yaml
# flow.yaml — a Crucible test case
name: login and check home
tags: [smoke, login]
app: com.lionparcel.ios   # optional — defaults to the recorded binding
env:
  PASSWORD: ${env.PASSWORD}   # play-time values live OUTSIDE the case
steps:
  - tap:
      point: [214, 462]           # x, y — logical points
      on: Login                   # element label recorded at capture
  - scroll: down
  - type:
      text: ${env.USERNAME}
      on: Email field
  - runFlow: 6f3a...              # subflow by template id (or name: ref below)
  - expect: Home                  # assertion: label resolves to exactly 1
  - expect:
      on: Log in to get the best shipping rates.
      optional: true              # soft assert — miss = skip, run stays green
```

### Step schema (authoritative — mirrors `PlaybackStep` in playback.ts:31)

| YAML | Type | Notes |
|---|---|---|
| `tap` | `point: [x, y]`, `on: <label\|id>` (optional), `optional: true` | `on` maps to `selector {label}` or `{identifier}` |
| `scroll` | `up \| down \| left \| right` (scalar) | |
| `type` | `text: <string>`, `on:` (optional), `optional: true` | `${env.KEY}` resolved at play, missing key = fail before dispatch |
| `runFlow` | template NAME (scalar) or `{ name: ... , id: ...}` — verified: ids are `tpl_`+8hex (`tpl_a83b7ba1`), human-hostile; names resolve at save (collision → 409 listing both) | subflow; `optional` inherits to children; steps_json keeps the resolved id |
| `expect` | label/id scalar or `{ on:, optional: true }` | pass ⟺ exactly 1 match; `optional` = soft |

### Case-level fields

| Field | Notes |
|---|---|
| `name` | required; must be unique-ish (display truth, DB enforces id) |
| `tags` | list; normalized (trim/dedupe/max-8) on save — same rule as the table |
| `app` | bundle id; default = recorded binding; PATCH-able |
| `env` | **declarative reference only** — the VALUES never live in the case (B10). The editor validates the referenced keys exist at play time via the existing env textarea; storing values here is a lint ERROR, not a save-block |

### Round-trip rules (the invariants)

1. `steps_json` ⟷ YAML is **lossless for execution semantics**. Fields with
   no YAML surface (capture thumbnails `thumb`, timestamps `ts`) are dropped
   in YAML and ignored on import — they're authoring artifacts, not semantics.
2. `idx` is implicit (list order); renumbered on save.
3. Unknown YAML keys → validation error with line numbers (fail loud, never
   silently drop — a typo'd `optinal:` must not become a dropped step).
4. `${env.X}` inside `text` is preserved verbatim; validation checks it
   against the play-time env UI at run time (existing behavior).
5. A case edited as YAML and saved produces the same `steps_json` the step-row
   editor would have — one source of truth, proven by a round-trip test.

---

## The UX (split panel, syntax highlighting, safety)

### Layout

```
┌─ test cases ──────────────────────────────────────────────┐
│ [table: case · app · steps · updated · trend · verdict]   │
│                                                          │
│ ┌─ split panel (opens when a row's "yaml" action clicked) ┐│
│ │ ┌──────────────────┐ ┌───────────────────────────────┐ ││
│ │ │ steps (read-only │ │ yaml editor                   │ ││
│ │ │ outline)         │ │ syntax-highlighted            │ ││
│ │ │ 1 tap 214,462    │ │ save → validates → steps_json │ ││
│ │ │ 2 scroll down    │ │ </> copy                      │ ││
│ │ │ 3 expect Home ✓  │ │ ⌘↵ save                       │ ││
│ │ └──────────────────┘ └───────────────────────────────┘ ││
└──────────────────────────────────────────────────────────┘
```

- **Left: outline.** The parsed steps as the same kind-chip rows you know
  from the table expander (tap/scroll/type/expect/flow, numbered). Updates
  LIVE as you type (parse-on-type, debounced 300ms) — instant feedback that
  the YAML says what you think it says. Parse errors show inline under the
  editor, and the outline freezes on the last good parse (stale marker).
- **Right: the editor.** A highlighted YAML textarea (CodeMirror 6:
  yaml lang + one-dark-ish theme tuned to the Axiom palette). Line numbers,
  ⌘↵ save, `</>` copy button. Validation errors from the server arrive with
  YAML line numbers and are squiggled.
- **Entry points:** row hover action `yaml` (beside run/edit/delete) + the
  expander's `edit as yaml` link. Panel pushes content down (no overlay —
  the table stays visible for context; consistent with the env disclosure).
  `esc` closes, unsaved-changes guard on close/navigate.
- **Create:** `+ case (yaml)` in the page header starts a new case from a
  minimal template (`name:`, `steps: [- tap: …]`) — for hand-authoring
  without recording first.

### Why split panel beats modal

The user asked to "think of the UX": a modal covers the table — you lose the
case list you were browsing, and long YAML in a centered modal wastes width.
A split panel keeps the page context, uses full content width for the YAML
(long lines: `point: [214, 462]` fits), and lets the outline + editor share
one scroll container. The page already has an inline-expansion idiom (env
disclosure, step expander) — this extends it instead of inventing an overlay
dialect.

### Editor dependency

CodeMirror 6 (`codemirror`, `@codemirror/lang-yaml`, `@codemirror/view`) —
the standard, actively maintained, tree-shakeable editor. Bundle impact
~180KB gz total; lazy-loaded only when the panel opens (dynamic import) so
the main bundle is untouched. Zero engine/server dependencies.

### Server surface (one new route + validation home)

- `POST /api/templates/yaml/validate` — body `{ yaml }` → `{ ok, errors:
  [{line, message}] | null, steps, meta }`. Pure function (zod-strict at the
  boundary in spirit; hand-rolled to match repo style): parse → step schema
  check → env-reference lint. The SAME validator backs save, so what the
  panel shows before saving is exactly what save enforces (no drift).
- `PUT /api/templates/:id/yaml` — validate → write `steps_json` + name/tags/
  app. 409 on unknown `runFlow` id, 422 with line numbers on schema errors.
  Unchanged play semantics; verdicts/trends untouched (runs are immutable).
- Conversion lives in `server/src/manual/yaml.ts`: `stepsToYaml(row)` /
  `yamlToSteps(text)` — pure, unit-tested both directions, including the
  drop-list (`thumb`, `ts`) and the lossless-semantics round-trip property.

---

## Tasks

### T0 — `manual/yaml.ts` + tests (the definitions)
- Step/case schema constants (the tables above), `yamlToSteps` (parse +
  validate + normalize: renumber idx, trim tags, default app), `stepsToYaml`
  (stable field order, comments for guidance, `${env.}` preserved).
- Round-trip tests: every action kind; drop-list respected; unknown key →
  error WITH line number; `${env.X}` preserved; optional inheritance on
  runFlow unchanged; empty steps → error (a case must do something).

### T1 — server routes
- `POST /api/templates/yaml/validate` (pure) + `PUT /api/templates/:id/yaml`
  (validate → persist steps_json/name/tags/app; 409/422 shapes above).
- **Fold-in fix (approved)**: coordinate-fallback scaling — when a tap/type
  step's selector misses on a different-sized device, playback.ts currently
  uses RAW recorded coordinates (the scaling branch is skipped when a
  selector exists). Fix: apply proportional scaling in the fallback branch
  too (`resolvedBy: 'coordinate-fallback-scaled'`); unit test with a fake
  snapshot that misses the selector on a scaled device.
- Tests: happy path (existing case → YAML → edit → save → steps_json
  reflects; steps-row editor unchanged behavior on same row), 422 line
  numbers, 409 subflow, name/tags normalization.

### T2 — web: CodeMirror lazy panel + outline
- `web/src/composables/useCodeMirror.ts` — dynamic `import()` wrapper
  (theme, yaml lang, line numbers, ⌘↵). Exposes `value`, `setDoc`,
  `errors` (line decorations), mount/unmount.
- `web/src/components/YamlCasePanel.vue` — the split panel: outline (parsed
  steps w/ kind chips) | editor; save button → validate → PUT → refresh
  table row; inline error list with line numbers; copy button; esc-close +
  unsaved guard; header shows case name + steps count.
- TemplatesPage: `yaml` hover action + expander link; `+ case (yaml)`
  button; panel slots between table and footer.

### T3 — guide
- Test-cases section: YAML card — what the fields mean, the round-trip
  guarantee, `${env.}` never stored, split-panel explanation.

### T4 — gates + live drill
- Full gates (server + web + alloy untouched). Live drill: pick a real case →
  open YAML → outline matches steps → edit (change a label, add an expect) →
  save → re-open: edits persisted; run the case → green; step-row editor
  shows the same steps. Browser screenshot + vision pass on the panel.

---

## Self-review (executed)

- *(a) executed against data:* the sample case in the DB has `ts`/`thumb` on
  every step — the drop-list must ignore them on import or every round-trip
  test fails on extra keys. ✔ (covered in T0 tests)
- *(b) both ends of links:* outline needs a parser in the WEB too (live
  preview). ⚔ **Verified against the repo (2026-09-03): the "server module
  imported by web" idea does NOT hold** — server and web have disjoint
  tsconfig `include` sets (web: `src/**`; server: `src/**`+`test/**`), so a
  file in `server/src` is invisible to vue-tsc, and the server package has
  no `yaml` dependency today. **Corrected design:** the schema + parse +
  validate + serialize live in **`web/src/shared/case-yaml.ts`** as ONE pure
  module (no node APIs, only the `yaml` npm package). The WEB uses it
  directly (it's in web's include → vue-tsc checks it); the SERVER imports
  it by relative path (`../../web/src/shared/case-yaml.ts`) — allowed since
  server tsconfig sets no `rootDir` and `module: nodenext` resolves the
  relative TS file (tsx/vitest follow it; typecheck sees it via the import
  graph, which `include` does not prune). Dependencies: `yaml` added to BOTH
  packages (same version pin — it's pure JS, no native builds). Tests live
  in server vitest (import the shared module; cover both directions +
  error lines) AND the web typecheck gates the module's types. One module,
  two toolchains, zero duplication.
- *(c) re-read code for claims:* PlaybackStep fields verified (playback.ts:31-50);
  `${env.KEY}` substitution is string-level at play (template-env.ts) — YAML
  text content passes through verbatim. ✔
- *(c-2)* ⚔ `runFlow` in YAML references `templateId` — but ids are 8-hex
  hashes (`p_…`? no — template ids like `6f3a…`). Human-unfriendly. **Plan:
  accept `runFlow: <name>` with name→id resolution at save (names are
  unique in practice; collision → 409 with both ids listed).** The outline
  shows the resolved name. This is authoring sugar; steps_json keeps ids.
- *(d) consumer check:* run detail + verdicts consume runs, not templates —
  untouched. The step-row editor reads the same steps_json — T1 test asserts
  both views agree after a YAML save. ✔
- *(e) backward compat:* no storage change; old cases get YAML views for
  free (steps_to_yaml is total). POST /api/templates unchanged. ✔

## Out of scope

- YAML import/export of the WHOLE suite (one case at a time; bulk = a
  follow-up if wanted). Maestro-flow-file compatibility (running external
  .yaml from disk) — this is OUR schema, deliberately close but not
  promise-compatible. Monospace font debates.
