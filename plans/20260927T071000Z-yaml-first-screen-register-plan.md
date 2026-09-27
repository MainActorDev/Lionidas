# Screens register flow — yaml-first (sketch 009-C picked)

- Source brainstorm: `brainstorm/20260926T150500Z-screens-registration-e2e-ux.md` (D1–D3)
- Sketch round: `sketches/009-screen-register/` — C picked 2026-09-27
- Created: 2026-09-27T07:10:00Z
- Status: Ready (rev 2 — review F1–F6 applied 2026-09-27; see
  `reviews/20260927T071000Z-yaml-first-screen-register-plan-review.md`)

## Decision log

| # | Decision | Provenance |
|---|---|---|
| D1 | Multi-hop entry = selector steps (`{on: identifier}`) in `navigate` — grammar + runner work | Operator 2026-09-27: "Need it" |
| D2 | Login recipe inside the register flow | Operator: "Inside the flow" |
| D3 | Manual registration; live probe stays states-only | Operator: "Manual it's fine for now" |
| D4 | Sketch variant C (yaml-first split-pane) picked | Operator: "YAML first" |
| D5 | The editor's appearance follows the testcase YAML editor (CodeMirror via useYamlEditor, same chrome) | Operator: "Ensure the appearance of the editor follow the testcase YAML" |

## Objective

Registering a screen becomes a document flow: the yaml is the protagonist, the form is the
assist. Everything a screen declares (identity, entry incl. multi-hop selector steps,
refresh, states, login recipe) is authored in one save, validated, and rendered exactly like
the testcase editor the user already knows.

## Stage 1 — grammar: selector steps in `navigate`

`shared/src/app-screens.ts` + the runner:

- `validSelector` gains nothing (already supports identifier/label/labelContains + optional point)
- `entry.navigate` steps accept `{ on: <selector-ref> }` (string identifier/label) in ADDITION
  to `{ x, y }` — a step with `on` resolves like a tap selector at arrive time; mixed lists
  allowed (legacy coordinates keep working)
- `ScreenRunner.arrive` navigate loop: for each step, if it has `on`, resolve via the same
  findOne the playback tap uses (identifier → label exact → labelContains), then press the
  resolved point; else legacy x/y
- Validation: a navigate step must have exactly one of `on` | `x`+`y`; unknown keys error
- Round-trip: yaml export/import carries both forms (it already serializes steps verbatim)

**Serializer finding (verified):** the registry emitter (`routes/app-screens.ts:120` `toYaml`)
currently emits `navigate:` as one `JSON.stringify` line — selector steps must get a proper
block form (`navigate:` / `- on: identifier` lines) or the document stays machine-round-trip
but not hand-editable. Stage 1 includes the emitter + import round-trip tests.

Deliverable: parse/validate tests for both step kinds + runner resolution test + emitter
round-trip.

## Stage 2 — the register/edit surface (D4+D5)

Replaces `+ screen`'s current dialog with a full-width page-level panel (route `/screens/new?bundle=…`
stays on the screens page as an overlay drawer, matching CaseEditorPanel's anatomy):

- **Left: the form** (from sketch C) — id, entry kind (tab selector / deep link / navigate
  steps with add/remove), refresh, states (name + assertion), login recipe (checkbox; the
  five identifier inputs render ONLY when checked — no five empty fields by default, per
  sketch C and the anti-bloat rule). Every input syncs the document.
- **Right: the yaml document in CodeMirror** via `useYamlEditor` — same `.cm-host` chrome,
  same lazy bundle, same highlight. NOT read-only. **Sync mechanism (F3):** form→document
  is LIVE (the document re-emits on every form input); document→form re-parses on BLUR or a
  debounced docChanged (400ms), never per-keystroke — no cursor jumps, no eaten keys, no
  undo-history resets. The DOCUMENT owns truth at save time: save PUTs exactly what the
  editor shows; the form is a generator, never a second source.
- **Save** = PUT the DOCUMENT through the existing registry validator (`PUT /api/apps/:bundle/screens`
  with the full list, or the yaml import route — same validation path). Named errors render
  under the editor (missing id, navigate step without on/x+y, duplicate state names).
- **Edit mode**: the same panel reached from a row's `edit` action, prefilled with that
  screen's document — one surface for create and edit.

**F1 (review):** the OLD create/edit dialog is deleted outright — `openEditScreen`,
`formToScreen`, `saveScreen`, and the `v-if="editor"` probe-overlay all go (its navigate
branch is a stub that EMPTIES multi-hop entries on every edit — a live data-loss path).
Row `edit` reroutes to this panel prefilled. The yaml import/export modal STAYS (bulk
surface; the panel is the per-screen surface).

Deliverable: panel component + form↔yaml sync + validation error surface; `grep -c
formToScreen ScreensPage.vue` = 0 after the build.

## Stage 3 — login recipe rides the document (D2)

The five identifiers serialize INSIDE the screen's yaml (`login:` key in the screen doc;
`login_json` column stays the storage, the registry yaml export gains the block). The
register flow's checkbox exposes it; existing row-level add/edit/remove for the recipe stay
(the dashed row / in-place block) as the post-create edit path.

**Verified gaps this stage covers:** the registry yaml emitter has NO `login:` block today,
and `validateRegistry` (shared) rejects unknown screen keys (`allowed: id, entry, refresh,
states`) — so yaml round-trip of a recipe would 422. The yaml import must accept `login:`
(shape-validate the 5 identifiers) and `replaceRegistry` already preserves/stores login_json
(landed earlier); the validator + emitter + import are the work.

**F4 (review):** the validator change lives in `validateScreen` (allowed keys gain
`login`; shape = 5 non-empty strings) — ONE change serving BOTH transports (yaml import
`PUT screens.yaml` and JSON `PUT /screens` share `validateRegistry`). Tests cover both.

Deliverable: yaml round-trip includes `login:`; both transports accept it; existing recipe
CRUD unchanged behaviorally.

## Failure cases and edges

- Navigate step with neither `on` nor `x/y` → validator error, named
- Two-way sync conflict (form edit while yaml dirty) → last-writer-wins per the panel
  contract; no silent merge
- Registry validator forbids empty registries — deleting the last screen via the new panel
  must hit the existing honest error, not a silent wipe
- Multi-bundle revision guard is per-bundle (019 lesson) — the panel keys revision per bundle
- CodeMirror lazy chunk must not load on the screens LIST (only when the panel opens)

## Validation and acceptance

1. `pnpm run check` green; new grammar + sync tests inside
2. Register a screen end-to-end from the UI with a navigate entry of 2 selector steps,
   one state, and the login recipe — one save, no API calls
3. **Multi-hop drill (F2, pinned):** register `account-legal` on int-dev whose entry is
   `navigate: [{on: ic_tabbar_account_inactive}, {on: account_legal_privacy_row}]` (both
   identifiers verified live this week, VPN-independent) + state `visible: {all:
   [{identifier: legal_doc_privacy_screen}]}`-equivalent from the twins' vocab. A case with
   `arrive: account-legal` + one expect passes; the run's steps show selector resolution,
   storage holds NO coordinates
4. Editor parity is asserted mechanically (F6): the panel's editor mounts the SAME
   `useYamlEditor` handle; probe `.cm-host` presence + computed font-family/size equal to
   CaseEditorPanel's editor, plus a visual side-by-side
5. Editing the yaml directly (add a state in the document) reflects in the form on re-parse

## Out of scope

- Probe-first registration; AI-agent authoring (the schema prepared here is its substrate)
- Any change to case-level steps grammar
