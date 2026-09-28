# Network page revamp — scenario documents, foldering, id-keyed references (plan)

- Source brainstorm: `brainstorm/20260928T092527Z-network-page-revamp.md` (2026-09-28)
- Status: Ready (rev 2 — review findings F1–F9 applied, operator answers recorded 2026-09-28: delete policy = block on variants/case-versions, warn-only on runs; changed-marker = membership+bodies only, option A)
- Approved design: `sketches/021-network-page/c2-document-foldered/` (C document-first × TestCasesPage anatomy + foldering; picked by user 2026-09-28)
- Review: `reviews/20260928T092527Z-network-page-revamp-plan-review.md` (Needs revision → findings applied; F8 build-time only)

## Objective and completion conditions

Rebuild the `/forge` (network) page so scenarios are managed as **documents in a foldered list** (the TestCasesPage anatomy), with **id-keyed scenario references**, **named-consumer guards**, and a **persistent proxy/mode control strip**. Done when:

1. The page renders ONE `.a2-list` box (sticky thead `scenario · presets · runs · updated`, 26px selection track, document glyph per row) with breadcrumb + folder rows above scenario rows (cPanel navigation, delete only when empty — UI hides + server 409 naming both folder and scenario counts).
2. Row click expands an inline **scenario document** (form ⇄ YAML two-way, CodeMirror via `useYamlEditor`, same chrome as ScreenDocPanel/CaseEditorPanel) that round-trips through a shared validator; save persists name/launch_arg/membership with split partial-failure reporting.
3. **Id-keyed references**: every NEW scenario reference (variant editor output, case YAML emit, plan/save payload, play-time pick) stores the stable `s_…` id; playback's existing `id OR name` resolution keeps legacy name refs working un-migrated.
4. **Guards**: scenario delete → 409 with named consumers when variants/case-versions pin it, warn-only (with run counts) when only run provenance exists; preset delete → 409 naming member scenarios whenever any override row exists; scenario document shows `used by: …` (per-surface labels) + `changed since last play` marker (membership+bodies only, via the verbatim scenarioSnapshot hash).
5. Proxy/routing/mode live in a persistent control strip (never inside a tab/panel); traffic stays on the page as a subordinate live feed (existing table, capped ~200 rows + search — already the API contract).
6. All server changes TDD; suite green; live drill against the real DB (3 scenarios, 62/21/21 stamped runs) proves list + document + folder navigation + guards.

## In / out of scope

