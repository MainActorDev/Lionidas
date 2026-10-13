# R3: Durable chat core (event-sourced turns + ACP-shaped contract) — PLAN (PENDING)

- Source brainstorm: `brainstorm/20261013T034831Z-solid-chat-core-t3code-analysis.md` (+ ACP section, commit `9132909`)
- Created: 2026-10-13T04:03:41Z
- Status: **Pending** — 4 material questions open; no prescriptive steps until answered

## Confirmed facts (evidence ledger)

Operator statements (this session, verbatim intent):
- "I think there are so many issues in our chat infra. Some might be hidden and I can't even debug it." — the problem statement.
- Analyze `pingdotgg/t3code` and `agentclientprotocol/agent-client-protocol` as references for building a solid chat app. Both analyses done and folded into the brainstorm.

Verified by code inspection (brainstorm §"What t3code actually is", §"ACP", 2026-10-13):
- t3code orchestration-v2: pure Orchestrator (commands→events, no I/O), EventSink single-transaction commit, EffectWorker for side effects; typed contracts package (3,847-line schema); capability-flag version negotiation; per-thread subscriptions.
- ACP v1 schema (178 defs): 14-kind `session/update` discriminated union; `ToolCallUpdate` patches by toolCallId; `AgentSessionCapabilities` MUST/MAY negotiation; `usage_update` + compaction events as first-class streams.
- t3code internally adopts ACP for some providers (`packages/provider-acp`) — ecosystem converges on ACP vocabulary at the boundary + event-sourced engine behind it.
- Lionidas' current chat core: turn = route handler → provider run loop → mutate rows as it goes; state change and side effect fused; stringly-typed bus events hand-synced in 3 places; UI owns mutable global turn state (fixed per-session in `10fdac7` but still UI-owned). Bug classes observed this round: cross-session state leaks, silent author-pipeline hijack, dropped provider history, 200k budget false trips (per-hop accumulation), restart-window turn failures.

Constraints (standing, from memory/decisions):
- Human-only merges; PR #35 (round 2) is OPEN — R3 needs a branch off main after it merges.
- Butler is consumed via git tags; current v0.4.2.
- All changes need: suites green (server/web/butler), tsc ×3, live drills before PR.

## Proposed (NOT accepted — the brainstorm's recommendation)

Adopt the event-sourced turn core ("orchestration-lite") in butler with an ACP-shaped typed event vocabulary, capability flags at the provider seam, a UI-state audit pass, and the token-accounting fix. UI components (Thread/Composer) keep rendering, fed by projections.

## Open questions blocking the plan

1. **Scope** — chat core only, or also the workflow/pipeline engine's storage under the same event model?
   - Why it matters: doubles the stage count and risk if included; the workflow engine already has durable runs (though not event-sourced).
   - Options: (a) chat core only [brainstorm rec]; (b) chat + workflow unification.
2. **Home** — butler (where the turn engine lives) or a new lionidas-side package?
   - Why it matters: determines which repo gets the event store, the schema, and the tag.
   - Options: (a) butler [rec]; (b) new package; (c) lionidas server.
3. **Sequencing** — R3 before or after the C4 golden-set evals?
   - Why it matters: C4 gives regression safety nets; R3 rewrites the core they would test. Building evals on a core about to change wastes them; changing the core without evals risks silent regressions.
   - Options: (a) R3 first, then C4 validates the new core [rec — the current core's behavior is already characterized by this round's drills]; (b) C4 first.
4. **ACP alignment** — adopt the session/update TAXONOMY with our own schema, or literally implement ACP (JSON-RPC methods) at the boundary?
   - Why it matters: literal ACP future-proofs third-party agent clients but adds protocol machinery we don't consume today.
   - Options: (a) adapted taxonomy, own schema [rec]; (b) literal ACP implementation.

## Dependency note (confirmed)

PR #35 must merge before R3 branches (standing rule). If the operator answers while #35 is open, the plan can be written Ready and execution gated on the merge.
