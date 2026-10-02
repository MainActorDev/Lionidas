# Review — Agent tool-surface completion plan

- Plan reviewed: `plans/20261002T035712Z-agent-tool-surface-completion-plan.md` (Ready, commit `7ad6ca7`)
- Evidence: plan + brainstorm `20261002T035712Z` + operator answers ("all those from the list… except activate/delete/play/device", "as proposed"); sources read 2026-10-02: `server/src/routes/evidence.ts` (file + byPath), `runs.ts` (triage GET shape), `flakes.ts`, `templates.ts:906` (versions route — full column list), `app-screens.ts` (replaceRegistry: revision persists across replaces, delete-then-insert, app_login untouched), `folder-routes-factory.ts` (shared semantics incl. depth cap 8), `folders.ts` (cases tree is BESPOKE, not the factory), schemas: evidence / case_versions / app_login / app_logout.
- **Verdict: Ready for implementation (plan rev 2 carries F1–F4 corrections in place)** — no Critical/High findings; 4 Medium/Low findings, all additive, applied to the plan the same session (see Required plan edits).

## Traceability

Operator list → tiers: every named capability maps to a stage/tool (evidence/triage/versions/flakes → S1; folders/duplicate/search/validate → S2; screens+recipes → S3; prompt/docs/drill → S4). Act-class exclusions restated in scope ✓. Both design choices (screens Option A, evidence inline) carry operator provenance ✓.

## Findings

### F1 — MEDIUM — `evidence.get` by step, not just by id (plan S1 underspecifies the lookup path)

- Evidence: evidence rows attach to steps via `run_steps.evidence_ids_json`; the agent's natural question is "show me the failure screenshot of run X step 3" — the plan's tool takes an evidence id, but the model will have the run/step pair from `run.steps` (which returns no evidence ids — checked: `run.steps` selects narrate/reason only).
- Correction (applied): `evidence.get` accepts EITHER `evidenceId` OR (`runId` + `stepIdx`) — the latter resolves `evidence_ids_json` and returns all attached evidence descriptors (first screenshot when `inline:true`, per the 1MB cap).
- Verify: test seeds a step with 2 evidence ids; both lookup modes return the same rows.

### F2 — MEDIUM — `case.versions` must mirror the REAL route shape, and the plan's yaml_canonical promise needs the pinned columns

- Evidence: `GET /api/templates/:id/versions` (templates.ts:906) selects `id, revision, steps_sha256, yaml_canonical, scenario_id, scenario_snapshot_json, source, created_by, created_at` ORDER BY revision DESC — the plan names a subset.
- Correction (applied): tool returns the full column set verbatim (yaml_canonical included, as planned); order revision DESC.
- Verify: parity test against the route on identical seed.

### F3 — MEDIUM — Screens revision echo: `replaceRegistry` semantics make the CURRENT-revision query part of the contract

- Evidence: revision PERSISTS across replaces (read MAX(revision) before delete, +1 on insert); the route's stale check compares the echoed body revision to `COALESCE(MAX(revision),1)` — a brand-new bundle starts at 1, first replace lands 2.
- Correction (applied): `screens.draft.save` computes current the SAME way and its refusal text mirrors `registry changed while you were editing` + `REGISTRY_STALE` + current revision (so the model can retry with the echoed value); plan's "new bundle → revision 1" note corrected to "current = 1 for a new bundle (COALESCE), first write lands 2".
- Verify: stale-echo test asserts the exact 409 text and the returned revision.

### F4 — LOW — Folder tools: two implementations exist (cases bespoke at `folders.ts`, scenarios/presets via the factory) — the tool layer must not assume one shape

- Evidence: cases folders are app-scoped with their own move endpoint (`POST /api/folders/move`); scenario/preset trees share `folder-routes-factory` (depth cap 8, sibling-unique, delete-guard naming both counts — delete stays out of scope).
- Correction (applied): plan S2 wording now states the per-kind mirroring targets (cases → folders.ts semantics incl. app scoping; scenarios/presets → factory semantics incl. depth cap), cycle guard verbatim.
- Verify: per-kind tests, incl. move-into-descendant refusal.

### Not findings (checked, fine)

- `case.validate` dry-run composes exported functions only — no persistence risk.
- `recipes.get` reads app_login/app_logout (PK bundle_id, revisioned) — read-only, no policy conflict.
- `flakes.list` mirrors `/api/flakes` incl. quarantine state — flow_quarantine released_at IS NULL filter verified.
- MCP inline image: base64 in a text tool result (≤1MB) — no transport change needed; ImageContent passthrough remains a future nicety, disclosed.

## Required plan edits (applied to the plan in place — F1–F4 corrections above)

S1 evidence lookup modes; S1/S2 column/shape fidelity notes; S3 revision arithmetic + verbatim stale text; S2 per-kind folder semantics. No scope change.

## What remains for implementation to validate

All execution-shaped claims (verbatim strings, no-partial-write, inline cap behavior, drill behavior through Hermes) land in stage tests + the S4 drill — this review inspected the plan against source, not the running system.
