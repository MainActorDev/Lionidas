# Agent round 2 — C-limits, skills-in-chat context, contract cleanup

- Source prompt (verbatim excerpts): "C2. Do it / C3. MCP will be my daily provider / C4. I still don't get it / Butler tag hygiene: don't worry about it, we still in development phase. / Event contract cruft: Do it / c1b: do it / Why the '/planning' skips the knowledge page? / As a user, I want to be able to use skills '/planning' along with my regular chat. For example: 1. I run '/planning'. 2. Then I want to follow-up something regarding the '/planning' output 3. The LLM should know the context and can follow up my request"
- Created: 2026-10-12T03:40:31Z
- Status: Exploring

## Goal and context

Three workstreams from the operator's triage of the limits list plus one design gap:

A. **Execute now** (explicit go): C2 retrieval-based memory, C3 persistent MCP process (claude-cli becomes the daily provider), event-contract cleanup (delete the deprecated `tool.call`/`tool.result` duplicates), C1b better-sqlite3 bump.
B. **Explain**: C4 agent evals — the operator doesn't understand the proposal yet. Needs a plain-English explanation with a concrete example before deciding.
C. **Design + build**: skills-in-chat context — `/planning` runs, then a follow-up chat message should see the planning output as conversation context. Today the skill turn is a separate workflow run whose transcript contribution is only persisted-for-display (rev `319ea0c` writes command+answer rows); the CHAT provider's context is the session's message list, so follow-ups DO have the rows available — the gap is that chat turns don't currently inject them as context (session messages ARE the chat context, so the mechanism may already half-work; must verify what the chat provider actually receives), and knowledge-page grounding for skills.

Confirmed decisions already given: no work on tag hygiene (dev phase).

## Confirmed inputs and decisions

- C2: approved.
- C3: approved — and claude-cli/MCP will be the DAILY provider, so the spawn tax is a per-turn daily cost, raising priority.
- C4: NOT approved yet — explain first, decide after.
- Tag hygiene: dropped (dev phase).
- Event cruft: approved.
- C1b: approved.
- Skills must become part of the chat conversation: follow-up messages reference skill output naturally.

## Exploration

### Why /planning skips the knowledge page (answer, verified in code)

`pipeline.skill()` (server/src/agent/pipeline.ts:111) builds a one-stage WorkflowSpec whose stage input is `{ask, appBundle}` — it never calls `compileKnowledge`, because compilation is driven by refs (`PipelineRef[]`) and skills take none. The planner grounds itself with live read-tools (`cases.list`, `screens.registry`, `sources.search`) instead of compiled memory. That was a shortcut from rev 20, not a principled choice.

### The follow-up gap — what actually happens today

The chat provider's context = the session's message rows (user + assistant). Since `319ea0c`, a skill run persists BOTH the command and the final answer as session rows. So a follow-up chat turn in the SAME session should already see the planning output… IF the chat provider's context window includes those rows (they are ordinary messages). What's missing or half-built must be verified live before designing:
1. Do follow-up turns actually receive the skill rows? (Suspect: yes — but tool traces/streaming only lived client-side, and the persisted answer loses the tool-call narrative.)
2. /planning does NOT read the knowledge page → if the user referenced @jira earlier in a PIPELINE run in the same session, the skill doesn't see that compiled knowledge.
3. Skills can't take refs today (composer commits the command chip; refs are dropped when a skill fires — verify).

### Options for skills-in-chat context

**Option 1 — session-transcript continuation (recommended core).** Skills already write their command+answer rows into the session (319ea0c). Verify + harden: follow-up chat turns see those rows because they're ordinary messages. Add: the skill's TOOL narrative as a compact system-ish row ("used cases.list (3), screens.registry…") so the model knows HOW the answer was derived, not just what it concluded. Cheap, no engine change.

**Option 2 — skill runs also read the knowledge page.** Resolve the app (same chain as pipeline) and inject the latest `app:<bundle>` knowledge page into the planner prompt alongside live tool reads. Makes skills and pipeline share grounding; costs tokens per skill run; the page may be stale vs live tools — treat page as background, tools as truth.

