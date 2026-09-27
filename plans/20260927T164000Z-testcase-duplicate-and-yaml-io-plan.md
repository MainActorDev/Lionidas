# Plan — test case duplication + YAML export/import

- Source brainstorm: `brainstorm/20260927T164000Z-testcase-duplicate-and-yaml-io.md` (rev 2, 2026-09-27T17:05:00Z — all questions resolved)
- Created: 2026-09-27T17:20:00Z
- Status: **Ready**

## Decision log

- **2026-09-27, operator (rev 2 of brainstorm):** batch export wanted **as a ZIP** ("way more better if we can zipped them first"); duplicate **jumps into the copy** and must never surface a name collision; import collisions **auto-suffix**.
- **2026-09-27, operator (rev 1):** duplicate any test case; export test cases as YAML; import a test case from a YAML file.
- Zip writer: **fflate** (`zipSync`/`unzipSync`, pure JS, zero deps) — brainstorm proposal, adopted for the minimal-deps posture (server currently has no zip lib; verified 2026-09-27).
- **2026-09-27, operator:** "apply + proceed in a new branch" — review F1–F6 folded (rev 2): import enforces the PUT-level DB-resolution bar via a shared helper; zip transport is JSON `{filename, zipBase64}` (no content-type parser); duplicate column policy enumerated; export skips unknown ids, manifest informational; route-GET→parse pin added.

## Confirmed facts (verified 2026-09-27)

- `templates.name` is `TEXT NOT NULL UNIQUE` (schema.ts:139); ids are `tpl_` + 8 hex (templates.ts:238)
- `POST /api/templates` (templates.ts:236) creates from name + steps (+ appBundleId, ticketKey, tags); `created_by` falls back to `req.user?.name ?? 'unknown'`
- `GET /api/templates/:id/yaml` (templates.ts:541) renders canonical YAML (resolves runFlow ids → names); `PUT /api/templates/:id/yaml` saves document-owns-truth; `POST /api/templates/yaml/validate` parse-checks
- `parseCaseYaml`/`caseToYaml` in `shared/src/case-yaml.ts` are the round-trip contract (88/554)
- Transaction pattern exists (`db.transaction(...)` — forge/routes.ts:253, suites.ts:148, app-screens.ts:41); `requireRole('operator')` preHandler pattern exists (app-screens.ts:208)
- TestCasesPage row = `a2-row-card` (line 728); row opens the editor via `openYaml(t)`; header buttons at 675-676 (`+ case (yaml)`, run-all)
- Server deps: fastify, better-sqlite3, sharp, yaml, pino — no zip lib

## Objective

Users can (1) duplicate any test case and land inside the copy's editor, (2) download any case as YAML and any set of cases as a ZIP of YAMLs, (3) import a `.yaml` (single/multi-doc) or `.zip` back in — all-or-nothing, collision-safe, `draft` status. Done when the closed-loop acceptance passes: export → delete → import reproduces the cases, `pnpm run check` green, and the three UI affordances work in the browser.

## In scope

- `POST /api/templates/:id/duplicate` + row action `duplicate` (jump into copy)
- `GET /api/templates/:id/yaml` download affordance (single export; endpoint exists, UI is new)
- `GET /api/templates/export[?ids=]` → ZIP (`fflate`) with `<slug>.yaml` per case + `manifest.json`
- `POST /api/templates/import` (`.yaml` single/multi-doc or `.zip`; all-or-nothing; `(imported)` suffix) + header `import` flow (file picker → preview → confirm)
- Tests for every endpoint (house TDD)

## Out of scope

- Registry/env cross-ref validation at import (shape-validated only; missing refs name themselves at run time — brainstorm rev 2)
- Editing/merging during import; export of runs/evidence (cases only)
- Multi-user import conflicts beyond name suffixing

## Interfaces

### Duplicate

`POST /api/templates/:id/duplicate` → `TemplateRow` (200) | 404. Server-side, inside `db.transaction`. **Column policy (review F3, explicit):** copy verbatim — steps_json, tags_json, variants_json, setup_json, alerts_policy, entry_json, app_bundle_id, app_name, app_version, udid, logical_w/h, ticket_key, description, default_preset_id (preset may be env-specific; copying keeps the copy runnable where the original ran — if the preset is missing it surfaces as a named run error, same as the original); overwrite — fresh id, name `<orig> (copy)` / `(copy 2)` … (first free, transaction makes the UNIQUE race unobservable), `status='draft'`, `created_by` = current user, fresh created_at/updated_at.

### Export

