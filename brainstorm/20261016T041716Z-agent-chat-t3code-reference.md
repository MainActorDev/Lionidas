# Agent chat UI revamp — t3code as reference architecture

- Source prompt: “While we at it, for the next part, I'd like to revamp the agent chat UI. And I want you to clone this repo @url:https://github.com/pingdotgg/t3code and put it somewhere. I want you to analyze the codebase and learn it, I'd like for this repo to be our reference for creating a stable agentic chat feature. Especially, that this repo supports multiple frontier agentic tools like Claude, Codex, Opencode, and so on. Learn how they handle response stream, tool calls, code editing, and so on rendering in the UI.”
- Created: 2026-10-16T04:17:16Z
- Status: Exploring — codebase analysis done (first pass), design direction not yet chosen

## Goal and context

The user wants the **next phase (Phase 5) to revamp Lionidas' `/agent` chat UI**, using `t3code` (Theo's open-source multi-provider coding-agent GUI, ~500k users) as the **reference architecture** for a stable agentic chat. The explicit learning targets: response streaming, tool calls, code-edit rendering in the UI, and how one UI serves multiple agent backends (Claude Code, Codex, OpenCode, Cursor, Grok, Antigravity, Pi).

Interpretation (not confirmed): t3code is a *reference to learn from*, not a dependency to adopt wholesale — Lionidas keeps its Vue 3 stack, Factory design language, scoped-CSS mechanism (settled 2026-10-15 after the 040 rejection), and its existing butler-based agent backend. The revamp targets the chat UI's **rendering model and stability**, not a rewrite of Lionidas' server.

## Confirmed inputs and decisions

- Clone done: `ai/t3code` (depth 50, commit `9b150f79`, 2026-10-15). 28k+ files.
- User-confirmed intent: t3code is the reference for a stable agentic chat; the specific areas to learn are response stream, tool calls, code editing rendering.
- Lionidas standing constraints: brainstorm → plan → review → implement per phase; scoped CSS + selective shadcn primitives; Factory dark tokens; self-hosted QA harness gates.
- Existing Lionidas agent chat surface: `web/src/pages/agent/` (AgentChatPage, Composer with mention palette + caret-metric regressions, markdown, highlight tests — ~35 test files) on a butler transport with claude-CLI child; `crucible` skill references `agent-chat-ui.md` and `agent-chat-seams.md` hold the current architecture.

## t3code analysis — what the reference actually does (verified from source)

### 1. Architecture: event-sourced orchestration with provider adapters

- **Server owns everything** (`docs/internals/overview.md`): provider CLIs run as server subprocesses. Clients are thin — typed WebSocket RPC (`packages/contracts`) with subscription-based state (a client viewing one thread doesn't pay for every thread's history).
- **Pure orchestrator** (`apps/server/src/orchestration-v2/Orchestrator.ts`): commands → events, no I/O. An **EventSink** commits events + projections + command receipt + outbox effects in ONE transaction; an **EffectWorker** runs side effects (starting provider turns, checkpoints) after commit and feeds results back as commands. Command ack = intent committed, not work finished.
- **Adapter boundary** (`Adapters/*AdapterV2.ts` per provider): each provider's native protocol (Codex app-server JSON-RPC, Claude SDK/CLI transcripts, OpenCode 1.x/2.x, ACP...) is translated into ONE normalized event vocabulary. "Complexity belongs at the adapter boundary. Orchestration stays pure, UI stays dumb."
- **Checkpoints** (hidden git refs) per turn → diff/restore without touching the user's branch.

### 2. The rendering vocabulary: TurnItems + WorkLog + TimelineEntry

The core idea Lionidas should steal — **the UI never renders raw provider events**:

