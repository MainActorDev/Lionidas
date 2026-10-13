# R3: Durable chat core (event-sourced turns + literal ACP wire) — PLAN

- Source brainstorm: `brainstorm/20261013T034831Z-solid-chat-core-t3code-analysis.md` (+ ACP section, commit `9132909`)
- Created: 2026-10-13T04:03:41Z · Ready: 2026-10-13 (decision log below)
- Status: **Ready** — execution gated on PR #35 merging (human merge)

## Decision log (operator answers, 2026-10-13)

1. **Scope — answered with code-level analysis** ("What will change in the workflow/pipeline?"): chat-core rebuild touches the workflow engine in three BOUNDED ways and does NOT rewrite it (details in Objective §scope). Stage orchestration (gates, handoffs, pause/resume) keeps its existing storage. Full unification deliberately deferred.
2. **Home = butler, production-grade.** Operator: "Butler. Make any necessary change or refinement. I want it to be production-grade." Event store, schema, orchestrator, adapter contracts all land in butler; tagged release; lionidas pins the tag.
3. **Sequencing = R3 first, C4 after.** Operator asked for the best option; accepted the recommendation: the current core is already characterized by round-2 drills, and C4 golden-set evals written against a core about to be replaced would be wasted — C4 will validate the NEW core.
4. **ACP = literal implementation.** Operator: "What is the best option? Literally?" — butler implements the actual ACP v1 protocol (JSON-RPC methods, the community schema) at its boundary, not an adapted dialect. Rationale: butler is an agent runtime speaking to clients — the exact shape ACP standardizes; literal conformance brings the tested schema, third-party ACP client compatibility (any ACP editor can drive Lionidas), and community-maintained vocabulary. Butler keeps internal engine events; ACP is the WIRE.

## Objective and completion conditions

Rebuild butler's chat core as an event-sourced turn engine speaking literal ACP, consumed by Lionidas. Done when:

1. Every chat turn is a durable command → event log → projection; a crash mid-turn leaves replayable state and resumes or fails honestly (no lying spinners, no lost turns).
2. Butler exposes ACP v1 methods (`session/new|prompt|update|cancel|load|list`, `fs/*` gated, `permission` flow) over JSON-RPC (stdio + the existing WS bridge for the web UI); an off-the-shelf ACP client can run a session against Lionidas.
3. Tool calls stream as ACP entities (`tool_call`/`tool_call_update` patched by `toolCallId` — order-correlation dead); usage streams (`usage_update`); compaction is a negotiated, visible event.
4. Workflow stage turns write into the same per-turn event log (a stage turn = a turn with a runId); skill runs become replayable like chat.
5. The provider seam is capability-flagged (`supportsStreaming`, `supportsResume`, session semantics); orchestration never branches on provider kind.
6. UI renders projections only (no owned turn state); per-session subscriptions (already partly true post-`10fdac7`) verified under the audit checklist.
7. Token accounting: per-hop marginal cost; history windowing with visible compaction; the 200k false-trip class is gone (budget trips only on genuine overspend).
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

- **Event store**: new tables `butler_turns`, `butler_turn_events` (append-only; content JSON validated against the typed schema). Sessions/messages tables remain as PROJECTIONS (rewritten by the sink) so existing consumers keep working during migration.
- **Orchestrator**: pure function, table-testable; serializes per session; decides `turn.requested`, `turn.started`, `chunk`, `tool_call`, `usage`, `turn.completed/failed/aborted` events. No I/O.
- **EffectWorker**: consumes outbox rows; executes provider turns via the existing runLoop (now emitting ACP-shaped events with stable `toolCallId`s); feeds completions/errors back as commands. Crash recovery = retry un-retired outbox rows with idempotency keys.
- **ACP wire**: `session/prompt` maps to a `turn.requested` command; the 14 `session/update` kinds map 1:1 from engine events (thought chunks map from claude-cli thinking blocks); capabilities negotiated at `session/new` (butler advertises what the active provider truly supports — ACP's "report only what the provider does" rule, which matches t3code's).
- **Provider capability flags**: extend `ExecutorConfig` with a caps record; `claude-cli` declares `resume: per-key`, `streaming: true`; `openai-compat` declares its own; orchestration + ACP layering read flags only.

## Interfaces

- New butler exports: `TurnOrchestrator`, `EventSink`, `EffectWorker`, `acp/` (JSON-RPC server + schema types generated from the ACP v1 JSON schema — vendored, license-noted), `PROVIDER_CAPS`.
- Lionidas: bus events become ACP `session/update` payloads (WS forward unchanged mechanically); the page's turn-state map becomes a projection subscription.
- Migration: existing sessions/messages stay; the first evented turn per session writes a `session.imported` event; old rows continue to render.

## Stages (each ends verified; butler-tagged at S6)

### S1 — Event store + orchestrator skeleton (butler)
Tables, pure orchestrator with table tests for the core commands (prompt, cancel, abort, complete, fail), EventSink transaction, projection writer for sessions/messages. Hermetic: replay determinism, idempotent command retries, crash-between-commit-and-effect recovery.
### S2 — EffectWorker + runLoop ACP-shaping
Outbox worker; runLoop emits stable toolCallIds + ACP-shaped events (chunk/tool_call/usage); drain-based tests. The 200k accounting fix lands here (per-hop marginal cost; budget trips honest).
### S3 — ACP v1 wire
JSON-RPC server (stdio) implementing session lifecycle; capabilities negotiation; `session/update` forwarding. Verify against the ACP schema's own test vectors where they exist, plus a reference-client smoke (any ACP sample client).
### S4 — Workflow stage turns join the log
Stage executor routes its turns through commands (runId-keyed); gates/pause/resume untouched. Skills become replayable; run panel reads the same events.
### S5 — Lionidas consumption
Pin tag; WS bridge carries ACP-shaped events; UI projections replace owned state; UI-state audit pass (entry points × surfaces × reverse states checklist); live drills: crash-mid-turn (kill server, restart, turn resumes or fails honestly with events intact), two-session isolation, skill+follow-up, streaming.
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
2. An off-the-shelf ACP client completes a session against Lionidas (prompt → streamed updates → tool calls patched by id → usage → cancel).
3. Replaying any session's event log reproduces the projection bit-for-bit (property test).
4. Round-2 regression drills green on the new core: codeword isolation, skill+ref+follow-up, two-topic memory retrieval.
5. Suites: butler (orchestrator table tests + effect drain tests + ACP conformance), server, web; tsc ×3; no sleep-based tests (t3code's rule, adopted).

## Rollout

Branch `feat/agent-round3` off main after PR #35 merges. Butler v0.5.0 tag at S6; lionidas pins it at S5 (dev pin at S2 for drilling). No user-visible UI change except honest failure states. C4 golden-set evals follow as round 4, written against the new core.
