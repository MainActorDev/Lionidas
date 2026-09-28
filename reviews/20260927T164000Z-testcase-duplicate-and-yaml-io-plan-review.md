# Review — test case duplication + YAML export/import plan

- Reviewed plan: `plans/20260927T164000Z-testcase-duplicate-and-yaml-io-plan.md`, Status **Ready** (2026-09-27T17:20:00Z)
- Evidence: plan + brainstorm rev 2 (20260927T164000Z); live code reads 2026-09-27 — templates.ts:236-248 (POST create), :541-587 (GET yaml), :588-660 (PUT yaml incl. runFlow + scenario resolution), schema.ts:139/226/251-274, index.ts:54 (bodyLimit 8MB), forge/proxy.ts:51 (existing raw-body content-type parser pattern), case-yaml.ts:554+ (emitter fields), case-yaml-roundtrip.test.ts (existing parse→emit→parse pins), TestCasesPage.vue:672-760
- Verdict: **Needs revision** — one High (semantic bar mismatch between import and the existing save path), one High (zip body transport), mediums. No operator questions blocking; all are plan edits.

## Traceability

Operator decisions → plan: zip batch export ✓ (stage 3), jump-into-copy + invisible collisions ✓ (stage 1/5), `(imported)` suffix ✓ (stage 2), closed-loop acceptance ✓ (stage 6). All repo facts I re-verified held (file:line accurate).

## Findings

### F1 — High · import's validation bar is LOWER than the existing save path, breaking the closed loop and the house honesty rule

Plan stage 2 imports with `parseCaseYaml` (shape) + runFlow name→id, and scope says registry/env refs are "shape-validated only". But the **existing save path enforces more**: PUT /api/templates/:id/yaml (templates.ts:598-633) also resolves **variant scenario names against the DB** — `unknown scenario "x"` → 422, plus a duplicate-endpoint check across a variant's scenario set. An import that accepts a variant referencing a scenario that doesn't exist in this environment creates a case the editor itself would refuse to save — the closed-loop test would pass (loop is same-DB) while cross-environment imports silently degrade. Correction: import reuses the same DB-resolution checks as PUT (factor the resolution block into a shared helper or call the same function; scenario-name + duplicate-endpoint checks included), producing 422s named per document. Cross-env answer stays honest: the import REFUSES unknown scenarios rather than deferring to run time. Verify: test importing a doc with an unknown scenario name ⇒ 422 naming it; test with known scenarios passes.

### F2 — High · zip import transport unspecified and non-trivial under Fastify

Plan says "raw `application/zip` bytes" but Fastify's default JSON parser will 415/400 a non-JSON content type; the only existing raw parser (`addContentTypeParser('*', …)`) lives on the **forge proxy app** (forge/proxy.ts:51), a separate Fastify instance — not inherited by the main app. Also unspecified: the UI sending zip bytes (fetch with `FormData` vs raw body), and the 8MB bodyLimit interplay (index.ts:54 — fine for realistic archives, worth pinning as a limit in the plan). Correction: stage 4 must specify — main app gains a content-type parser for `application/zip` (+ `application/x-zip-compressed`) parsing as buffer, OR (simpler, zero-parser option) the UI reads the file client-side and POSTs `{ zipBase64 }`/`{ filename, zip: <base64> }` JSON; pick ONE (recommend JSON+base64: no server parser change, one code path, 33% size overhead acceptable under 8MB limit). Verify: stage-4 test posts the export endpoint's zip output back through the chosen transport and it imports.

### F3 — Medium · duplicate copy list says "every column except id/name/…" but some columns are operational, not authored

Row columns include `udid` (device binding), `default_preset_id`, `app_version`, `logical_w/h`, `ticket_key`, `status`, `created_by`, timestamps. Copying `udid`/`app_version` verbatim is probably right (same target context), but the plan should enumerate the column policy explicitly rather than "every column except…", because `default_preset_id` references a preset that may be environment-specific — acceptable to copy, but say so. Correction: list the exact copy set in stage 1. Verify: test asserts the copy's full column set.

### F4 — Medium · single-case export bytes ≠ import-compatible in one direction

The GET /:id/yaml output includes fields the parser consumes, and the emitter's first line is a `# comment` — fine. But the plan's UI single-export downloads GET bytes while import expects documents that `parseCaseYaml` accepts; the existing roundtrip test pins parse→emit→parse, not **route-GET→parse**. Low risk (same emitter), but the acceptance should pin it once: a test fetching the route's yaml and parsing it. Correction: add to stage 3 tests. Verify: green test.

### F5 — Low · export `?ids=` semantics for unknown/deleted ids unspecified

`GET /export?ids=ghost` — 404? skip silently? Plan silent. Recommend: skip + manifest lists what was actually exported; a 404 would make partial export impossible. Verify: test with one valid + one unknown id exports one entry.

### F6 — Low · manifest.json is not pinned as a contract

Stage 3 names the fields but nothing consumes it (import ignores it). Either pin it as informational-only (say so) or drop it. Recommend: keep, informational, one test asserting its shape.

## Human questions

None blocking. (If F2's transport choice — JSON+base64 — is objectionable, say so; otherwise it's adopted as the simpler contract.)

## Required plan edits

1. Stage 2: import enforces the SAME DB-resolution bar as PUT yaml (scenarios + runFlow + duplicate-endpoint), via a shared resolution helper; unknown scenario ⇒ 422 (F1)
2. Stage 4: pin zip transport — JSON `{ filename, zipBase64 }`, no new content-type parser; note the 8MB bodyLimit ceiling (F2)
3. Stage 1: enumerate the exact copied-column policy incl. default_preset_id/udid/app_version (F3)
4. Stage 3: add route-GET→parse round-trip pin; F5 skip-unknown-ids semantics; F6 manifest declared informational (F4-F6)

## What remains to validate during implementation

- fflate zipSync/unzipSync behavior on real archives (CRC, empty zip) — tests will prove
- Browser: download filename handling, import preview rendering, jump-into-copy navigation
- Concurrency of duplicate (two parallel POSTs) — test simulates
