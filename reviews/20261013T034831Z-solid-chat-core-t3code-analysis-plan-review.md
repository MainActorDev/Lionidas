# Review: R3 durable chat core plan (event-sourced turns + literal ACP wire)

- Plan reviewed: `plans/20261013T034831Z-solid-chat-core-t3code-analysis-plan.md` @ commit `d40295b` (status: Ready)
- Sources: plan + decision log; brainstorm `20261013T034831Z` (`9132909`); butler source @ v0.4.2 tree (read 2026-10-13); ACP v1 schema from `agentclientprotocol/agent-client-protocol` clone (2026-10-13, `schema/v1/schema.json`, 178 defs); lionidas server source @ `9132909` (read 2026-10-13)
- Verdict: **Needs revision** — 3 High findings open; no operator questions blocking the corrections (all three are design consequences of granted decisions, not new choices)

## Coverage

Traced: decision log (4 answers) → objective/completion conditions → 6 stages → acceptance. Audited correctness, robustness, reliability, feasibility against the actual butler/lionidas code and the ACP schema — not just internal consistency. Lenses skipped: accessibility, compliance (not applicable — internal tool); scalability beyond single-node sqlite (out of confirmed scope).

## Findings (prioritized)

### R1 — HIGH — Dual writer on `butler_messages` breaks the projection model
- **Location:** plan §Architecture ("Sessions/messages tables remain as PROJECTIONS (rewritten by the sink)"), §S1.
- **Evidence:** lionidas writes messages DIRECTLY today — `server/src/agent/pipeline-routes.ts:131-135` calls `ctx.storage.appendMessage(...)` for user rows, assistant answers, and the F1 tool-narrative row; chat routes do the same. Butler is not the only writer.
- **Consequence:** if EventSink becomes the single writer but lionidas keeps appending, the event log and the message projection desync silently — replay determinism (acceptance #3) fails, and the desync is invisible until someone replays.
- **Correction:** S1/S5 must state: ALL message writes route as commands through the orchestrator (lionidas drops direct `appendMessage`); add a guard (sink-owned write path or migration note) so a stray direct write is caught in tests.
- **Verify:** grep shows zero `appendMessage` callers outside the sink; replay test over a session created via the UI passes bit-for-bit.

### R2 — HIGH — Process model for "literal ACP" is undecided
- **Location:** plan §Decision 4, §Architecture ("JSON-RPC over stdio for third-party clients + WS event bridge for the web UI"), §S3.
- **Evidence:** butler is consumed IN-PROCESS today (lionidas imports the package; `context.ts` constructs providers directly). The plan says stdio for third parties but never says how LIONIDAS consumes the ACP surface. If the implied answer is "spawn butler as a subprocess," that is a deployment change (child-process lifecycle, crash supervision) smuggled into S3.
- **Consequence:** either an unplanned infrastructure change at S3, or an ambiguous seam where the web UI and stdio clients drift (two adapters maintained by hand).
- **Correction:** specify the shape: butler exports `createAcpAgent()` — the ACP method surface as a library (typed request/notification handlers). `acp-stdio` is a thin wrapper binary for third-party clients. Lionidas consumes the SAME handler surface in-process and forwards notifications over its WS. One implementation, two transports, zero drift.
- **Verify:** the stdio wrapper imports the same module the lionidas route uses (one file, two entrypoints); conformance suite runs against the handler surface, not the binary.

### R3 — HIGH — Gated workflow runs do not fit one `session/prompt` call
- **Location:** plan §S3, §S4; acceptance #2 ("off-the-shelf ACP client completes a session").
- **Evidence:** ACP `session/prompt` is a request/response held open for the turn, ending with a stopReason; the skill route ALREADY holds HTTP open for a whole run (`pipeline-routes.ts:116` awaits `pipeline.skill(...)` to completion). A run parked at `awaiting_gate` for hours cannot be one prompt call; ACP has no "parked" stopReason.
- **Consequence:** either S4 forces workflow runs into a protocol shape that can't express gates (conformance breaks), or the plan silently scopes ACP down without saying so.
- **Correction:** state the boundary explicitly: **ACP covers chat turns and the streaming of stage-turn events; the workflow RUN lifecycle (start, gate advance, pause) remains a Lionidas-level API** — exactly consistent with the operator's scope decision (workflow orchestration NOT rewritten). An ACP client that triggers a skill gets: the chat turn completes, workflow events stream as notifications, run status comes from the Lionidas API surface.
- **Verify:** conformance test asserts `session/prompt` returns at turn end even when a triggered run is gated; stage-turn `session/update`s continue after the return.

### R4 — MEDIUM — Capability negotiation details conflated
- **Location:** plan §Architecture ("capabilities negotiated at session/new"), §S3.
- **Evidence:** ACP negotiates at `initialize` (first request), two-sided: agent returns `AgentCapabilities` (loadSession, promptCapabilities image/audio/embeddedContext, …) and receives `ClientCapabilities` (fs.readTextFile/writeTextFile, terminal). `fs/*` are CLIENT methods the agent may CALL when the client advertises them — not methods butler exposes. The plan's "fs/* gated" phrasing inverts this.
- **Consequence:** minor conformance bugs and a confused adapter layer at S3.
- **Correction:** fix the plan text: negotiation at `initialize`; butler reports only what the active provider truly supports (operator rule); `fs/*`/`terminal/*` are client-side capabilities butler does not call in v0.5.0 (state it).
- **Verify:** conformance test exercises `initialize` handshake with asymmetric caps; no `fs/*` request is ever issued.

### R5 — MEDIUM — Token accounting: one meter where two are needed
- **Location:** plan §S2 ("per-hop marginal cost; budget trips honest"), completion condition 7.
- **Evidence:** loop.ts sums usage across hops (`provider.response` carries per-hop `res.usage`, loop.ts:117); the 202,315 > 200,000 trip was the SUM. The sum IS the honest cost (every hop re-bills the full context); what tripped falsely was treating a cost sum as a context-window measure.
- **Consequence:** renaming the same number "marginal" doesn't fix anything; tool-heavy turns would still die or the cap becomes meaningless.
- **Correction:** two meters, both surfaced in `usage_update`: (a) **cost** = Σ per-hop tokens (existing semantics, cap raised to a deliberate number); (b) **context** = last-hop input vs the provider's real window (the thing that actually overflows). Budget trips separately on each.
- **Verify:** unit test with a scripted 8-hop turn: cost meter accumulates, context meter tracks last-hop input; neither false-trips.

### R6 — MEDIUM — History-assembly location asserted without citation
- **Location:** plan §Edge cases ("windowing affects PROMPT assembly, which already lives in the claude-cli adapter").
- **Evidence:** R2-F1 deliberately DROPPED history from claude-cli prompts (continuity via `--resume`, claude-cli.ts:82-97); openai-compat receives explicit message arrays. So "prompt assembly lives in the claude-cli adapter" is not the whole truth — assembly differs per provider, and the plan's compaction design depends on this seam.
- **Consequence:** windowing/compaction designed against the wrong seam won't reduce anything for claude-cli sessions (the provider holds the history server-side; only `--resume` reset or client-side transcript re-feed changes it).
- **Correction:** S2 must open with a one-paragraph inventory: per provider, where history lives and what compaction can actually do (openai-compat: window the array; claude-cli: windowing is a no-op until a new session is cut — say so, and surface `compaction_update` accordingly).
- **Verify:** the inventory paragraph exists and matches the adapters' code; compaction test only asserts what the inventory says is possible.

### R7 — LOW — Name the concrete ACP client for acceptance #2
- **Location:** acceptance #2 ("an off-the-shelf ACP client").
- **Correction:** name it — the ACP repo's own client test harness (Rust `agent-client-protocol-schema` tests / any reference client listed there) or Zed's agent panel. Pick one at S3 start; note the version tested.
- **Verify:** acceptance run records client name + version + transcript.

### R8 — LOW — Permission flow decision unstated
- **Location:** §S3 (absent).
- **Evidence:** ACP defines `session/request_permission`; butler's tools are read-mostly today (jira.get, repo reads, attachment.get) with memory writes (note.save). An agent MAY simply never request permission.
- **Correction:** state it: v0.5.0 advertises no permission capability (auto-approved tool policy unchanged from today); revisit if write-tools arrive.
- **Verify:** conformance test confirms no permission request is issued across the golden path.

## Non-findings (checked, clean)

- Scope decision honored: workflow stage orchestration untouched; only stage TURNS enter the log (§S4 consistent with operator answer 1).
- `resume: per-key` capability claim verified against claude-cli.ts:49-52 (sessionIds map keyed by sessionKey).
- Migration approach consistent with butler's existing guarded-migration precedent (sqlite.ts:123).
- Event-append < 5ms is stated as a sanity check to measure, not a claimed fact — acceptable.
- PR #35 gate consistent with the standing human-merge rule.

## Questions for the operator

None blocking. R1–R3 are corrections inside decisions you already made; if you want the workflow-run boundary (R3) exposed differently to ACP clients, say so — otherwise the stated boundary applies.

## Necessary edits to the plan

1. §S1/S5: single-writer rule + reroute of lionidas `appendMessage` calls (R1).
2. §Architecture/§S3: `createAcpAgent()` library surface + stdio wrapper + in-process consumption (R2).
3. §S3/§S4: ACP-covers-turns-not-run-lifecycle boundary paragraph (R3).
4. §S3: initialize-time two-sided negotiation; fs/terminal = client-side, uncalled in v0.5.0 (R4).
5. §S2: two meters (cost Σ / context last-hop) with separate caps (R5).
6. §S2: per-provider history inventory before compaction design (R6).
7. Acceptance #2: named client; §S3: no-permission decision (R7, R8).

## What remains to validate during implementation

This review audited the plan on paper against code and schema. Not certified, must be proven by execution: replay bit-exactness, kill -9 recovery behavior, ACP conformance against the named client, drain-based effect tests, the < 5ms append number, and the two-meter budget behavior on a real 8-hop turn.
