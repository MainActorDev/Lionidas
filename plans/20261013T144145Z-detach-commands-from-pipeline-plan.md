# Detach commands from the pipeline — chat-turn skills — PLAN

- Source brainstorm: `brainstorm/20261013T144145Z-detach-commands-from-pipeline.md` (`1e149d7`)
- Created: 2026-10-13T15:00:00Z
- Status: **Ready** — operator took both recommendations ("do with your recommendation. But everything must working correctly")

## Decision log

1. **In-thread Q&A for ALL commands** (operator: recommendation accepted). Gates (`pauseOnQuestion`) remain ONLY on the explicit pipeline path (run panel / API), never for typed commands. Commands ask questions in the thread; the user replies in-thread.
2. **UI switches to chat turns immediately; `POST /api/agent/skill` stays one round for API compat** (operator: recommendation accepted). The endpoint keeps working (chained pipeline runs) but nothing in the web UI calls it after this change.
3. **Bar: "everything must working correctly"** — every migrated flow has an automated test + a live drill: /planning with refs, multi-command, follow-up in same thread, honest failure, reload.

## Objective and completion conditions

Typed `/commands` are ordinary chat turns with a command instruction overlay. Done when:

1. `GET /api/agent/commands` serves the single registry: `{ cmd, description, instructions, order, tools? }` — Composer palette, Thread command tags, and validation read from it (web fetches once, caches; no hardcoded lists remain).
2. Sending a message with command chips posts a NORMAL chat turn: `POST /api/agent/sessions/:id/messages` with `{ content, refs, commands: ['/planning', …] }`. The server stacks instruction blocks in engine order into the turn's system prompt (promptOverlay), the SAME durable log records it, the SAME thread streams the answer.
3. Multi-command works in one turn (stacked blocks, dependency order preserved).
4. Command turns interleave seamlessly with plain turns in the same session (follow-ups see prior command answers via history).
5. The old UI path (`runSkill` → `/api/agent/skill`) is gone from the web; the endpoint itself remains for API callers (chained pipeline runs unchanged).
6. Gates: only the explicit pipeline path parks; a command asking a question does so in the thread (verified live).
7. Suites green; live drills: single command, multi-command, ref+command, follow-up, reload.

## Scope

**In:** butler conversation transport `promptOverlay` (system-prompt block + optional tool filter per turn); lionidas command registry module + endpoint; chat route accepts `commands[]`; web Composer/Thread/AgentChatPage read the registry and send chat turns; removal of the UI skill-call path; tests; drills.

**Out:** changing the pipeline engine or gated runs; changing `POST /api/agent/skill` semantics (frozen as-is for API compat); new commands; UI redesign (the palette/chips from this session carry over).

## Method

**Butler seam (minimal):** `POST messages` body gains optional `commands: string[]` + the registry lives LIONIDAS-side. Butler gains only `ConversationDeps.commandOverlay?: (cmds: string[]) => { instructions: string; tools?: string[] } | null` — the route resolves commands via the registry, composes the overlay into the system prompt for THAT turn, and (if the registry says so) narrows the tool set. Butler stays command-agnostic.

**Registry shape (lionidas `src/agent/commands.ts`):**
```
COMMANDS: Array<{ cmd: '/planning'; description; instructions; order: 1; tools?: string[] }, …>
```
- `instructions` = the COMMAND-SPECIFIC body only (review CR1): planner/breaker bodies move verbatim; **author's strips its embedded `LIONIDAS_SYSTEM_PROMPT`** (profiles.ts:31 embeds the base — the turn builder composes the base once, never twice).
- `order` = engine chain position; multi-command sorts by it.
- One source of truth; the endpoint, the chat route, and the web all import/fetch it.

**Turn composition:** system prompt = `LIONIDAS_SYSTEM_PROMPT` (exactly once — CR1 sentinel-tested) + (for each command in order) `\n\n--- COMMAND /planning ACTIVE — follow these instructions for this turn ---\n<instructions>` + notes block (unchanged). Tool set = **intersection** of registry `tools` with the chat turn's existing permission envelope — commands NARROW, never expand grants (CR3); draft-class actions rely on prompting in chat mode.

**Web flow:** Composer emits `send(text, refs, appBundle, commands)` (command chip labels collected from tokens — already stripped from text). AgentChatPage posts the chat turn with `commands`. The bubble shows command tags (Thread already does, now from the fetched registry).

## Stages

### A — Registry + endpoint (independent value)
`commands.ts` with the three commands (instructions moved verbatim from profiles), `GET /api/agent/commands`, tests (shape, order, descriptions).
### B — Butler `commandOverlay` seam
Optional dep; when present and the message carries commands, compose prompt + optional tool filter for that turn. Butler tests with a fake overlay.
### C — Chat route accepts commands[]
Route resolves via registry, passes overlay, and records the command labels in the user message content with the EXACT convention `ask [cmds: /planning /breakdown] [refs: …]` (CR2) — Thread parses `[cmds:]` for command tags so reloaded history renders them; follow-ups see prior command answers via existing history. Server tests: overlay applied (system prompt contains block), tool narrowing, multi-command order, plain turns untouched.
### D — Web switches to chat turns
Composer send signature + AgentChatPage: command chips ride the chat POST; `runSkill` deleted; Thread reads registry for command tags; palette reads registry (fetch once). Web tests: send carries commands; no `/api/agent/skill` call; palette rows from registry.
### E — Drills + regression sweep (the "everything works" gate)
Live: single /planning with @case ref → answer cites the case (like the earlier drill); /breakdown+/planning multi → one turn, ordered blocks, answer builds on both; follow-up plain question in same thread; reload → bubbles + history intact; kill -9 mid-command-turn → honest failure (durable log). Suites ×3 + tsc ×2.

## Edge cases bound into stages

- Unknown command in payload → honest 400 (registry-validated).
- Registry fetch fails in web → palette falls back to a shared imported constant (the three commands, same module/shape as the registry — NOT a second literal list, CR4) with a loud console warn — never a dead composer.
- Multi-command + refs → both compose; refs ride the same turn.
- Empty commands array → plain turn, zero overhead.
- A command turn interrupted (kill -9) → R3 recovery marks failed; next message works (already proven for plain turns).
- `POST /api/agent/skill` callers → unchanged behavior (frozen path).

## Validation & acceptance

Tests per stage + live drills in E. Explicit: no regression in plain chat, refs, mention palette, @ search, bubbles, streaming, session isolation (the full session's surface — it all shares the turn path being modified).

## Rollout

Fresh branch `feat/commands-as-chat` off main (PR #37 merged first — human gate). Butler seam = small additive change, retag `v0.5.1` (no break). Single PR for lionidas + butler pin bump.
