# Detach slash commands from the pipeline — commands as chat-loop skills (Claude Code / ChatGPT model)

- Source prompt: "That's why I'd like to rethink the 'pipeline' implementation. Can we detach it? Right now, I want those slash commands to work exactly like a regular chat app. Follows other proven agentic chat apps like ChatGPT or Claude. Research if needed" (+ skill invocation)
- Created: 2026-10-13T14:41:45Z
- Status: Direction selected (research-backed); 2 questions open before plan

## Goal and context

The user wants `/planning`, `/breakdown`, `/author` to behave **exactly like a regular chat app's commands** — the way Claude Code and ChatGPT treat them — instead of spawning a workflow/pipeline run. Motivation: the pipeline coupling is why commands don't scale (5 files, 4 registries — verified last turn) and why the UX diverges from what people know (run panel, held HTTP, gate semantics instead of a chat answer).

## Confirmed inputs and decisions

1. Operator verbatim: rethink the pipeline implementation; **detach it**; slash commands should work "exactly like a regular chat app"; follow proven agentic chat apps; research if needed. (Research done — see below.)
2. Verified current state (this session): command registries duplicated in 5 files/4 registries; `skill()` builds workflow specs per call; the skill route holds HTTP for whole runs; chained multi-command rides `runWorkflow` stages; chat route itself is pure (0 pipeline refs).
3. Existing durable base (R3): chat turns are event-sourced with tool_call events, usage meters, queues; the chat loop already streams.

## Research — how the proven apps actually do it (fetched from code.claude.com docs, 2026-10-13)

- **Claude Code:** "Custom commands have been merged into skills… A file at `.claude/commands/deploy.md` and a skill at `.claude/skills/deploy/SKILL.md` both create `/deploy` and work the same way." A skill is **a markdown body of instructions loaded into the SAME conversation when invoked** — "the skill's body loads only when it's used." There is no second engine: `/deploy args` = inject the skill's instructions + args as the turn's context, run the ordinary agent loop. Frontmatter controls execution mode (who invokes, tool pre-approvals, optional subagent execution) — but the DEFAULT is the same chat loop.
- **ChatGPT:** custom instructions/GPTs are system-prompt-level guidance — one loop, one conversation; "commands" like /image are still a single turn in the same thread.
- **The convergent model:** a slash command is **prompt-layer composition, not execution-layer branching**. `/cmd args` → the command's instructions + the user's args become ONE turn in the SAME session/conversation, executed by the SAME loop with the SAME tools, rendered in the SAME thread. Multi-command = multiple instruction blocks stacked in one turn (or consecutive turns), not a stage graph.

## Exploration

**Option A — commands as chat turns (THE PROVEN MODEL, chosen direction):**
`/planning plan vouchers` sends a normal chat message whose *effective system prompt* = base prompt + the command's instruction block; the turn runs in the SAME session, streams in the SAME thread, uses the SAME durable event log. The answer lands as a chat bubble.
- Commands become a **single registry**: `{ cmd, description, instructions, tools?, order? }` served to the UI (`GET /api/agent/commands`) — the palette, bubbles, route validation, and multi-command composition all read it. Adding a command = adding one registry entry (+ its instruction text). The 5-file/4-registry problem dies.
- Multi-command "engine order" survives trivially: stack instruction blocks in dependency order (`planning → breakdown → author`) into ONE turn — or consecutive turns in one session when chaining context matters. The model does them in sequence in one conversation, exactly like asking Claude Code to "plan then break down".
- **What we keep the pipeline for (detached, not deleted):** gated long-runs (`pauseOnQuestion`, awaiting_gate advance) and future batch work — invoked EXPLICITLY (run panel, an eventual `/run` heavy command, or API callers), never as the default path for typed commands.
- Trade-offs: per-command tool allowlists/system prompts must ride the turn (butler conversation transport gains an optional `promptOverlay`); the run panel won't show typed commands anymore (they're chat turns — the tool rail + durable log already show the same truth); gate semantics (pause/answer) do NOT exist in chat-mode commands — the model asks its question IN the thread (which is what Claude Code does) instead of parking.

**Option B — keep pipeline underneath, better facade (rejected):** fixes scaling (registry) but keeps the UX fork (run panel, held HTTP, gates) — precisely what the user wants gone.

**Option C — full pipeline deletion (rejected):** gated runs are genuinely used (drills parked at awaiting_gate; the answer/advance flow) and batch C4 evals will want the engine.

## Proposed direction

**Option A**, in three stages: (1) command registry table + `/api/agent/commands` + UI reads it (kills duplication now, independent of the rest); (2) butler conversation transport accepts a `promptOverlay` (command instruction block + tool allowlist) and the chat route routes typed commands through it — commands become chat turns, same thread, same log; (3) the legacy `POST /api/agent/skill` + `skill()` chain path retires to explicit/pipeline-only use (run panel), with the UI's command flow switched to chat turns.

## Open questions

1. **Gate semantics in chat-mode commands:** today `/planning` can `pauseOnQuestion` (run parks, panel asks, resume). In the chat model the model asks in-thread and the user replies in-thread (Claude Code style). Is in-thread Q&A an acceptable replacement for ALL commands, or does any command need to STAY a gated run? (Recommendation: in-thread for all; gated runs remain only via explicit run-panel/API use.)
2. **Should the legacy `POST /api/agent/skill` endpoint be retired for UI use entirely** (UI only sends chat turns), or kept as the bridge until C4 evals validate the new path? (Recommendation: switch UI immediately, keep endpoint one round for API compatibility.)

## Next step

Answers to the two questions → `hms-plan-from-brainstorm` → review → implement on a fresh branch (the registry stage can land independently first — it's valuable even if direction adjusts).
