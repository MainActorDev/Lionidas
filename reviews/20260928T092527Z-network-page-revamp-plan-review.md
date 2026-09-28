# Review — network page revamp plan (20260928T092527Z)

- Reviewed: `plans/20260928T092527Z-network-page-revamp-plan.md` (status Ready, 2026-09-28)
- Sources: brainstorm `20260928T092527Z-network-page-revamp.md` (+ decision log), sketch `sketches/021-network-page/c2-document-foldered/`, verified against `server/src/forge/routes.ts`, `server/src/manual/case-versions.ts` (scenarioSnapshot, sha), `server/src/manual/playback.ts` (id-or-name resolution, runs insert), live DB queries (runs/case_versions reference shapes), `web/src/components/NewRunModal.vue`, folders table/schema, `server/test/forge-*.test.ts`.
- Verdict: **Needs revision** — 1 Critical, 3 High, plus Mediums. All findings have concrete, testable corrections; no operator-blocked decisions.

## Traceability summary

Confirmed decisions → plan coverage: document-first pick ✓ (Stage 2/4); TestCasesPage anatomy + foldering ✓ (Stage 1/4); traffic same page ✓ (Stage 4); id-keyed refs ✓ (writers + guards, Stage 1/3); agent-close weighting ✓ (grammar as rulebook surface). Out-of-scope list matches the brainstorm (preset editor, traffic flow, matcher internals). No extra commitments found beyond: **duplicate action** (in brainstorm pain list, user never explicitly approved — acceptable as it mirrors case duplicate, disclose in PR) and **scenario move via select-mode** (same class).

## Findings

### F1 — CRITICAL: `changedSincePlay` sha recipe diverges from the stamped sha (marker would be permanently wrong)

Plan §Architecture (list extensions): `shaCurrent (membership+launch_arg hash, same recipe as case-versions.ts:110)`. Verified: the stamped `runs.scenario_sha` = sha256 of `JSON.stringify(scenarioSnapshot(id))` where `scenarioSnapshot` = **full `SELECT p.*` preset rows of ENABLED members + body file manifest** (case-versions.ts:62-80,110). It does NOT include launch_arg, and it returns **null when zero enabled presets**. A differently-composed hash (membership+launch_arg) will never equal the stamped sha → `changedSincePlay` true forever (or, if compared loosely, never).
**Correction**: compute `shaCurrent` by calling the SAME `scenarioSnapshot()` + hash — no parallel recipe. Test: seed scenario + member, run snapshot, edit membership (add/disable), assert marker flips true; re-run snapshot, assert false. Also note honestly in the panel footer that **launch_arg edits don't affect the sha** (snapshot excludes it) — either accept (marker covers membership only) or extend the snapshot recipe (breaking change to stamped shas — do NOT silently do that).
**Verify**: new test in scenario-folders.test.ts seeding run rows with scenario_sha from scenarioSnapshot, then membership edit.

### F2 — HIGH: `usedBy` scan misses two real reference surfaces (guards would pass while consumers exist)

Plan §Architecture: usedBy = variants_json scan. Verified live: `case_versions.scenario_id` holds BOTH names (`account-active`, `account-pending`, `account-rejected` — historical) and ids (`s_6062b5db`), and `runs.scenario_id` stores the **scenarioChoice string** — names for variant plays (`countries-sg`), ids for direct picks. A delete guard scanning only variants_json lets a scenario referenced solely from a saved case version (or historical run provenance) delete cleanly, then that run detail/version view points at nothing.
**Correction**: guard scans three surfaces — templates.variants_json (id OR name match), case_versions.scenario_id, runs.scenario_id — returning named consumers with the surface label (`variant sg of case X`, `case version r12`, `104 runs (provenance)`). Decide: runs provenance BLOCKS delete (safe; 62 runs would make countries-sg undeletable — arguably correct for replay) or WARNS-only (provenance rows keep their string, snapshot json still replays). Plan must pick one; recommend **block on variants/case_versions, warn-only on runs** with counts (matches the existing delete copy's spirit — "saved plans fall back" — while staying honest).
**Verify**: guard test seeding each surface alone asserts 409 (or warn) with the named consumer.

### F3 — HIGH: preset-delete guard (Stage 3) breaks the replace-set members PUT contract… and vice versa

Verified: `PUT /api/forge/scenarios/:id/members` validates unknown presets with 400 (routes.ts:241-263); preset DELETE today cascades `scenario_overrides` silently. Plan adds 409-on-member preset delete — but does not state the ordering rule for the panel's save (PATCH + PUT members) when a member preset was deleted mid-edit, and the existing `400 unknown preset` path already covers the PUT side. Also unstated: does the 409 fire when the ONLY member scenarios are ones with `enabled=0` for that preset? (Snapshot excludes disabled members, but the override row still exists → cascade still removes it.)
**Correction**: preset DELETE → 409 naming member scenarios **whenever any scenario_overrides row exists** (enabled or not); the document panel treats PUT 400 `unknown preset` as "preset was deleted — reopen the document" (already implied; make it an explicit acceptance line). No members-PUT change.
**Verify**: guard test: member row (enabled=0) → still 409; PUT with deleted preset id → 400 (existing pin, keep).

### F4 — HIGH: no concurrency/mid-activation story for delete + duplicate (existing code has one)

Verified: scenario DELETE clears live forge state (`clearScenario()`, routes.ts:218-226) because mid-activation deletes would ghost-serve presets. Plan's duplicate route and the new move/rename paths say nothing about the active-run window (runs hold `forgeState.activeRunId`; a folder move is metadata-only — safe — but duplicate copies membership while a sibling scenario is ACTIVELY SERVING, and delete's 409 guard is bypassed by direct API call during a run).
**Correction**: keep `clearScenario()` on delete (already in code — note it in plan); duplicate is read-only on source (INSERT new rows) — safe, state one line; document that folder move/rename NEVER touches serving state. Add one test: duplicate during active state does not mutate source's overrides.
**Verify**: scenario-folders.test.ts duplicate-isolation test.

