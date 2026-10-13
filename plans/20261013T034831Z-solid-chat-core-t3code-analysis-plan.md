# R3: Durable chat core (event-sourced turns + literal ACP wire) — PLAN

- Source brainstorm: `brainstorm/20261013T034831Z-solid-chat-core-t3code-analysis.md` (+ ACP section, commit `9132909`)
- Created: 2026-10-13T04:03:41Z · Ready: 2026-10-13 · Revised after review `reviews/20261013T034831Z-solid-chat-core-t3code-analysis-plan-review.md` (R1-R8 applied)
- Status: **Ready** — execution gated on PR #35 merging (human merge)

## Decision log (operator answers, 2026-10-13)

1. **Scope — answered with code-level analysis** ("What will change in the workflow/pipeline?"): chat-core rebuild touches the workflow engine in three BOUNDED ways and does NOT rewrite it (details in Objective §scope). Stage orchestration (gates, handoffs, pause/resume) keeps its existing storage. Full unification deliberately deferred.
2. **Home = butler, production-grade.** Operator: "Butler. Make any necessary change or refinement. I want it to be production-grade." Event store, schema, orchestrator, adapter contracts all land in butler; tagged release; lionidas pins the tag.
3. **Sequencing = R3 first, C4 after.** Operator asked for the best option; accepted the recommendation: the current core is already characterized by round-2 drills, and C4 golden-set evals written against a core about to be replaced would be wasted — C4 will validate the NEW core.
4. **ACP = literal implementation.** Operator: "What is the best option? Literally?" — butler implements the actual ACP v1 protocol (JSON-RPC methods, the community schema) at its boundary, not an adapted dialect. Rationale: butler is an agent runtime speaking to clients — the exact shape ACP standardizes; literal conformance brings the tested schema, third-party ACP client compatibility (any ACP editor can drive Lionidas), and community-maintained vocabulary. Butler keeps internal engine events; ACP is the WIRE.

## Objective and completion conditions

Rebuild butler's chat core as an event-sourced turn engine speaking literal ACP, consumed by Lionidas. Done when:

