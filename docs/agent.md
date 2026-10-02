# The Agent Layer

Lionidas embeds an AI test-case authoring agent (built on
[@mainactordev/butler](https://github.com/MainActorDev/butler), pinned at
`v0.2.0`). It **reads everything, drafts cases, and never touches devices**.

## What it does

An operator chats (or any MCP client connects); the agent searches ingested
sources (tickets, docs, the repo itself), consults the screen registry, and
drafts test cases **through the real validator** — a draft only exists if
`case.draft.save` returned success. Failures surface verbatim and the agent
repairs once. Learned pitfalls are saved as provenance-stamped notes that
ride future turns' system prompt.

## Surfaces

| Surface | Path | Auth |
|---|---|---|
| Conversation API | `/api/agent/sessions*` (sessions, messages, abort, notes, documents) | operator (session cookie or `Bearer lion_…` PAT) |
| MCP (HTTP) | `POST /mcp` (streamable) | operator PAT header |
| MCP (stdio) | `server/src/agent/mcp-stdio.sh` | `LIONIDAS_PAT` env (in-process) |
| Events | `agent.turn` on the events WS bus | — |

## Tools & permission classes (v1 policy: read + draft; act refused)

- **read** — `cases.list`, `case.yaml.get`, `runs.history`, `run.steps`,
  `screens.registry`, `folders.tree` (kind: cases|scenarios|presets),
  `sources.search`, `notes.read`, `suites.list/get`, `evidence.get`, `run.triage.get`, `case.versions`, `flakes.list`, `cases.search`, `recipes.get`,
  `scenarios.list/get`, `presets.list`
- **draft** — `case.draft.save`, `case.draft.edit` (drafts only),
  `case.draft.revise` (active → new draft copy), `case.deprecate`,
  `suite.draft.save/edit`, `scenario.draft.save/edit`,
  `scenario.members.set`, `scenario.duplicate`, `preset.draft.save/edit`, `preset.body.write`, `folder.create/rename`, `case.move`, `case.duplicate`, `case.validate`, `screens.draft.save`, `note.save`,
  `sources.ingest`
- **act (registered, refused + invisible)** — `case.play`, `run.abort`,
  `device.power`; scenario activation and ALL deletes are not tools at
  all. A human plays cases, activates, and deletes.

## Environment (server/.env — gitignored)

```
BUTLER_PROVIDER_BASE_URL=…   # OpenAI-compatible endpoint (z.ai coding, OpenRouter, vLLM…)
BUTLER_API_KEY=…             # never in code
BUTLER_MODEL=…               # e.g. glm-5.3-flash
AGENT_INGEST_REPO=0          # opt out of boot-time repo ingestion (fixtures always seed)
LIONIDAS_PAT=lion_…          # stdio MCP wrapper only (operator token)
```

Absent provider env ⇒ MockProvider with an explicit "not configured" answer
(honest degradation, sessions still work).

## MCP registration (any client)

```json
{ "mcpServers": { "lionidas": { "command": "/bin/bash",
  "args": ["<repo>/server/src/agent/mcp-stdio.sh"] } } }
```

HTTP clients that send auth headers may use `url: http://127.0.0.1:9230/mcp`
directly. Drill log: [docs/agent-drills.md](agent-drills.md).
