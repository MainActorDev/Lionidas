# Lionidas agentic integration — author pipeline (P2)

- Source brainstorm: `brainstorm/20261010T172000Z-agentic-feature-scaffold.md` (Q1–Q3 answered 2026-10-10)
- Depends on: **Butler P1** (`plans/20261010T173000Z-p1-agent-core-plan.md` in the butler repo — profiles, workflows, artifacts, claude-cli adapter, tag `v0.3.0`)
- Status: **Ready** (gated on Butler P1 merge; nothing here starts before that tag exists)
- Plan date: 2026-10-10
- Repo: Lionidas · Branch: `feat/agent-pipeline` from `main`

## Decision log

| # | Decision | Source |
|---|---|---|
| L1 | One assistant = three specialist profiles (planning, breakdown, author) over the EXISTING read/draft tools — no new act tools in P2 | brainstorm ("specialized agents will consist of…") + verified shipped tool registry |
| L2 | Executor per profile from Lionidas env/config (openai-compat glm today; claude-cli when P5) | operator Q1 answer: "make this configurable" |
| L3 | API-first, NO chat UI in P2 (P3 does UI after this ships) | operator Q2 answer |
| L4 | References: Jira subtask, GitHub PR/commit, attached doc, codebase — merged via Butler sources into ONE knowledge artifact (kind `knowledge`), then consumed by stages | brainstorm (accepted direction) |
| L5 | Pipeline outputs = validating draft cases/suites (existing seam) + artifacts: `scope` doc, `breakdown` table, `knowledge` doc — durable, listed, referenceable | brainstorm (accepted direction) |
| L6 | a11y inspector is NOT in P2 (P4: branch+PR, human merges, existing builds) | operator Q3 answer |

## Objective

An operator (or later the chat UI) can start an author-pipeline run against a set of references, watch it stage-by-stage over the API/events, answer the planner's questions, and end with **validating draft cases organized into folders plus a durable artifact set** — using Butler P1 machinery, zero Butler modifications.

## Completion conditions

1. Butler pinned at `v0.3.0` (`@mainactordev/butler@git+…#v0.3.0`); `pnpm check` green.
2. **Profiles** (`server/src/agent/profiles.ts`): `planner`, `breaker`, `author` — each: system prompt (planner = scope/AC extraction + question-asking contract; breaker = organization/dedupe vs existing cases; author = the EXISTING LIONIDAS_SYSTEM_PROMPT), tool subsets (planner: reads+sources+notes; breaker: reads+notes; author: reads+draft+notes), DRAFT policy, executor from env (`AGENT_PLANNER_PROVIDER` etc., default openai-compat glm), budgets per stage.
3. **Reference intake + knowledge stage**: `POST /api/agent/pipeline` with `{ refs: [{kind:'jira'|'github-pr'|'github-commit'|'doc'|'repo', locator, …}] }` → each ref ingested via existing connectors → a **knowledge artifact** compiled (per-ref provenance sections, contradictions/open-assumptions section) — stored via Butler artifacts, id returned.
4. **Pipeline mount**: the three-stage Butler workflow wired: knowledge → planner (may PAUSE with questions) → breaker → author (saves cases via `case.draft.save`, folders via existing folder tools, selector notes). Run rows visible via `GET /api/agent/pipeline/:id` (stage states, artifacts, draft case ids); `POST /api/agent/pipeline/:id/answer` resumes a paused run. All routes operator-gated (existing hook).
5. **Events**: pipeline/stage/artifact/question transitions emitted on the existing bus as typed `agent.*` events (extends the shipped agent event bridge) — WS test proves a pause→answer cycle reaches a subscriber.
6. **Artifacts surface (API-only)**: `GET /api/agent/artifacts?runId=&kind=` list + `GET /api/agent/artifacts/:id` fetch (versioned). (No UI — P3.)
7. **Drill (mock provider, hermetic CI + one live glm drill on the real server)**: fixture ticket + fixture PR + repo path → pipeline run pauses with ≥1 question → answered → completes → N draft cases exist (status='draft', validator-passing), folders organized, 3+ artifacts persisted (knowledge, scope, breakdown), run row terminal. Live drill logged in `docs/agent-drills.md`.
8. Act tools still REFUSED (v1 policy unchanged); no new permissions granted anywhere.

## Out of scope

- Chat UI, artifacts UI, pipeline UI (P3 — sketch round first per the mandatory rule)
- a11y inspector (P4); claude-cli real executor (P5; adapter exists in Butler)
- Real-Jira creds (still env-gated, fixture path unchanged)
- Changes to Butler core (any gap → Butler PR, pinned forward)

## Architecture

```
server/src/agent/
  profiles.ts        planner/breaker/author AgentProfiles (L2 executors from env)
  knowledge.ts       refs → ingested sources → compiled knowledge artifact
  pipeline.ts        WorkflowSpec build + mount: knowledge → plan → breakdown → author
  pipeline-routes.ts POST /api/agent/pipeline, GET :id, POST :id/answer, artifacts routes
  (existing) tools/policy/routes/events stay — the pipeline is a consumer of them
```

## Stage order

1. Pin butler `v0.3.0`, profiles.ts + env config (C2)
2. knowledge.ts + refs intake route (C3)
3. pipeline.ts three-stage workflow + pause/answer + events (C4, C5)
4. artifacts routes (C6)
5. Hermetic drill + live glm drill + docs (C7, C8)

## Validation

- Contract tests: profile resolution w/ env executors; knowledge compile from fixture refs (provenance sections asserted); workflow pause/resume via API; artifacts versioning; event bridge.
- Live drill per C7 on the real server (mock + glm legs), logged.
- Gates: server tsc + full suite green; web untouched (40/40 stays).

## Handoff

- P3 (chat/pipeline UI) starts ONLY after this merges: sketch round ≥3 variants → pick → build. P4 (a11y) and P5 (claude-cli live) queue behind it.