- `OrchestrationV2TurnItem` (`packages/contracts/src/orchestrationV2.ts:1463`, a union of ~25 typed item shapes): `message`, `reasoning`, `command_execution`, `file_change` (with `OrchestrationV2FileChangeDetail` per-file op/path/oldPath), `mcp_tool_call`, `dynamic_tool`, `user_input_request`, `permission_request`, `checkpoint` (files summary), `error` (failure class + bounded message + retry), `compaction`, `handoff`, `fork`, `subagent`, `secret_request`, `web_search`, `file_search`, `html_render`, `mcp_app`, `system_notice`, `run_interrupt_*`. Every item shares base fields: `status` (idle/pending/running/waiting/completed/failed/cancelled/interrupted), `ordinal`, timestamps, provider refs, `parentItemId`.
- **WorkLogEntry** (`apps/web/src/session-logic.ts:68`): the collapsed "work" row the timeline actually shows per tool/command — label, tone (`thinking|tool|info|error`), tool lifecycle status, toolSurface/Icon/Source, changedFiles, structuredPayload. Tool rows have explicit success/neutral/failure semantics (`workEntryIndicatesToolSuccess` etc.).
- **TimelineEntry** (`session-logic.ts:125`): the timeline is a flat discriminated union — `message | proposed-plan | html-render | mcp-app | work | event` — each optionally carrying the execution-node attempt. One component tree renders all providers identically because adapters already normalized the data.

### 3. Streaming without killing the UI

- Server-side **ProviderTextDeltaCoalescer** (`Adapters/ProviderTextDeltaCoalescer.ts`): text deltas are buffered per (turnId, itemId) and flushed on an interval — the wire sends *coalesced full-text-so-far snapshots* keyed by item, not per-token frames. `complete()` finalizes with optional `finalText`; `flushTurn` drains on turn end.
- Client treats streaming as a **property of a message item** (`message.streaming` flag + text updates via `isStreamingMessageTextUpdate`), not a separate UI mode. Their perf docs call out the known traps: no continuously-repainting animations, GPU spikes from CSS, list virtualization for long threads, sending too much over websockets.

### 4. Approval/question/secret flows survive restarts

Pending approvals and user-input requests are **persisted turn items** (not transient UI state) — they survive turn end, provider exit, and server restart. Codex async questions become `user_input_request` items answered via a normal user message; `runtime-request.respond` is idempotent (repeating returns the receipt without double-posting). Secrets never pass through orchestration — only the ask + how it was answered.

### 5. Capabilities, not provider checks, in the UI

Providers advertise what they can do (e.g. Antigravity can checkpoint but not roll back conversation → the boundary rejects revert before touching files). The UI reads capability flags; provider identity doesn't branch the rendering.

## Exploration — what this means for Lionidas

Lionidas already has the right *seams* (butler event log, turn events, composer with regression tests) but renders a thinner vocabulary. The revamp direction (proposal, not chosen):

1. **Normalized turn-item vocabulary + work-log timeline (recommended).** Define a Lionidas `TurnItem` union (message/reasoning/command/file-change/tool-call/error/question…) mapping butler events → items server-side; render a collapsed work-log timeline (tone + lifecycle status + expandable detail), streaming messages as item-level snapshots with server-side coalescing. Highest stability win; matches t3code's proven model; keeps Vue + Factory + scoped CSS.
2. **Visual revamp only.** Re-skin the existing chat surface (Factory pass like other pages). Cheaper, doesn't fix rendering-model gaps (tool-call detail, streaming stability, restart-surviving questions).
3. **Adopt AI Elements Vue components** for message/tool chrome (registry already installed in Hermes). Speeds some leaf components; the vocabulary/timeline model still needs designing first — components can't fix a data-model gap.

Trade-off to keep in view: Lionidas' butler currently drives ONE provider (claude-CLI child, multi-LLM routing). t3code's multi-provider adapter layer is the reference for *where provider quirks belong* (adapters, not UI) — valuable even single-provider, and a seam Lionidas may later need for Codex/OpenCode children.

## Open questions

1. **Scope of "revamp"**: rendering-model rebuild (turn items + work log + streaming coalescing — a server+web phase) or UI-first (visual pass, model later)? This changes whether Phase 5 touches `server/src/agent/` at all.
2. **Multiple providers**: is running additional agent backends (Codex/OpenCode) a near-term Lionidas goal, or is t3code's adapter pattern reference-only for now? Affects how much contract-vocabulary work lands now.
3. **Composer surface**: keep the existing Composer (mention palette, caret metrics — heavily regression-tested) or redesign it as part of the revamp?

## Next step

Answer the scope question (or say "both eventually, UI first"), then write the Phase 5 plan from the chosen direction: sketch round for the timeline/work-log composition (house rule — ≥3 variants), the turn-item vocabulary design against real butler events, and the QA-harness extension for the chat route. The clone lives at `ai/t3code` for reference throughout.