### F5 — MEDIUM: `selectTemplates`-style subtree filter citation is inapplicable (different table)

Plan Stage 1 says "mirror selectTemplates" for `?folderId=`. Testcases folders filter is app-scoped via templates table; scenario folders are a separate global tree — the mirror is the recursive-CTE pattern, not that function. Minor: name the actual mechanism (`WITH RECURSIVE` subtree id set → `WHERE folder_id IN …`), or reuse the folders.ts helper if it generalizes.
**Verify**: subtree filter test with nested folders (child scenario visible from root query).

### F6 — MEDIUM: ScenarioDocPanel save = two sequential calls (PATCH + PUT members) — partial failure state unspecified

Plan acknowledges sequential calls but not the failure between them (name saved, members 400). House pattern (CaseEditorPanel) reports split results honestly; the plan should say: on members failure after name success, panel shows `name saved · membership not saved — <error>` and stays dirty on the members side only.
**Verify**: UI drill step mocking PUT failure; assert message + dirty state. (Implementation-time check.)

### F7 — MEDIUM: folder guard uses descendant counts — scenarios also live at folder level (not only leaves)

Carried assumption from folders.ts is fine, but scenario folders' "contents" = scenarios at that folder + everything in descendant folders. Ensure counts and the 409 body name BOTH (folders N · scenarios M in subtree), same as testcase folders do for cases.
**Verify**: nested-folder delete test asserting both numbers.

### F8 — LOW: router title/desc copy

Plan keeps router meta.title "network" — the PageHeader in sketch reads `network · scenarios`. Fine; just confirm the header desc line (counts) doesn't restate the anti-bloat rule (no explanatory suffix). No action beyond build-time check.

### F9 — LOW: sketch shows `folder: tariff worlds/countries` path in the document — plan's grammar marks it read-only render

Confirmed consistent (path derives at read; moves via folder UI). Keep the doc's folder line out of the SAVED payload (derived, not stored) — plan implies it; make explicit in the grammar spec so round-trip tests don't pin a stored path field.
**Verify**: round-trip test asserts emitted doc has no `folder:` key; UI renders path from the list payload.

## Questions for the operator

1. **Runs-provenance on delete** (F2): block, or warn-with-counts? Recommendation: warn-only for runs, block for variants/case_versions.
2. **launch_arg in the changed-marker** (F1): accept membership-only marker (recommended — no sha-recipe break), or extend snapshot recipe (invalidates historical sha comparisons)?

## Required plan edits

- F1: shaCurrent via scenarioSnapshot() verbatim + marker semantics note.
- F2: usedBy = three surfaces + chosen delete policy per surface.
- F3: preset-delete 409 whenever an override row exists; PUT-400 interplay stated.
- F4: state-safety notes for delete/duplicate/move.
- F5: subtree filter mechanism named (recursive CTE).
- F6: partial-save messaging contract.
- F7: folder 409 body names folders+scenarios counts.
- F9: grammar: folder path is derived, never stored/round-tripped.

## Verdict (rev 2 update, 2026-09-28)

Operator answered both questions: (1) runs-provenance → warn-only (block on variants/case_versions), (2) changed-marker → option A (membership+bodies, verbatim snapshot recipe). All nine findings are now applied to `plans/20260928T092527Z-network-page-revamp-plan.md` rev 2 — F1 (scenarioSnapshot reuse + marker semantics), F2 (three-surface scan + per-surface delete policy), F3 (override-row-exists 409), F4 (state-safety notes + duplicate isolation test), F5 (recursive CTE named), F6 (split partial-failure reporting), F7 (both counts in 409), F8 (build-time check only), F9 (derived folder path, never stored). **Revised verdict: Ready for implementation.**

## What remains to validate during implementation

Execution-level only: live drill steps (Stage 5), layout matrix, rename-then-play id resolution, build + full suite. The review inspected contracts on paper; concurrency windows beyond F4's notes and real proxy behavior under the new UI are test-time concerns.