1. Every chat turn is a durable command → event log → projection; a crash mid-turn leaves replayable state and resumes or fails honestly (no lying spinners, no lost turns).
2. Butler exposes ACP v1 methods as a LIBRARY surface — `createAcpAgent()` typed request/notification handlers — with TWO transports over ONE implementation: a thin `acp-stdio` wrapper binary for third-party clients, and in-process consumption by Lionidas (which forwards notifications over its existing WS). An off-the-shelf ACP client (named at S3 start; name + version recorded with the acceptance transcript) can run a session against Lionidas.
3. Tool calls stream as ACP entities (`tool_call`/`tool_call_update` patched by `toolCallId` — order-correlation dead); usage streams (`usage_update`); compaction is a negotiated, visible event.
4. Workflow stage turns write into the same per-turn event log (a stage turn = a turn with a runId); skill runs become replayable like chat.
5. The provider seam is capability-flagged (`supportsStreaming`, `supportsResume`, session semantics); orchestration never branches on provider kind.
6. UI renders projections only (no owned turn state); per-session subscriptions (already partly true post-`10fdac7`) verified under the audit checklist.
7. Token accounting — TWO meters, both surfaced in `usage_update`: (a) **cost** = Σ per-hop tokens (existing budget semantics, cap raised to a deliberate number); (b) **context** = last-hop input vs the provider's real window. Budget trips separately on each; the 200k false-trip class (cost sum misread as context) is gone.
8. Production-grade bar (operator's explicit words): exhaustive hermetic suites for the orchestrator (pure `(state, command) → events` — table tests), effect-worker drain tests (no sleep-based tests), migration/back-compat for existing `butler_sessions`/`butler_messages` (old rows readable, new turns evented), typed contracts generated from one schema, README/docs in butler, CHANGELOG, tagged.

## Scope

**In:** butler — event store (sqlite, additive tables), pure orchestrator, effect worker, ACP v1 wire (JSON-RPC over stdio for third-party clients + WS event bridge for the web UI), provider capability flags, runLoop event remapping to ACP shapes, token accounting fix, migration shim; lionidas — consume the tag, WS bridge swap to ACP-shaped events, UI projection swap, the UI-state audit pass (t3code "hit every surface"/"reverse states" checklists).

**Out (deliberate):** rewriting workflow stage orchestration storage (gates/handoffs stay as-is; only stage TURNS enter the event log); mobile/desktop clients; the marketing/CLI surfaces; MCP-mount changes (registry stays; ACP rides alongside); C4 evals (next round).

## Architecture (method)

t3code's pattern, sized to butler:

```
UI/ACP client ── JSON-RPC (ACP v1) ─▶ butler boundary
                                        │ decode → Command
                                        ▼
                              ┌─ Orchestrator (PURE) ─┐  (state, command) → events
                              └──────────┬────────────┘
                                         ▼ one sqlite txn
                              EventSink: events + projection + receipt + outbox
                                         ▼
                              EffectWorker (provider turns, emissions)
                                loop events → ACP session/update → client
```

- **Event store**: new tables `butler_turns`, `butler_turn_events` (append-only; content JSON validated against the typed schema). Sessions/messages tables remain as PROJECTIONS (rewritten by the sink) so existing consumers keep working during migration. **Single-writer rule (review R1):** the sink is the ONLY writer of message rows; ALL message writes — including lionidas' direct `appendMessage` calls today (`pipeline-routes.ts:131-135` user/answer/narrative rows) — become orchestrator commands. A stray direct write is a test failure, not a silent desync.
- **Orchestrator**: pure function, table-testable; serializes per session; decides `turn.requested`, `turn.started`, `chunk`, `tool_call`, `usage`, `turn.completed/failed/aborted` events. No I/O.
- **EffectWorker**: consumes outbox rows; executes provider turns via the existing runLoop (now emitting ACP-shaped events with stable `toolCallId`s); feeds completions/errors back as commands. Crash recovery = retry un-retired outbox rows with idempotency keys.
- **ACP wire**: `createAcpAgent()` — the ACP method surface as a library (typed handlers). `acp-stdio` wrapper binary serves third-party clients; Lionidas imports the SAME handlers in-process and forwards notifications over its WS. One implementation, two transports, zero drift (review R2). `session/prompt` maps to a `turn.requested` command; the 14 `session/update` kinds map 1:1 from engine events (thought chunks map from claude-cli thinking blocks). Negotiation is at `initialize`, TWO-SIDED: butler returns `AgentCapabilities` reporting only what the active provider truly supports, and receives `ClientCapabilities` (review R4). `fs/*` and `terminal/*` are CLIENT-side methods the agent may call when the client advertises them — butler does NOT call them in v0.5.0. Permission flow: not advertised in v0.5.0 (tool policy unchanged, auto-approve; revisit when write-tools arrive) (review R8).
- **ACP/run boundary (review R3)**: ACP covers CHAT turns and the streaming of stage-turn events. The workflow RUN lifecycle (start, gate advance, pause/resume) remains a Lionidas-level API — a run parked at `awaiting_gate` cannot be one `session/prompt` call (ACP has no parked stopReason), and the skill route today already holds HTTP open for a whole run (`pipeline-routes.ts:116`). An ACP client triggering a skill sees: the chat turn completes, workflow events stream as notifications, run status via the Lionidas API.
- **Provider capability flags**: extend `ExecutorConfig` with a caps record; `claude-cli` declares `resume: per-key`, `streaming: true`; `openai-compat` declares its own; orchestration + ACP layering read flags only.

## Interfaces

- New butler exports: `TurnOrchestrator`, `EventSink`, `EffectWorker`, `acp/` (JSON-RPC server + schema types generated from the ACP v1 JSON schema — vendored, license-noted), `PROVIDER_CAPS`.
- Lionidas: bus events become ACP `session/update` payloads (WS forward unchanged mechanically); the page's turn-state map becomes a projection subscription.
- Migration: existing sessions/messages stay; the first evented turn per session writes a `session.imported` event; old rows continue to render.

## Stages (each ends verified; butler-tagged at S6)

### S1 — Event store + orchestrator skeleton (butler)
Tables, pure orchestrator with table tests for the core commands (prompt, cancel, abort, complete, fail, message.append from callers), EventSink transaction, projection writer for sessions/messages. Single-writer rule enforced: message rows written only via commands; replay determinism, idempotent command retries, crash-between-commit-and-effect recovery. Acceptance for R1: zero `appendMessage` callers outside the sink (grep-verifiable).
### S2 — EffectWorker + runLoop ACP-shaping
Outbox worker; runLoop emits stable toolCallIds + ACP-shaped events (chunk/tool_call/usage). Token accounting lands here as TWO meters (review R5): cost = Σ per-hop usage (deliberate cap), context = last-hop input vs provider window — separate trips, both in `usage_update`. S2 opens with a per-provider HISTORY INVENTORY (review R6): where history lives per adapter (openai-compat: explicit message array, windowable; claude-cli: continuity via `--resume`, provider holds history server-side — windowing is a no-op until a new session is cut) and what compaction can honestly do per provider; compaction tests assert only what the inventory says is possible. Drain-based tests; scripted 8-hop turn proves cost accumulates while context tracks last-hop (neither false-trips).
### S3 — ACP v1 wire
`createAcpAgent()` library surface + `acp-stdio` wrapper binary (review R2). `initialize` two-sided negotiation; `fs/*`/`terminal/*` uncalled; no permission capability (review R4/R8). ACP/run boundary implemented (review R3): `session/prompt` returns at TURN end even when a triggered run is gated; stage-turn `session/update`s continue after the return. Conformance against the ACP schema's own test vectors + the named reference client (name + version recorded).
### S4 — Workflow stage turns join the log
Stage executor routes its turns through commands (runId-keyed); gates/pause/resume untouched. Skills become replayable; run panel reads the same events.
### S5 — Lionidas consumption
Pin tag; WS bridge carries ACP-shaped events (forwarding the in-process handler notifications); UI projections replace owned state; ALL remaining lionidas message writes rerouted through commands (review R1 — the grep gate); UI-state audit pass (entry points × surfaces × reverse states checklist); live drills: crash-mid-turn (kill server, restart, turn resumes or fails honestly with events intact), two-session isolation, skill+follow-up, streaming.
### S6 — Production-grade pass (butler)
Docs (README architecture section, CHANGELOG), migration test from a real v0.4.2 DB snapshot, concurrency test (two clients, one session, serialized), performance sanity (event append < 5ms), tag v0.5.0 (minor: wire addition + engine rework; breaking internals documented).

## Edge cases bound into stages

- Provider dies mid-turn → effect retries once, then `turn.failed` event with provider detail (honest, visible).
- Client disconnects mid-stream → events persist; reconnect replays from last seen event id (ACP session/resume).
- Two commands race → orchestrator serializes per session; second gets a receipt pointing at the first.
- Schema evolution → events are append-only; unknown event kinds skipped with a notice (ACP's lenient-rule), never crash replay.
- Old DB (v0.4.2) → migration test uses a snapshot of the real drill DB.
- History windowing → compaction events visible; the model still receives full transcript via provider history mechanics (windowing affects PROMPT assembly, which already lives in the claude-cli adapter).

## Validation & acceptance

1. Kill -9 the server mid-chat-turn → restart → the turn appears as `failed` with partial content preserved; a new message works immediately (no lying spinner).
2. An off-the-shelf ACP client (named at S3 start, name + version recorded) completes a session against Lionidas (prompt → streamed updates → tool calls patched by id → usage → cancel).
3. Replaying any session's event log reproduces the projection bit-for-bit (property test).
4. Round-2 regression drills green on the new core: codeword isolation, skill+ref+follow-up, two-topic memory retrieval.
5. Suites: butler (orchestrator table tests + effect drain tests + ACP conformance), server, web; tsc ×3; no sleep-based tests (t3code's rule, adopted).

## Harness reference scan (pi, OmO, DeepSeek Harness — 2026-10-13, folded in pre-execution)

Operator: "think about these repos for the harnesses. We have all the time in the world to ensure Lionidas is working perfectly." All three cloned and read at code level; findings mapped onto THIS plan (no scope change — refinements only):

**pi (earendil-works/pi, MIT, ~390k TS)** — the strongest reference of the three for us:
- **Session TREE, not a log line**: entries form a tree in JSONL; the active branch supplies history; forking/compaction insert summary ENTRIES without deleting originals (`session-manager.ts:57-183`, docs/how-pi-works.md). Refinement for S1: give `butler_turn_events` an optional `parent_id` so future branching (retry-from-here, explore-two-ways) is representable without migration. Cost: one nullable column.
- **Steering vs follow-up queues** (`agent-session.ts:393-399,1120-1140`): a mid-run user message can STEER (inject after current assistant turn) or QUEUE (enter after pending work) — with visible queue state emitted to the UI. We have neither: mid-run sends are undefined behavior. Refinement for S1/S2: model a `message.queued` command + queue-state events; the UI shows the queue instead of guessing.
- **Compaction as a session entry with originals preserved** (docs/compaction.md): matches our R5/R6 design; confirms the ACP `compaction_update` mapping is honest.
- **One agent core, four interfaces** (interactive/print/JSON/RPC/SDK all drive the same session machinery) — validates our `createAcpAgent()` one-implementation-many-transports decision (review R2).

**DeepSeek Harness (deepseek-ai/deepseek-harness, MIT, Cordis-based)** — validates the architecture wholesale, plus one warning:
- Their session plane is EXACTLY our S1 design: append-only durable log + projection units folding events into current values + projection CHECKPOINT cache for cold reads (`packages/session/README.md`, session-projection*). Independent confirmation the event/projection split is the industry shape.
- **FROZEN adjacent format migrations** (session-format-v0→v1→v2→v3→v4, each "frozen" once released): our migration shim (S6) should adopt the same discipline — a released event schema version never edited; evolution = a new frozen migration file. Refinement for S1: stamp event rows with a schema version from day one.
- **They ship an ACP profile as a first-class bundle** (`dsh-acp-app`: stdio JSON-RPC, stdout reserved for ACP frames, drain-on-SIGTERM) — a production reference implementation of exactly our S3; read their bridge before writing ours.
- Warning taken: developer-preview, "THERE WILL BE COMPATIBILITY-BREAKING CHANGES", Cordis DI adds a framework we do NOT adopt (their everything-is-a-plugin composition is explicitly out for butler — we keep explicit modules).

**OmO (code-yeongyu/oh-my-openagent, SUL-1.0 license, Rust+TS)** — two useful ideas, one decisive caution:
- 5.0 is **built ON pi** ("OmO ❤️ Pi") — third-party validation that pi's harness core is solid enough to build products on.
- Useful idea: **Kibitzer** — a read-only recall sidecar whose ONLY act is a nudge ("recalled memory: <hint>"), never a write; memory writes happen through a separate nudge cadence. Relevant later to our F3 memory work (round 4+), not to R3.
- **License caution: SUL-1.0 is NOT OSI-open** — read for inspiration only, copy NOTHING. Their pi-based memory architecture docs are instructive; no code or prose flows into butler/lionidas.

**Net effect on this plan:** three refinements folded into stages — (1) `parent_id` column on turn events (S1); (2) schema-version stamping + frozen-migration discipline (S1/S6); (3) steering/follow-up queue commands + visible queue state (S1/S2, small). pi and dsh are MIT: mechanisms may be studied and re-implemented; OmO is reference-only. No re-plan needed; execution order unchanged.

## Rollout

Branch `feat/agent-round3` off main after PR #35 merges. Butler v0.5.0 tag at S6; lionidas pins it at S5 (dev pin at S2 for drilling). No user-visible UI change except honest failure states. C4 golden-set evals follow as round 4, written against the new core.
