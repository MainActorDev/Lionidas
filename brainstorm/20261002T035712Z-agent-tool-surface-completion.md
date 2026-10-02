# Agent tool-surface completion — the full authoring+knowledge charter

- Source prompt: "If we can have all those from the list. Do that. Except the 'activate/delete/play/device'" (following the capability-gap survey)
- Created: 20261002T035712Z
- Status: Direction selected

## Goal and context

Complete the agent's tool surface against its charter ("reads everything, drafts cases, learns from runs"), taking EVERY capability from the gap survey except the act-class exclusions the operator reaffirmed: activate/delete/play/device. That includes the two v1 policy gates I flagged — screen-registry writes and recipe reads — which the operator has now explicitly unlocked by saying "all those from the list."

## Confirmed inputs and decisions (operator, this session)

- "If we can have all those from the list. Do that. Except the 'activate/delete/play/device'" — the full list below is IN scope, act-class stays excluded.
- Prior locked decisions that still bind: activation human-only; agent never deletes; scenario activate = act-class.
- Verified route/table facts (2026-10-02): evidence file route `/api/evidence/:id/file` + byPath; per-step triage GET `/api/runs/:id/steps/:idx/triage` and PATCH triage on runs; `/api/flakes`; `case_versions` table; app-level login/logout recipes at `GET/PUT /api/apps/:bundle/login|logout`; screen registry PUT validates + revisions; `case.duplicate` route exists; templates list filters (tags/app/status); dry-run validation exists only implicitly (parseCaseYaml + resolveCaseRefs are exported and composable).

## Exploration — the complete tool list (3 tiers)

### Tier 1 — failure-knowledge loop (why the agent exists)

| Tool | Mirrors | Notes |
|---|---|---|
| `evidence.get` | evidence file route | screenshot/video descriptors + path; MCP image content for screenshots (read the file in-process, return base64 — butler's MCP layer needs an image content-type extension, small) |
| `run.triage.get` | `/api/runs/:id/steps/:idx/triage` | known-failure classifications per failed step |
| `case.versions` | CLI `case versions` / case_versions table | revision history incl. scenario pins per revision |
| `flakes.list` | `/api/flakes` | flaky selector ledger → feeds selector-trust notes |

### Tier 2 — organization & ergonomics

| Tool | Mirrors | Notes |
|---|---|---|
| `folder.create / rename / move` | folders routes ×3 kinds | three trees (cases app-scoped; scenarios/presets global) — the folder-routes-factory already unifies semantics |
| `case.duplicate` | POST duplicate route | plain copy, no yaml required |
| `cases.search` | templates list query (tags/app/status) | returns ids+names+status (shape like cases.list, filtered) |
| `case.validate` | parseCaseYaml + resolveCaseRefs composed | DRY-RUN: full validator + refs gate, saves NOTHING; returns ok/errors verbatim |

### Tier 3 — the unlocked gates

| Tool | Mirrors | Notes |
|---|---|---|
| `screens.draft.save` | PUT /api/apps/:bundle/screens | registry write with draft semantics — hmm: the registry has NO draft concept. Design choice below. |
| `recipes.get` (login/logout) | GET /api/apps/:bundle/login|logout | read-only; the agent drafts `ensure login` steps blind today |

### Design choice for screens.draft.save (author, flagged)

The registry is one live validated document per app (PUT replaces, revision-guarded) — no draft tier exists in the storage. Options:
- **A. Direct write with revision guard (proposal):** tool requires the current revision echo (409 REGISTRY_STALE verbatim when behind), validates through `validateRegistry`, replaces. Matches every route's semantics; the "draft" safety comes from cases referencing screens only at PLAY time — a registry entry that no case references is inert. Risk: replacing a registry DROPS screens not included (route semantics — the tool must fetch-merge or refuse; proposal: the tool REQUIRES the full screen list, refuses if the caller omits existing screens, message says so).
- B. Introduce registry drafts (new table + lifecycle) — a product change beyond the agent layer; defer.
Option A with the must-include-full-list rule is the honest mirror; B is over-engineering for now.

### MCP image content (evidence.get) — dependency

Butler's stdio/HTTP MCP currently returns text content only. For screenshots, extend the tool result to `{type:'image', data: base64, mimeType}` — MCP spec supports it; the SDK's content union already includes ImageContent. Butler change: none needed at the transport (content arrays pass through); the LIONIDAS tool returns the JSON-encoded descriptor and the MCP wrapper maps `.image` results. Keep it simple: evidence.get returns a text descriptor + absolute path + optional inline base64 when `inline:true` and size ≤ 1MB.

## Out of scope (reaffirmed)

Activation (cases/suites/scenarios), ALL deletes, play/run, device operations, user/admin management, forge mode/MITM, queue, matrix.

## Open questions

1. `evidence.get` inline images: is text-descriptor + path enough for Hermes's client, or inline base64 needed? (Probe: Hermes renders MCP image content — verify in the drill; build both, default inline=false.)
2. `screens.draft.save` Option A's replace-full-list semantics: confirm the must-include-all-screens rule (vs append-only single-screen upsert — a SECOND design choice; append-only is safer for models, but diverges from the route).

## Next step

$hms-plan-from-brainstorm on this artifact → staged plan (Tier 1 → 2 → 3, screens/recipes last pending the two answers), then breakdown + implementation on the established TDD pattern.
