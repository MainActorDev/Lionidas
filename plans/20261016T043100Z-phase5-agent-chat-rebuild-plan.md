# Phase 5 — Agent chat rebuild — implementation plan

- Source brainstorm: `brainstorm/20261016T041716Z-agent-chat-t3code-reference.md` (all 3 questions answered)
- Visual contract: `sketches/042-agent-chat-rebuild/a-session-rail/` — **variant A selected by operator 2026-10-16**
- Status: Ready for implementation gate

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

## 2. Web — timeline UI rebuild (variant A: session rail)

Composition per `sketches/042-agent-chat-rebuild/a-session-rail/index.html`:

1. **Session rail** (left, 200px): new-chat, recency-ordered session rows (title + `ago · model · N turns` mono subline), `N sessions · M live` footer; hides under 760px. Session switching moves the whole viewport, never a nested panel.
2. **Turns as left-bordered groups** with dot markers: user turns (dim border/dot) vs agent turns; turn meta line (who · model · time · duration · cost, mono 10px).
3. **Work rows inline under each turn** (⏵ name + ellipsized arg / ⎿ first result line, expandable payload): row-per-call granularity — NOT summary cards (C rejected). Live rows: ember symbol + fg name; ok: sage name; err: danger name.
4. **Assistant prose** in sans 13.5px over the mono work rows; fences carry the hairline language chip + path:line (existing highlight.ts tokenizer reused).
5. **Usage meters without an inspector column**: A gives up B's inspector — usage lands as the turn meta line (`2m 41s · $0.041`) plus a thin context bar in the composer foot (percent + k/200k tooltip) when a turn is live. Cost/context items still exist in the data model; only the presentation differs.
6. **Composer** (sticky, same scroll column): model chips row above input (combo chain visible), textarea, hints, send↔stop toggle. Caret palette (@refs //cmds) — the existing interaction model, restyled to A.
7. **Queue + statuses**: dashed multi-slot queue above composer; queued user turns also render in-thread with a gold `queued` marker; turn foot copy/retry; live turns carry ember `running · Ns` meta.

Kept UX rules (operator-set, each with a regression test): sticky composer in-thread; visible multi-slot queue; fact-derived load statuses (`liveTurn`/`unsent`/`aborted`); resend hidden while live; identical-resend collapse; evidence:// embeds; no silent disappearance.

8. **State: the UI owns NO turn state** (the R3 direction) — per-session state becomes a projection of the item stream; the existing per-session-state-map rule is the interim bridge.
9. **Theme**: Factory tokens, scoped CSS (settled mechanism), house Axiom chat rules (mono, hairline, ember only for live state).

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