- Single: UI downloads `GET /api/templates/:id/yaml` bytes as `<slug(name)>.yaml` (slug: lowercase, `[a-z0-9-]`, runs→`-`; new local helper in the route file since no slug helper exists — verified).
- Batch: `GET /api/templates/export?ids=a,b` (missing/empty `ids` = all templates) → `application/zip`, `Content-Disposition: attachment; filename="lionidas-testcases-YYYYMMDD-HHmm.zip"`. Entries: one yaml per template (same bytes as the single endpoint, slugged, `-2` dedupe inside the archive) + `manifest.json` `{ exportedAt, cases: [{ id, name, file, app }] }`.

### Import

`POST /api/templates/import`, `requireRole('operator')`:
- Body is ALWAYS JSON (review F2): `{ yaml: string }` (any number of `---` documents) **or** `{ filename: string, zipBase64: string }` — the UI reads the file client-side and base64-encodes; no new content-type parser on the main app (the only raw-body parser lives on the forge proxy's separate instance — forge/proxy.ts:51). Ceiling: the 8MB bodyLimit (index.ts:54) ⇒ ~6MB zip payload, pinned here as the accepted limit
- Pipeline: split → `parseCaseYaml` each → any error ⇒ 422 `{ error: "document N: <msg>", allRejected: true }` (nothing inserted) → **DB resolution at the same bar as the save path (review F1)**: runFlow names→ids AND variant scenario names against the DB (unknown scenario or duplicate-endpoint conflict ⇒ 422 naming the document and the ref) — factor the resolution block out of PUT /:id/yaml (templates.ts:598-660) into a shared helper both routes call → transaction: insert all (fresh `tpl_` ids, collision suffix ` (imported)`/` (imported 2)`…, `status='draft'`, `created_by`=user)
- Response: `{ imported: [{ id, name }], renamed: [{ from, to }] }`

## Stages

1. **Duplicate API** — route + transaction + name-bump; tests: copy fidelity (steps/tags/variants/setup/entry identical), suffix sequence `(copy)`,`(copy 2)`, `draft` status, 404, concurrent-safety (two immediate duplicates both succeed with distinct names). Deliverable: endpoint green.
2. **Import API (yaml)** — split, validate-all-then-insert (PUT-bar resolution via the shared helper), suffix; tests: single doc, multi-doc, invalid doc rejects all with document+line, collision suffix, runFlow name→id, draft status, **unknown scenario name ⇒ 422 naming doc + scenario (F1)**. Deliverable: endpoint green.
3. **Export API** — fflate dep (`pnpm --filter server add fflate`), single-slug download helper, ZIP endpoint + manifest (**informational only — nothing consumes it; F6**); tests: no-ids = all, ids subset, **unknown ids skipped silently, manifest lists only what exported (F5)**, slug dedupe, manifest shape, each entry re-parses through `parseCaseYaml`, **plus a route-GET→parse pin: fetch `GET /:id/yaml` output for a fully-featured case and parse it (F4)**. Deliverable: endpoint green.
4. **Import API (zip)** — accept `{ filename, zipBase64 }` JSON (F2 transport), enumerate `.yaml` entries (manifest ignored for parsing), same all-or-nothing; tests: zip produced by the export endpoint re-imports (posted back through the base64 JSON contract), corrupt zip ⇒ 422 named, zip with zero yaml entries ⇒ 422. Deliverable: endpoint green.
5. **UI** — TestCasesPage: row `duplicate` action (navigate into copy on success); row `export` action (download); header `export zip` (all-or-filter); header `import` (picker `.yaml,.zip` → preview list via validate → confirm → per-case results). Axiom tokens, one affordance per action. Deliverable: browser-verified flows.
6. **Acceptance** — closed loop scripted in a test: create 2 cases → export zip → delete both → import zip → names suffixed `(imported)` (collision by design) → steps/tags/variants identical to the originals. `pnpm run check` green. Browser pass over the three affordances.

## Edge and failure cases (pinned by tests where meaningful)

- Duplicate of `deprecated` case: allowed, copy is `draft`
- Import with zero documents / empty yaml: 422 "no case documents found"
- Zip with non-yaml files: ignored (only `*.yaml` entries parsed; zero yaml entries ⇒ 422)
- Name exactly at collision with `(imported)` existing: bumps to `(imported 2)`
- Export of zero templates (empty DB): 200 with empty zip + manifest `cases: []`
- Import when unauthenticated/non-operator: 403

## Validation and acceptance

- All stage tests in `server/test/` (vitest), house style
- `pnpm run check` exit 0
- Browser: duplicate jumps into editor with `(copy)` name; single + zip downloads open as valid YAML; import preview → confirm creates `draft` rows
- Closed-loop test green (stage 6)

## Rollout

Branch `feat/testcase-duplicate-yaml-io` off `origin/main`; one PR; human merges.
