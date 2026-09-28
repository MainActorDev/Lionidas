# Test case duplication + YAML export/import

- Source prompt: "1. As a user, I want to be able to duplicate any test case I choose. 2. As a user, I want to be able to export test cases as YAML and import a test case with a YAML file"
- Created: 2026-09-27T16:40:00Z (rev 2, 2026-09-27T17:05:00Z — operator decisions folded, batch export zipped)
- Status: Direction selected (all questions resolved)

## Goal and context

Two user stories for the testcase surface: (1) duplicate an existing test case — the classic "copy then tweak" flow that avoids re-recording; (2) get YAML out of Lionidas and get YAML back in — sharing cases between environments, backup, review-in-PR, and the future AI-agent authoring direction (the machine rulebook is already YAML).

Both features are natural extensions of an existing, strong seam: templates already round-trip through `caseToYaml`/`parseCaseYaml` (the editor is a live YAML document), there's a per-template YAML GET, a POST create, a yaml/validate endpoint, and `name TEXT NOT NULL UNIQUE`.

## Confirmed inputs and decisions

Verified in the repo (2026-09-27):
- `GET /api/templates/:id/yaml` exists (renders the case as YAML, resolves runFlow ids → names)
- `PUT /api/templates/:id/yaml` exists (document-owns-truth save path, validated)
- `POST /api/templates/yaml/validate` exists (parse-only check)
- `POST /api/templates` creates (name required; id `tpl_` + 8 hex; steps stored as JSON)
- `templates.name` is **UNIQUE** — imports/duplicates must handle collisions
- Editor: CaseEditorPanel is a live CodeMirror YAML document (form ⇄ doc sync); TestCasesPage hosts it
- The YAML emitter handles: setup, alerts, variants, swaps, entry facet, runFlow name mapping
- Server deps are minimal (fastify, better-sqlite3, sharp, yaml) — **no zip library present**; zip is a container format, so a real zip writer dependency is required
- House rules in force: TDD; validator round-trips every edit; one affordance per action; Axiom tokens; no hardcoded credentials; explicit > silent

User statements (rev 1): duplicate *any* test case; export *test cases* (plural — batch matters); import *a test case* with *a YAML file*.

**Operator decisions (2026-09-27, rev 2):**
1. Batch export **wanted, zipped** — "Exporting multiple test cases as one is way more better if we can zipped them first" → a ZIP archive, one `.yaml` per case (replaces rev 1's single multi-doc file).
2. Duplicate **jumps into the copy**, and **no name collision** may ever surface to the user — the suffix bump is transactional and guaranteed.
3. Import collisions: **auto-suffix** ` (imported)`.

## Exploration

### Story 1 — Duplicate (final)

`POST /api/templates/:id/duplicate`: full row copy (steps/tags/variants/setup/alerts/entry), fresh id, name `<orig> (copy)` / `(copy 2)`… via a **transactional** bump loop (UNIQUE constraint + retry make collisions impossible to observe), status → `draft`, `created_by` = current user, fresh timestamps. Returns the new row.
- UI: row action `duplicate` → **navigate into the copy's editor** on success.
- Edge cases: runFlow references copy verbatim (ids remain valid; names re-resolve at render); duplicating `deprecated` allowed (revival-by-copy); concurrent duplicates serialize through the transaction.

### Story 2 — Export (final)

- **Single case:** `export yaml` on the row → download of the exact `GET /:id/yaml` bytes as `<slug>.yaml`.
- **Batch (zipped):** `GET /api/templates/export?ids=a,b,c` (no ids = every template) → ZIP containing one `<slug>.yaml` per case + a `manifest.json` (name → file, ids, exported-at, app bundles). Duplicate slugs inside the archive get `-2` suffixes. Zip writer: **fflate** (`zipSync`; zero-dep, pure JS, no native build — matches the minimal-deps posture; `adm-zip` is the fallback if fflate's API ever bites).
- Filename via the existing slug logic used by evidence downloads.

### Story 3 — Import (final)

`POST /api/templates/import` accepts **`.yaml` (single or multi-doc) or a `.zip`** (as produced by export — enumerate `.yaml` entries; manifest optional): parse every document with `parseCaseYaml`, **all-or-nothing** (any error names document + line and rejects the whole payload), reverse-map runFlow names → ids, insert with fresh ids, collision suffix ` (imported)` + bump, status `draft`, operator-gated, validate BEFORE any insert.
- UI: `import` on the TestCasesPage header → file picker (`.yaml,.zip`) → preview (name, steps count, app per case) → confirm → per-case results.
- Closed loop: export → wipe → import reproduces the cases (the acceptance test).
- Registry cross-refs (screens, env keys) import verbatim, shape-validated; missing refs surface at run time as named errors — matches the create-through-editor behavior; no silent rewriting.

## Open questions

None — all resolved (rev 2 decisions above).

## Next step

`hms-plan-from-brainstorm` on this artifact: Stage 1 duplicate API (TDD), Stage 2 import API (yaml + zip), Stage 3 export API (single + zipped batch, fflate dep), Stage 4 UI affordances, Stage 5 acceptance round-trip (export → delete → import → identical).