**Option 3 — full unification: skills = pipeline stages callable mid-chat.** The chat turn itself becomes able to invoke a workflow and inline its result (agentic tool-call style). Most powerful, largest change; overlaps with what the slash flow already does. Defer unless 1+2 prove insufficient.

Recommended: 1 + 2. That makes the example flow work: `/planning` → answer lands in transcript → follow-up "expand section 2" sees the whole plan; and if earlier pipeline runs compiled knowledge for the app, the planner benefits from it too.

### C2 — retrieval-based memory (design sketch)

- Embed at save: `note.save` computes an embedding (provider env-gated; openai-compat embeddings endpoint) stored in a new column/table in the agent DB.
- Retrieve at prompt-build: embed the current ask + active session context, cosine top-k (k≈8) over active notes, inject instead of the flat top-20.
- Hermetic: injectable embedder; tests assert ranking + injection shape. Offline/env-less → honest fallback to recency top-20.
- Butler seam: the memory contract (memory/contract.ts) — add optional `embed(text)` to storage or a MemoryRetriever wrapper; keep Lionidas supplying the concrete embedder.

### C3 — persistent MCP process (design sketch)

- claude-cli provider currently spawns per complete(). Change: a singleton child (spawn on first use, reuse; crash → respawn with backoff; idle TTL for daily-driver safety), keeping the existing stream-json adapter.
- The GLM middleware wrapping stays. Config: BUTLER_MCP_PERSISTENT=1 default-on, disable switch for tests.
- Risk to check: claude-cli `--resume` statefulness (documented hazard) — persistence makes conversation pinning stickier; verify session isolation per Lionidas chat session.

### Event contract cleanup

- butler: stop emitting `tool.call`/`tool.result` (loop.ts) — `turn.tool` is canonical since v0.3.4. One release note. Lionidas consumes only turn.* today (verify with grep) → no consumer break.

### C1b — better-sqlite3 bump

- server: bump better-sqlite3 to latest (11.11.x line or 12.x if out), drop `.npmrc` build-from-source if prebuilds cover node 24.20, cleanroom boot test on 24.20 + fresh install (the exact crash recipe), keep `.nvmrc` pin regardless.

### C4 — the explanation to give (not yet a task)

Plain-English: an eval is a smoke test for the AGENT, not the code. Example: "plan tests for CUST-6001" → the eval script runs it and scores: did it produce valid YAML? did it cite screens that exist? did it cover the ticket's AC lines? Run before/after any prompt or model change; the score tells you if the change helped. Without it, every prompt tweak is judged by feel. Deliver as a short doc section + offer to build the golden set.

## Risks / edge cases

- Skills-in-chat: persisted answer loses the tool narrative → follow-ups can't audit reasoning (mitigation: compact tool-trace row).
- Knowledge page staleness (option 2): page says X, tools say Y → prompt rule: tools win, page is background.
- C3: child-process lifecycle bugs (zombie respawns) need a hard cap + health check.
- C2: embeddings provider down → recency fallback must keep chat working (honest degradation).
- Everything must stay green on: server suite, web suite, butler suite, tsc ×3.

## Open questions

1. Skills + refs: should `/planning` accept @refs chips too (compile-on-skill)? (Natural extension once option 2 lands.)
2. For C2 embeddings: reuse the GLM/openai-compat endpoint env, or a separate EMBED_* env pair?
3. C4: after the explanation, build the golden set this round or defer?

## Next step

Answer the three questions (or accept recommendations: yes to skills+refs; reuse BUTLER_* endpoint with EMBED_MODEL override; defer C4 build until explanation lands), then `/plan` this into a staged round: F1 skills-in-chat transcript (verify+harden), F2 knowledge-page grounding for skills, F3 C2 memory, F4 C3 MCP persistence, F5 event cleanup + C1b bump.
