# Review — yaml-first screen register plan

- Reviewed plan: `plans/20260927T071000Z-yaml-first-screen-register-plan.md` (Status: Ready, 2026-09-27T07:10:00Z)
- Evidence sources: plan + brainstorm `brainstorm/20260926T150500Z-screens-registration-e2e-ux.md` (D1–D3) + sketch round `sketches/009-screen-register/`; code read 2026-09-27 — `server/src/routes/app-screens.ts` (toYaml:120, replaceRegistry login path, yaml PUT:176), `shared/src/app-screens.ts` (validateScreen:76, allowed-keys:82), `server/src/manual/screen-runner.ts` (arrive:150, navigate loop:161-167, tapAt selector resolution:138-146), `web/src/pages/ScreensPage.vue` (formToScreen:112, navigate stub:124, yaml modal:696), `web/src/composables/useYamlEditor.ts`.
- Reviewer scope: paper audit against current code; no implementation executed.

## Verdict: **Ready for implementation** — two High findings must be folded in as plan edits first (both are scope clarifications, not design changes)

The architecture is sound and traces cleanly to D1–D5: grammar → surface → document-borne
login. The runner already has selector resolution (`tapAt` + `resolveSelector` at
screen-runner:138-146) — selector steps in navigate reuse it, low-risk. Verified the plan's
own claims: emitter's navigate JSON-line gap is real; validator's unknown-key rejection is
real; `replaceRegistry` preserves login from BOTH the parsed doc and a snapshot (the login
path at routes/app-screens.ts handles a `login` key on incoming screens AND falls back to
the pre-delete snapshot) — so Stage 3's storage side is already half-built.

## Findings

### F1 — HIGH (scope gap) — Stage 2's "edit mode" silently keeps TWO editors

**Location:** plan §Stage 2 (panel replaces the create dialog) + §"current create dialog
deleted (one surface rule)".

**Evidence:** the plan deletes the CREATE dialog but the row `edit` action opens the SAME
dialog (`openEditScreen` → `editor` ref → the probe-overlay at ScreensPage.vue:601) — the
plan says "the same panel reached from a row's `edit` action" but never says the OLD edit
dialog dies. Meanwhile `formToScreen` (line 112) is the only place that builds screens from
a form today and its navigate branch is a STUB (`entry = { navigate: [] }`, line 124) — an
edit today EMPTIES any navigate entry that exists.

**Consequence:** implementing literally leaves three edit paths (panel, old dialog, yaml
modal), violating the one-surface rule the plan itself cites; or the old dialog stays and
still destroys navigate entries.

**Correction:** Stage 2 must state explicitly: the old create/edit dialog (probe-overlay
`v-if="editor"`, `openEditScreen`, `formToScreen`, `saveScreen`) is DELETED and its row
`edit` action routes to the panel. The yaml import/export modal stays (it is the bulk
surface; the panel is the per-screen surface).

**Verify:** after build, `grep -c formToScreen ScreensPage.vue` = 0; row `edit` opens the panel.

### F2 — HIGH (acceptance hole) — acceptance #2/#3 never exercise a screen that needs multi-hop on the real app

**Location:** plan §Validation #3 ("arrive on that screen plays the multi-hop entry on the
drill sim").

**Evidence:** acceptance #2 registers an arbitrary test screen; #3 plays `arrive` on it —
but if the registered screen's navigate steps reference identifiers that don't exist on the
live app (a synthetic screen), arrive fails for environment reasons and proves nothing
about the runner path; the plan doesn't say WHERE the identifiers come from.

**Consequence:** the drill can pass trivially (screen never played) or fail spuriously
(made-up ids), and the actual selector-resolution-in-navigate code ships unexercised.

**Correction:** pin the drill concretely — register a REAL reachable screen of the int-dev
app whose entry is 2 genuine selector steps (e.g. home → `ic_tabbar_account_inactive` →
`account_legal_privacy_row`, both verified live this week), and acceptance #3 = a case with
`arrive: <that-screen>` + one `expect screen` state passing 4/4. VPN-independent (both ids
are logged-out UI).

**Verify:** the run exists with status passed and its steps show the navigate resolution.

### F3 — MEDIUM — two-way sync contract under-specified (form ↔ CodeMirror)

**Location:** plan §Stage 2 "two-way; last-edited side wins".

**Evidence:** CaseEditorPanel's analogous split is ONE-WAY per side (metadata form is
never re-derived FROM the yaml; yaml is never rewritten while the user edits it). A true
two-way CodeMirror binding — re-setting the editor content on every form keystroke —
fights CodeMirror's undo history and cursor position, and re-parsing on every yaml keystroke
re-renders the form (focus loss mid-typing).

**Consequence:** "last-edited side wins" implemented naively produces cursor jumps and
eaten keystrokes — the exact class of editor bug the user notices.

**Correction:** specify the mechanism: form→yaml is live (document re-emitted on input);
yaml→form re-parses ONLY on blur or explicit "sync from document" action (CodeMirror
`updateListener` docChanged + debounce, or a sync button). State which side owns truth at
save time (the DOCUMENT — save always PUTs what the editor shows; the form is a generator).
Add acceptance: typing in the yaml does not move focus/cursor; a form edit does not reset
undo history.

### F4 — MEDIUM — validator gains `login:` but the JSON `PUT /screens` path also needs it

**Location:** plan §Stage 3 (validator + emitter + import).

**Evidence:** `validateScreen` rejects unknown keys for BOTH the yaml import and the JSON
`PUT /api/apps/:bundle/screens` (same `validateRegistry` call). The panel saves via the JSON
PUT (plan §Stage 2). If `login` shape-validation is written only for the yaml path's mental
model, the JSON path breaks or duplicates.

**Correction:** one validation addition in `validateScreen` serves both paths (allowed keys
gain `login`; shape = 5 non-empty strings). One test file covers both transports.

### F5 — LOW — sketch C's form pane is the design spec but the plan doesn't restate the login stage's conditional visibility

Minor: sketch C shows the five login fields only when the checkbox is on; the plan should
state the same for the panel (anti-bloat: no five empty identifier inputs by default).

### F6 — LOW — acceptance #4's "side-by-side screenshot check" lacks a mechanical form

Parity claim needs a probe: same `.cm-host` class + computed font/size match between the
panel editor and CaseEditorPanel's editor (the shared composable makes this near-automatic;
assert it so drift is caught).

## Traceability

D1 → Stage 1 (+F2's drill) ✔ · D2 → Stage 3 (+F4's both-transports validation) ✔ ·
D3 → out-of-scope guard ✔ · D4 → Stage 2 ✔ · D5 → Stage 2 CodeMirror requirement (+F3's
mechanism, F6's probe) ✔. No un-approved commitments beyond the plan's own text.

## What was inspected vs needs execution

Inspected on paper: grammar fit against `validateScreen`/`validSelector`/runner resolution
code paths; storage preservation semantics of `replaceRegistry`; the two save transports;
the current dialog's navigate stub (found F1's data-loss angle); composable reuse for D5.
Requires execution: CodeMirror two-way behavior (F3's fix must be verified by typing in
both panes), the multi-hop arrive drill (F2), visual parity probe (F6), full `pnpm run check`.

## Required plan edits before implementation

- F1: state the old dialog's deletion + row-edit rerouting explicitly.
- F2: pin the acceptance drill to real, verified identifiers and a passing run.
- F3: specify the sync mechanism (live form→doc; doc→form on blur/debounce; document owns
  truth at save) and its acceptance probes.
- F4: one validator change serving both transports; tests cover both.
- F5/F6: editorial.
