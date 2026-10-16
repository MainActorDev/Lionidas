# Review — Phase 5 agent chat rebuild plan

- Plan reviewed: `plans/20261016T043100Z-phase5-agent-chat-rebuild-plan.md` (2026-10-16)
- Verdict: **Ready** — with 4 corrections applied during review + variant-A selection folded in (2026-10-16).

## Variant-A selection (2026-10-16, operator)

Operator picked **A (session rail)** over the recommended B, calling it cleaner. Plan §2 rewritten to A's composition: 200px session rail, dot-marked turn groups, inline row-per-call work rows (C's summary cards explicitly rejected), sans prose over mono rows. **Delta risk identified and closed:** A lacks B's inspector column, so usage/context meters needed a new home — landed as turn-meta cost/duration + a live context bar in the composer foot (§2.5). Data model unchanged; usage items still exist for any future inspector.

## Correctness against sources

1. **Butler contract facts verified** against `crucible` skill `references/agent-chat-ui.md`: durable turns v0.5.0+ (event log + EventSink + orphan sweep with freshness window), `turn.delta`/`turn.tool` single vocabulary, events-ws hardcoded allowlist pitfall, per-session state rules, honest-failure rule, queue/resend/collapse UX rules, MCP mounting, model router + legacy-clobber guard. The plan's fold rules map 1:1 to these documented behaviors. ✓
2. **t3code patterns verified** from the clone at `ai/t3code` (commit `9b150f79`): TurnItem union shape (`packages/contracts/src/orchestrationV2.ts:1329+` — statuses idle…interrupted, file-change detail, secret/permission requests), WorkLogEntry/TimelineEntry (`apps/web/src/session-logic.ts:68,125`), `ProviderTextDeltaCoalescer` (`Adapters/ProviderTextDeltaCoalescer.ts` — per-(turn,item) buffered snapshots, interval flush, `complete()`/`flushTurn` drain), adapter-boundary rule, capabilities-over-providers, persisted approval items. The plan ports patterns, not code — stack mismatch (React/Effect → Vue/TS) is explicit. ✓
3. **Current code verified**: `server/src/routes/events-ws.ts` allowlist read in full (66 lines; `agent.turn`/`agent.workflow` already forwarded); `web/src/pages/agent/` inventory (AgentChatPage 497, Composer 661, Thread 266, RunPanel 200, ChatSidebar 115 lines; markdown/highlight + ~35 test files). The rebuild respects the existing seams rather than inventing new ones. ✓

## Corrections applied during review

1. **WS frames are typed once.** The `agent.turn.item` frame type added to the bus union AND the events-ws allowlist in the same commit as the adapter that first emits it — a frame type that exists in the union but not the allowlist is exactly the documented silent-death class. (Plan §1.2/§1.3 now state this.)
2. **Fold fixtures come from real captures.** The `foldTurnEvents` tests must run against captured `butler_turn_events` rows (the verify-payload-shape law), not hand-invented shapes — hand-rolled fixtures drift and pass green while the live route returns garbage. Applied to §3.4.
3. **Reasoning items are honest.** claude-cli partial events carry `text_delta` only today; the plan now explicitly forbids synthetic `reasoning` items when the provider doesn't emit them — adapters degrade to `message` items rather than inventing structure (t3code's honesty rule).
4. **Regression locks land BEFORE the state-model refactor** (operator rule stated after the 16-incident chat history), not after — sequencing is now §4.5 with the locks as the gate to flipping the default.

## Residual risks (accepted, with mitigations)

- Codex/OpenCode event shapes are unverified in our stack; plan stages them as capability stubs until researched (§1.2, §4.6) — no invented shapes.
- Coalescing interval (~80ms) is a hypothesis; per-adapter timing tests + the claude-cli one-chunk-per-message reality (no `--include-partial-messages`) bound it. Adjustable at runtime later if needed.
- Live-turn drills are slow (10–35s); harness uses captured transcripts for the matrix, live drill only at the final gate (per skill).

## Gate for implementation

The plan satisfies the brainstorm's three locked decisions (rebuild / multi-provider / composer redesign), grounds every mechanism in either the t3code clone or the butler skill contract, and sequences regression locks before the model swap. Implementation may start after sketch selection (§4.1).
