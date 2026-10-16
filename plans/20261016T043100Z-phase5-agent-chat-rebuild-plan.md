# Phase 5 — Agent chat rebuild — implementation plan

- Source brainstorm: `brainstorm/20261016T041716Z-agent-chat-t3code-reference.md` (all 3 questions answered)
- Visual contract: sketches `sketches/042-agent-chat-rebuild/` (3 variants, chosen before implementation)
- Status: Ready for review

## 0. Locked decisions (user, 2026-10-16)

1. **Rebuild** the rendering model — turn-item vocabulary + work-log timeline + server-side stream coalescing. Touches `server/src/agent/` + web.
2. **Multi-provider is near-term** — t3code's adapter boundary is the target architecture, not just reference.
3. **Composer redesign is in scope** (mention palette + caret-metric overlay survive as interaction model; visual/structural redesign rides the rebuild).

## 1. Server — turn-item contract + provider adapters

Butler remains the durable engine (event-sourced turns, EventSink, orphan sweep). We add a **turn-item projection layer** between butler's raw events and the web client:

1. **`server/src/agent/turnItems.ts`** — the normalized vocabulary (t3code's `OrchestrationV2TurnItem` adapted to Lionidas' reality):
   - Base fields on every item: `id, sessionId, turnId, ordinal, status: 'pending'|'running'|'waiting'|'completed'|'failed'|'cancelled'|'interrupted', startedAt?, completedAt?`.
   - Item kinds: `message` (role, streaming flag, text), `reasoning`, `command_execution` (command line, exit, durationMs), `file_change` (operation, path, oldPath), `mcp_tool_call` (tool name, arg summary, result summary, isError), `error` (class, bounded message), `question` (pending user input — persisted item, survives reload), `usage` (cost/context meters), `compaction`.
   - One discriminated union shared to web via a type-only import module (server emits, web renders).
   - Rule (from t3code): **UI never renders raw butler/bus events** — adapters normalize at the boundary, UI stays dumb.
2. **`server/src/agent/adapters/`** — provider adapters translating each backend's native stream into turn items + coalesced deltas:
   - `claudeCliAdapter.ts` — claude-CLI subprocess (current live backend; stream-json + `--include-partial-messages`, `{type:'stream_event', event:{...}}` wrappers, tool_use blocks, permission matrix already locked by tests).
   - `openaiCompatAdapter.ts` — GLM/z.ai openai-compat SSE (forward `text_delta` only; `thinking_delta` → `reasoning` items; tool_call id correlation).
   - `codexAdapter.ts`, `opencodeAdapter.ts` — research-then-wire; t3code's orchestrators (`apps/server/src/orchestration-ai/orchestrators/`) are the reference implementations to mine. Land as stubs + capability flags first; full wiring is its own follow-up phase.
   - Each adapter emits the SAME normalized `agent.turn.item` frames onto the bus (union widened + **events-ws allowlist updated** — the hardcoded forward list is a documented pitfall).
   - Streaming: **server-side delta coalescing** per (turnId, itemId) — buffer deltas, flush coalesced text-so-far snapshots on ~80ms interval, drain on turn end (t3code `ProviderTextDeltaCoalescer` pattern). Per-token frames never reach the wire.
3. **Adoption path — contract-first, no big-bang.** v1 chat routes stay live and untouched. New v2 surface beside them:
   - `GET /api/agent/sessions/:id/timeline` → `{ items: TurnItem[], liveTurn }` — the projection the new UI renders.
   - `POST /api/agent/sessions/:id/messages` (v2: returns `{ ok, turnId }` immediately; content arrives as items over WS; command/refs/model payload identical to v1).
   - v1 decommission plan written once the new UI is default + stable.
