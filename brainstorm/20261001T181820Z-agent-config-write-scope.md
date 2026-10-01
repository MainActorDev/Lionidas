# Agent write scope beyond test cases — suites, network scenarios, presets, lifecycle

- Source prompt: "Can the MCP do update/edit operations of existing testcase, suite, network scenario/preset and so on?" → "Brainstorm first"
- Created: 20261001T181820Z
- Status: Questions open

## Goal and context

The integrated agent (v1, authoring-only) can read cases and save/edit case drafts, but cannot see or touch suites, network scenarios, traffic presets, folders (beyond implicit create), or case lifecycle (draft→active). The user wants to explore extending the MCP tool surface to manage these entities. Interpretation: extend the agent from "case author" toward "test-config author" — still no device/act operations.

## Confirmed inputs and decisions (verified facts)

- Existing agent tools: `cases.list`, `case.yaml.get`, `case.draft.save`, `case.draft.edit` (full-yaml, real validator, 409s verbatim), read/notes/sources tools. V1 policy = read+draft; act tools registered-but-invisible (`case.play`, `run.abort`, `device.power`).
- Route inventory (server/src): suites CRUD at `/api/suites` (member validation, bundle scoping: suite scope = first member's bundle; mixed packs 400). Scenario CRUD at `/api/forge/scenarios` (+`/members` PUT, `/duplicate`, `/activate`; `immutable_since` locks scenarios referenced by runs). Preset CRUD at `/api/forge/presets` (+`/body` PUT). Folder trees for cases/scenarios/presets with move/rename and guarded deletes (409 names both counts). Template status transitions exist in PATCH (draft|active|deprecated) with validation.
- The v1 policy decision: "authoring-only — reads everything, drafts cases, never touches devices" (brainstorm 20261001T035356Z, accepted).
- User-stated constraint (standing): no hardcoded creds; explicit > silent; user gates merges; honest degradation.

## Exploration

### What "edit" means per entity — risk differs

| Entity | Edit risk | Why |
|---|---|---|
| Case (draft status) | low | already shipped; drafts are inert until a human activates |
| Case (active status) | **medium** | editing a production definition changes what "pass" means; history lives in case versions |
| Case status → active | medium | activation is the publish gate; v1 keeps humans as the approver of record |
| Suite members | medium | suites are what CI/queue plays; a hallucinated member silently changes coverage |
| Scenario (definition) | medium | `immutable_since` already locks referenced ones — the DB enforces the safe edge for us |
| Scenario `/activate` | **act-class** | applies a network conditioner to a live device — that's the refused class |
| Preset body | low | stub data; worst case a mocked response is wrong → test fails loudly |
| Folders | low | navigation/metadata; guarded deletes |
| Deletes (any) | high | even with 409 guards, chat-driven deletion is where a wrong argument is expensive |

### Options

**Option A — reads-only expansion (safest).** Add `suites.list/get`, `scenarios.list/get`, `presets.list/get`, folder trees per kind. Agent sees everything, writes stay case-drafts. Cost: the user's actual ask (edit) is unmet; the agent stays blind to the config it might need to reason about (e.g. "which suite covers checkout?").

**Option B — config-author tier (proposal).** Reads for everything + create/edit (no delete, no device activation) for suites, scenarios, presets, folders, mirroring route logic in-process like `case.draft.*`: member/bundle validation errors verbatim, `immutable_since` refusals verbatim, collision 409s verbatim. Case edits stay draft-status (editing an active case produces a new draft version of it — reuses the existing versions machinery — never mutates active in place). Lifecycle: agent may **deprecate** on explicit request, never activate. Deletes stay human.
Rationale: matches the proven pattern (validator-decides, honest errors, one repair round); the dangerous edges (devices, deletion, publish) remain human; `immutable_since` and 409 guards already exist server-side so the tools inherit safety rather than reinvent it.

**Option C — full CRUD incl. deletes with two-step confirm.** Adds `*.delete` tools that require a confirm token pattern (call once → get token; call again with token → delete). Most convenient, highest blast radius; a model that learns the token dance can delete on a misread prompt. Guards help (non-empty folder 409) but cases/suites/scenarios delete clean.

### Where the line should sit (hypothesis, not decided)

Keep three tiers: read (everything), config-write (definitions, Option B set), act (devices + publish + delete = human). The existing permission enum is `read|draft|act` — Option B fits inside `draft` (rename mentally to "author"); no butler change needed.

### Edge cases worth pinning in any plan

- Suite bundle scoping: agent must resolve scope from members exactly like the route (first member wins; else explicit `appBundleId`) or mixed packs 400.
- Scenario edit on an immutable scenario → verbatim refusal, agent should then suggest duplicate-and-edit (route exists).
- `runFlow` refs inside an edited case must still resolve (validator already enforces at save).
- Folder move across apps (cases) — the 409 semantics the drill hit.
- Preset body editing on binary/zip presets — cap and sniff, same as import.

## Open questions

1. **Publish gate:** may the agent ever set a case/suite live (active), or is activation strictly human in this tier too? (Changes acceptance and possibly the web UI's approve flow.)
2. **Deletes:** confirm Option B's "no agent deletes ever" — or is a scoped exception wanted (e.g. delete *draft* cases the agent itself created, by id, same-session)?
3. **Scenario `activate`:** confirm it's act-class (it conditions a device) and stays invisible — nothing in this expansion should make device-adjacent tools visible.

## Next step

Answer the three questions (or say "B as proposed"), then run $hms-plan-from-brainstorm on this artifact to produce the tool-list plan; implementation is a small delta on the existing draft-tools pattern.