**In**: ForgePage rebuild; scenario document grammar + validator + panel (shared/ + web/); scenario folders (new table, global tree — root "scenarios"; NO app scoping, scenarios have no bundle binding); id-keyed refs (writers + guards); sha-diff marker; preset delete guard; scenario duplicate; router title stays "network".
**Out**: preset editor redesign (PresetEditorModal stays as-is, opened from the document's member rows); traffic capture→preset flow changes; matcher/proxy/mitm internals; multi-scenario variant compose UI (document shows pins; composing stays case-yaml-side this round); playback changes beyond resolution already present; agent-side tooling.

## Requirements and constraints

- No hardcoded data (user standing rule); all values from DB/API.
- House anatomy verbatim: `.a2-list`, `.a2-crumbs`, `.a2-folder-row` classes from TestCasesPage/global components.css — page-scoped CSS only for the document panel + control strip.
- Anti-bloat (skill rule): no caption text under titles, no explanatory suffixes; tooltips only.
- cPanel folder semantics identical to testcases: navigation not disclosure; path derived at read (renames never rewrite); delete guarded both ends; checkboxes only in select mode.
- Scenario documents are the machine-readable rulebook surface (operator north star): explicit ids, enabled flags, launch_arg — agent-authorable later with zero UI change.
- Mode is global — the strip states it; record/hybrid/intercept unchanged server-side.
- Foldering: **global tree** (agent assumption flagged in brainstorm, carried as a plan decision: scenarios are URL-pattern-based, not app-bound; a global root avoids inventing an app dimension that does not exist).

## Architecture / interfaces

### Data (guarded ALTERs, `server/src/db/schema.ts`)

- `scenario_folders` table: `id TEXT PK, parent_id TEXT NULL REFERENCES scenario_folders(id) ON DELETE CASCADE, name TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL` + `UNIQUE(parent_id, name)` (NULL-parent = root via `IFNULL(parent_id,'')` index trick, same as folders).
- `scenarios.folder_id TEXT NULL REFERENCES scenario_folders(id)` (guarded ALTER; NULL = root).
- Existing tables untouched otherwise: `scenarios` (name/description/launch_arg/immutable_since), `scenario_overrides` (members), `presets`, `runs.scenario_id/scenario_sha`.

### Shared grammar (`shared/src/scenario-yaml.ts` — new)

```yaml
scenario: countries-sg          # display name (editable label)
id: s_c1265727                  # stable pin — READ-ONLY in doc + form
folder: tariff worlds/countries # path (read-only render; moves via folder UI)
presets:
  - preset: p_1b58882e          # stable id
    enabled: true
launch_arg: LP_COUNTRY=SG       # optional
```
`parseScenarioYaml` / `scenarioToYaml` with validator: unknown keys rejected, preset ids must exist (checked server-side at save), name non-empty, launch_arg optional single line. Round-trip tests mirror `case-yaml-roundtrip.test.ts`.

**Review F9**: the `folder:` line is DERIVED at read (path from the folder tree) — never stored and never part of the save payload; round-trip tests assert the emitted document carries no stored folder field, the UI renders the path from the list payload.

**changed-since-play marker (review F1, operator decision 2026-09-28: option A)**: `shaCurrent` is computed by calling the SAME `scenarioSnapshot()` + sha256 as the run stamp (`case-versions.ts:62-110`) — verbatim reuse, no parallel recipe. The marker compares `shaCurrent` vs the newest stamped run's `runs.scenario_sha` and covers **membership + preset bodies only**; `launch_arg` is NOT part of the snapshot (verified), so a launch_arg-only edit does not flip the chip — the document footer states this plainly. Extending the recipe was rejected: it would invalidate every historical comparison (one-time false "changed" wave across all 104 stamped runs).

### Server routes (`server/src/forge/routes.ts` + new `server/src/routes/scenario-folders.ts`)

- Scenario folders CRUD cloned from `server/src/routes/folders.ts` (list with subtree scenario counts, create/rename/delete-empty/children listing; delete 409 names BOTH descendant folder count and scenario count — review F7). Move scenario: `PATCH /api/forge/scenarios/:id { folderId }` (same-tree check, NULL = root).
- `GET /api/forge/scenarios` extended: `+ folderId, launchArg, memberCount, runCount (runs grouped by scenario_id — counts match on id OR name, since runs store the scenarioChoice string), usedBy, changedSincePlay`. `usedBy` scans THREE surfaces (review F2 — live DB shows references in all three): templates.variants_json (id OR name match), case_versions.scenario_id, runs.scenario_id — each consumer labeled with its surface (`variant sg of case X`, `case version r12`, `104 runs · provenance`).
- `DELETE /api/forge/scenarios/:id` policy (review F2, operator decision 2026-09-28): **BLOCK (409) when variants_json or case_versions reference it** (id or name) — those are live pins; **WARN-only when only runs reference it** (response carries `{ warning, runCount }`, delete proceeds; run rows keep their provenance string and stamped snapshots replay independently). Keeps existing `clearScenario()` state-safety call (review F4).
- `DELETE /api/forge/presets/:id` → 409 naming member scenarios **whenever any scenario_overrides row exists (enabled OR disabled)** (review F3 — the cascade removes disabled rows too); confirm-in-UI with the named list. The members PUT's existing `400 unknown preset` stays the panel's "preset deleted meanwhile" signal.
- `POST /api/forge/scenarios/:id/duplicate` `{ name }` — copies membership + launch_arg into folder of source; new id; immutable_since NULL. Read-only on the source's rows — safe during an active serving window (review F4).
- Save path reuses existing `PATCH /api/forge/scenarios/:id` (name, launchArg) + `PUT members` — the panel composes both calls (one save button, sequential; partial failure is REPORTED SPLIT: `name saved · membership not saved — <error>`, members side stays dirty — review F6).
- List route gains `?folderId=` subtree filter via a recursive-CTE subtree id set (`WITH RECURSIVE … WHERE folder_id IN (…)`) — the folders.ts pattern generalized, NOT a selectTemplates mirror (review F5: different table, global tree).

### Web (`web/src/pages/ForgePage.vue` full rewrite; NEW FILE per house rule — old page deleted)

- PageHeader `network · scenarios` (desc: counts), actions `+ scenario`.
- Persistent control strip: proxy dot+port, sims routed state, mode segmented (`a2-tabs`), copy from existing logic (loadMitm/startMitm/loadRouting/setMode/setMode unchanged).
- Scenario list: `.a2-list` + thead + `.a2-crumbs` + `.a2-folder-row` + scenario rows (`doc-glyph`, name + `s_…` id, memberCount, runCount, updated, `used` chip / `changed` chip when changedSincePlay). Row click toggles inline document panel (same-row toggle; one open at a time). Select mode (`select` button) → checkboxes → `move N to…` (folder move), `duplicate` on selection.
- Scenario document panel (new `web/src/components/ScenarioDocPanel.vue`): header (`scenario document` + id), tabs form/yaml, yaml side via `useYamlEditor`; form side: name, launch_arg, members table (preset rows: enable checkbox, method/path/status ellipsized, `edit` opens PresetEditorModal, `remove`), add-member select (non-member presets), footer `save` (PATCH + PUT members) + `sha … · stamped by N runs · edits apply from next play` + `used by` chips (case/variant). Dirty guard on row switch (modal, CaseEditorPanel pattern).
- Traffic section below: existing table + search + live reload, unchanged behavior, `.a2-list` chrome.
- Empty states: no scenarios → `no scenarios — capture traffic below and save a preset, or create one` + `+ scenario`; no folders → no folder rows (breadcrumb root only); empty folder → `empty folder` line + `+ scenario` here.

### Reference writers (id-keyed)

- TestCasesPage play modal + NewRunModal already send `s_…` ids (`:value="s.id"`) — verified; no change needed there.
- `shared/src/case-yaml.ts` variant emit (`scenarios: [...]`): keep emitting what's STORED (round-trip fidelity); new variant authoring via UI writes ids — the variant editor already stores what the doc carries; when case yaml references a scenario by id, playback resolves (verified `id OR name`). No case-yaml grammar change this round (pins remain readable; migration of legacy name pins is out of scope).

### Edge and failure cases

- Deleting a folder with scenarios → 409 (subtree counts named) — same as testcases.
- Scenario doc save with a removed preset id (deleted meanwhile) → validator error names the missing preset.
- Two users editing one scenario → last save wins; membership PUT is whole-list (current contract) — acceptable, single-operator registry.
- Proxy down while playing a scenario → existing SCENARIO_INACTIVE preflight (playback.ts:382) unchanged.
- Rename scenario with legacy name refs in old cases → allowed (id-keyed refs unaffected; legacy names still resolve until those cases re-save). `used by` shows the ref form (id or name) honestly.
- `changed since last play` when no runs stamped yet → hidden (nothing to diff).
- Traffic search server-side `?q=` — bounded by limit=200 default (existing).

## Implementation stages (ordered, each with deliverable + checks)

**Stage 1 — server: scenario folders + list extensions (TDD)**
Tests first (`server/test/scenario-folders.test.ts` clone of folders.test.ts shape + `forge.editor.test.ts` additions): CRUD, subtree counts (folders + scenarios, F7), move guards, delete-empty 409 w/ both counts, list payload fields (runCount matching id-or-name / usedBy across three surfaces / changedSincePlay via scenarioSnapshot), duplicate route + source-isolation test (F4). Guarded ALTERs in schema.ts. Deliverable: green tests + routes.
**Stage 2 — shared grammar + round-trip**
`shared/src/scenario-yaml.ts` + `server/test/scenario-yaml-roundtrip.test.ts` (parse→emit→parse identity; unknown-key rejection; id/launch_arg/members fidelity; NO stored folder field — F9). Deliverable: green round-trip.
**Stage 3 — guards**
Delete-scenario 409 w/ named consumers per surface + runs-only warn path (F2 policy); preset-delete 409 whenever an override row exists incl. enabled=0 (F3); members-PUT 400 stays pinned (TDD in forge-guards.test.ts). Deliverable: green guard tests.
**Stage 4 — web: page rebuild (NEW FILE) + ScenarioDocPanel**
ForgePage.vue rewritten (old deleted), control strip, foldered list, inline doc panel (split partial-failure save reporting — F6), select mode, duplicate, empty states; PresetEditorModal integration. Deliverable: `pnpm run build` clean + dev render.
**Stage 5 — verification drill**
Live browser drill on real DB: folder create/rename/delete-guard, scenario move via select mode, document open/edit/save (form⇄yaml round-trip in UI), duplicate, delete-guard message names consumers, `changed` chip after membership edit, traffic still renders + search. Layout-matrix drill (3 widths, no h-scroll, sticky thead). Screenshot + vision pass vs sketch c2.

## Validation and acceptance

- `pnpm vitest run` (server) green incl. new suites; `pnpm run build` (web) clean.
- Round-trip: every scenario document edit passes parseScenarioYaml/scenarioToYaml before save (panel refuses invalid).
- Id-keyed: play a case with a variant pinning `s_c1265727` after renaming countries-sg → run stamps the scenario (resolution by id verified in drill).
- Guards fire with names, not counts alone.
- Page anatomy grep: no `.card` list stacks; PageHeader used; shared classes only.

## Rollout / handoff

Single PR on a fresh branch from main. Sketch dir committed (c2 = build spec). No data migration (folder_id NULL = root). Rollback = revert page + routes; schema additions are additive.