4. **Timeline projection fold** — pure `foldTurnEvents(events) -> TurnItem[]` server-side, unit-tested against captured butler event logs (real shapes, per the verify-payload-shape law). History load = one GET; no client-side folding of raw events. Fold rules keyed off documented butler behavior: textless tool-hops render as work items not empty bubbles; `turn.completed` with empty answer + rich tool trail → error item (honest-failure rule); zombie turns → `interrupted` items with partial content; queued/steered messages → message items with intent markers. Replayed timeline == live timeline (event-sourcing invariant).
5. **Multi-provider router** — `server/src/agent/providers.ts` registry: adapter selection by `model` (combo) or explicit provider id; health reuses `models/health` shape; per-provider capability flags. Router satisfies butler's `Provider` seam (guard the legacy-clobber pitfall). Default install: claude-cli live, openai-compat live, codex/opencode capability-stubbed.

## 2. Web — timeline UI rebuild

1. **`web/src/pages/agent/` restructure** around a timeline renderer:
   - `Timeline.vue` — flat list of timeline entries derived ONLY from items: `message | work | error | question | usage-footer`. One component tree for all providers (the t3code invariant).
   - `WorkRow.vue` — collapsed tool/command row (tone + lifecycle status + arg summary, expandable payload), success/neutral/failure semantics; `⏵ name arg-summary` / `⎿ first line of result` language ported from lioclaw streamlog (already the house reference).
   - `MessageBubble.vue` — markdown + fenced highlighting (existing `markdown.ts`/`highlight.ts` reused); streaming is a per-item flag fed by coalesced snapshots.
   - Composer redesign rides the same sketches (keep: caret palette, atomic chips, single send path; redesign: layout/structure per chosen variant).
2. **State: the UI owns NO turn state** (the R3 direction already on record) — per-session state becomes a projection of the item stream; the existing per-session-state-map rule is the interim bridge.
3. **Kept UX rules (from skill, operator-set)**: sticky composer in the same scroll column; visible multi-slot queue; load-time statuses fact-derived (`liveTurn`/`unsent`/`aborted`); resend hidden while live; identical-resend collapse; evidence:// embeds; no silent disappearance — every one of these gets a regression test in the new model.
4. **Theme**: Factory tokens, scoped CSS (settled mechanism), house Axiom chat rules (mono, hairline, ember only for live state).

## 3. QA harness extension

1. Router entry for `/agent` with a full mock timeline fixture (all item kinds incl. streaming, error, question, interrupted).
2. Screenshot baselines dark/light × 375/1440 for the timeline.
3. Interaction tests: queue slots, resend visibility gating, question-answer flow, stream-growth scroll-follow + anti-yank guard, item expand/collapse.
4. Server: fold unit tests against real captured event logs; coalescer timing tests (fake timers); adapter shape tests against captured provider transcripts (claude-cli jsonl, openai-compat SSE dumps).
5. Regression lock sequencing (operator rule): BEFORE the state-model refactor moves, land tests pinning current v1 behaviors that must survive (no-vanish, honest statuses, chip atomicity) so the rebuild cannot regress them silently.

## 4. Sequencing (each step gated: check + tests + browser drill where applicable)

1. Sketches (3 variants) → user picks → commit.
2. Turn-item contract + fold (server, pure) + tests against captured logs.
3. Coalescer + claude-cli adapter emitting items + WS allowlist; v2 timeline GET behind the existing session (parallel-run with v1).
4. Web Timeline/WorkRow/MessageBubble + composer redesign per sketch; v2 UI behind a flag/route until stable.
5. Regression-lock tests → flip default → v1 decommission plan.
6. Codex/OpenCode adapter research + wiring as follow-up phase (capability stubs until then).

## 5. Risks

- t3code is React/Effect-Schema; we port patterns, not code — the contract is hand-written TS for the Vue/Express stack.
- Butler's event vocabulary is narrower than t3code's (no reasoning blocks on claude-cli partial events today) — adapters must degrade honestly (no synthetic reasoning items when the provider doesn't emit them).
- The WS allowlist + bus union widening is a known silent-death spot; every new frame type gets an end-to-end probe (raw WS dump) before the UI is trusted.
- Live-model drill costs: streaming tests use captured transcripts; only the final live drill uses a real turn (10–35s, split across calls per the skill).
