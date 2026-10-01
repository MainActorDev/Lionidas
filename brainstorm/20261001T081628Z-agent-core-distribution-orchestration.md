# Agent-core distribution: repo strategy, orchestration, plugin compatibility

- Source prompt: "Let's brainstorm again. Do you plan to make the package in separate repo? And what about agent orchestration? Can we also make the package compatible as plugin to Codex, Claude, Hermes dsb. As well as the custom implementation for the web"
- Created: 2026-10-01T08:16:28Z
- Status: Direction selected (all questions answered 2026-10-01)
- Parent artifact: `brainstorm/20261001T035356Z-agentic-infrastructure-core.md` + plan `plans/20261001T035356Z-agentic-infrastructure-core-plan.md` (rev 2, Ready — this brainstorm EXTENDS that accepted direction; it does not reopen it)

## Goal and context

Three follow-on questions about the agent-core package now that its architecture is approved:

1. **Repo strategy** — separate repo for `agent-core`, or keep it in this monorepo? (The plan's unaccepted proposal said: in-repo first, extract on consumer #2.)
2. **Agent orchestration** — multi-agent concerns: sub-agents, parallel workstreams, coordination. Nothing in the approved plan covers this.
3. **Plugin compatibility** — can `agent-core` (or things built on it) plug into Codex, Claude (Code), Hermes, etc.? Plus "custom implementation for the web."

User statements vs interpretation: all three are genuine open questions ("Do you plan…", "what about…", "Can we…"). The last sentence ("As well as the custom implementation for the web") is ambiguous — most plausibly: the custom web chat surface (the deferred chat panel) should also be built on the same core. Treated as interpretation, flagged below.

## Confirmed inputs and decisions

- **DECIDED 2026-10-01 (user): "new repo"** — agent-core gets its OWN repository from the start, not the in-monorepo-first path the plan proposed. Overrides the plan's unaccepted "extract on consumer #2" default. Consequence for the plan: v1 builds in a separate repo (`agent-core`), Lionidas consumes it via workspace/git dependency; the boundary test still applies inside that repo, and a release/versioning story (even a minimal tag-based one) is needed from commit one.
- **DECIDED 2026-10-01 (user): "MCP it is"** — Q3/plugin compatibility resolved: Lionidas drivable from Codex/Claude/Hermes via the mounted MCP server (3a reading); no per-host plugin packaging work in v1 (3c = docs/config later, opportunistic).
- **DECIDED 2026-10-01 (user): "Do the testing fully in the new repo. With a demo project not Lionidas. We'll add the integration process later into Lionidas."** — agent-core v1 is built AND validated entirely in its own repo against a generic demo consumer; the Lionidas consumption layer (plan Stage 4) is deferred to a follow-up plan. See Exploration §4 for assessment + demo shape proposal (unaccepted).
- **DECIDED 2026-10-01 (user): demo must NOT couple to Lionidas context** — "the demo should not coupled with Lionidas project context right? It should be working on any use cases" → demo is a GENERIC example consumer; the QA-checklist alternative was rejected by the operator.
- **DECIDED 2026-10-01 (user): package name "Butler"** — British-flavored per operator request. npm check 2026-10-01: bare `butler` is TAKEN; `@mainactor/butler` and `@mainactordev/butler` are FREE. Repo + package will use a MainActorDev scope (repo: `MainActorDev/butler`, package `@mainactordev/butler` unless operator redirects).
- **DECIDED 2026-10-01 (user): orchestration — seams-only, PLUS an anti-forgetting mechanism** — operator accepted seams-only but with the stated concern: "if implement seams-only now, I'm afraid I'll forget to implement the machinery later." Mitigation recorded in §5: the seams ship with a REMINDER that fails CI — not just silent columns.
- **OPEN (user asked, not yet decided): "what's the concern of implementing the whole orchestration?"** — the user wants the risks/costs of building full L2 orchestration laid out before deciding depth. See Exploration §2.
- From the approved plan (rev 2, Ready — operator reviewed): agent-core is a REUSABLE package, Lionidas is first consumer, hard import boundary (D7), MCP via official SDK streamable-HTTP (D11), WebSocket turn events (D10), conversation API inside the Lionidas Fastify server (D4).
- Verified facts (2026-10-01): MCP is the interoperability standard across Claude Code, Codex CLI, Cursor, Hermes (all ship MCP clients); the official TS SDK (`@modelcontextprotocol/sdk` 1.31.0) implements server + client, stdio + streamable-HTTP transports.

## Exploration

### 1. Separate repo — when, not whether (sharpening the accepted proposal)

The plan's "extract on consumer #2" rule is right; what's worth deciding NOW is making extraction cheap vs actually doing it:

| Option | Mechanics | When it fits |
|---|---|---|
| **A. Stay in-monorepo (plan's proposal)** | `agent/` workspace package; boundary test already enforces zero app imports; consumers install via git dep until extraction | While Lionidas is the only consumer and the core's shape is still moving (it IS moving — v1 unbuilt) |
| **B. Extract now, own repo** | `@scope/agent-core` repo; versioned releases; Lionidas pins a version | When a second consumer starts TODAY or you want external contributions/semver discipline immediately |
| **C. Extract now, monorepo-of-packages** | One repo holding agent-core + future agent-* addons (connectors, eval packs) | When you're certain multiple agent packages are coming |

Cost of premature extraction (why A is the default): every core change during v1 construction would ride a publish cycle instead of a workspace link; the boundary test gives 90% of separation's discipline at 0% of the coordination cost. Cost of late extraction: a week of CI/release plumbing when consumer #2 appears — the boundary makes that week mechanical, not archaeological.

**Orchestration changes this calculus** (see next) — if orchestration lands in the core, scope grows enough that its own repo becomes reasonable even before consumer #2.

### 2. Agent orchestration — the missing layer, and the honest cost of building it all

The approved v1 is a single-agent, single-session loop. "Orchestration" can mean three different depths; conflating them is how frameworks bloat:

| Depth | What | Prior art | v1 relevance |
|---|---|---|---|
| **L1. Sequential sub-tasks** | One agent decomposes work and calls ITSELF with narrowed context (plan→draft→verify loop) | Self-Refine, chain-of-tools | Free — already expressible as prompt + tools in the current loop |
| **L2. Sub-agent spawning** | Supervisor spawns child agent sessions (own budget, own context window), gets back summaries; children run CONCURRENTLY | Claude Code subagents, Hermes `delegate_task`, LangGraph supervisors | Real architecture: session tree, child budget accounting, cancellation propagation, summary-not-transcript return |
| **L3. Fleet/distributed** | Cross-machine coordination, shared queues, heartbeats | Hermes Colony, Temporal-style durable execution | Out of scope until multi-box deployment exists |

**The user's question — "what's the concern of implementing the whole orchestration?" — answered as a concrete risk register (full L2/L3 in v1):**

1. **No paying use case yet.** Authoring-only v1 drafts one case from one ticket in one context window. Every orchestration feature would be built against imagined load, not a real one — the definition of speculative generality. The scientific-grounding discipline (D6) applies to architecture too: no eval can validate an orchestrator nobody exercises.
2. **Cost multiplies through every subsystem.** Budgets become trees (a child's spend must roll up to the parent's cap — who owns the wall clock when children run concurrently?); abort becomes graph traversal (cancel parent ⇒ cancel children ⇒ cancel their in-flight provider calls, without orphaning rows); persistence becomes a session DAG with resume semantics per node. Each is solvable; together they roughly double the loop/memory surface that v1 must test.
3. **Debuggability collapses without trace investment.** A single-session failure is replayable from `agent_messages`. A distributed failure is "which of 6 children, at which hop, under whose budget?" — you need structured tracing (span ids, parent links) from day one or orchestration is undebuggable in production. That's another subsystem.
4. **Prompt/context quality under decomposition is an open science problem.** Sub-agent summaries lose detail (information bottleneck — established in hierarchical-RL/multi-agent literature); a supervisor acting on child summaries can make worse decisions than one agent with a well-assembled context, especially on small models. The cheap known-good path — one context, assembled by retrieval (the layered memory design) — hasn't been exhausted yet.
5. **Testing burden goes nonlinear.** Deterministic mock-provider fixtures work beautifully for one loop. Concurrency interleavings, partial child failure, budget exhaustion mid-fan-out each need fixture matrices; CI time and flake risk grow accordingly.
6. **It re-couples the core to a runtime.** A supervised spawn pool wants durable queues/process supervision (L3 territory) — exactly the machinery that turns a library into a daemon/framework, which is the reusability-killing direction (D7's spirit). Keep the core a library; daemons can be built ON it later.

**What's actually needed in v1: only the seams** (cheap, no machinery): `parent_session_id` + `depth` columns in `agent_sessions` (session trees become representable), and "spawn sub-agent" expressible as a tool whose handler constructs a child loop (falls out of the library shape for free). When a real use case arrives (parallel repo ingestion; per-failed-run triage children), the machinery lands WITH its eval — per the eval-gated-autonomy discipline already in the plan.

### 3. Plugin compatibility (Codex, Claude, Hermes "dsb") — already mostly won by D11

Key realization: the plan's MCP decision already IS the plugin answer. All of Claude Code, Codex CLI, Cursor, and Hermes are **MCP clients** — they don't need `agent-core` imported; they need an MCP server to talk to. Lionidas's mounted streamable-HTTP MCP endpoint (D11) makes the whole platform drivable from those tools on day one — the "Option A adopt" story ships INSIDE the product as a bonus surface.

What "agent-core as plugin" additionally could mean:

| Reading | What it takes | Verdict |
|---|---|---|
| **3a. Lionidas drivable FROM Codex/Claude/Hermes** | Already in the plan: MCP endpoint exposing the gated tool registry | Done by D11; nothing new needed |
| **3b. agent-core USABLE as a library inside other hosts' extensions** | It's a TS library; any JS host can embed it. Codex/Claude extensions are sandboxed differently (Claude = skills/plugins, Codex = scripts) — embedding a whole loop inside them is awkward; those hosts already HAVE loops | Weak fit — hosts want tools (3a), not loops |
| **3c. agent-core tools packaged as installable plugins for those hosts** | Ship per-host packaging: a Claude plugin/skill that registers Lionidas tools, a Codex MCP config snippet, etc. | Cheap follow-on: mostly config + docs, not code — AFTER v1 |

**Custom implementation for the web (interpretation):** the deferred chat panel built as a first-class custom UI on the conversation API + WebSocket events (D10/D4) — i.e., "custom" = Lionidas's own web experience rather than embedding a third-party chat widget. If that's the meaning: it's already the accepted direction (D4 "UI deferred"); what this brainstorm adds is the note that the web client should consume ONLY the conversation API + WS events (no server internals), which keeps the same API honest for non-web clients.

### 4. Demo-project validation instead of Lionidas integration (added 2026-10-01, operator decision)

The operator's proposal: build agent-core AND all of its validation in the new repo, against a **demo consumer that is not Lionidas**; integrate into Lionidas later as its own step.

**Assessment: this is the right call, and it strengthens the science.**

Why it works:
1. **It forces the reusability claim to be true.** Testing against Lionidas would let domain concepts leak in unnoticed (D7's rule 2 is only as strong as what the tests exercise). A generic demo consumer is proof-by-construction that the core carries no Lionidas assumptions — the boundary test guards imports; the demo guards *design leakage*.
2. **It matches consumer #2's future experience.** Whatever the second product is, it will look like the demo: someone installing the package, registering tools, mounting transports. The demo IS the onboarding docs, executable.
3. **It de-risks the integration step.** When Lionidas integration comes (follow-up plan), agent-core arrives versioned and proven; the integration plan is then purely about Lionidas tools/policy/sources — smaller, reviewable, no core unknowns.
4. **Eval fixtures get cleaner.** The authoring eval in the original plan needed Lionidas's yaml validator as ground truth. The demo supplies an equivalent generic validator (e.g. a schema-checked "task spec" the agent must draft), keeping the eval discipline (D6) intact without the Lionidas dependency.

**Demo consumer shape (proposal — unaccepted):** a small `demo/` app in the agent-core repo: a fictional "release-notes assistant" or "QA-spec drafter" with (a) ~5 registered tools (query tasks, read docs, draft spec, validate spec against a JSON schema, save note), (b) a file source connector over fixture markdown "tickets", (c) the conversation API + MCP transport mounted in a tiny Fastify app, (d) an eval fixture set: ticket → drafted spec must pass the demo validator. This exercises every core subsystem (provider, loop, tools, policy, memory, sources, chunk/retrieval, transports, eval) with zero domain coupling. The demo doubles as the executable quickstart in the package README.

**Consequence for the existing plan:** plan `20261001T035356Z-agentic-infrastructure-core-plan.md` needs a rev 3 — Stage 4 (Lionidas consumption layer) moves OUT to a future plan; the live-drill and eval milestones re-target the demo app; repo/CI/versioning sections adjust for the standalone repo. The Stage 4 content itself (Lionidas tools, draft-lifecycle, policy) is preserved as the seed of the future integration plan, not lost.

**What does NOT change:** Stages 0–3 and 5 (provider, loop, tools/policy, memory, sources, transports, eval harness) — they were already core-scoped; they just relocate wholesale to the new repo. All decisions D1–D12 carry over except the Lionidas-specific wiring (D4's "inside the Lionidas server" becomes "inside the demo app" for v1; the chat-panel-deferred intent is unchanged).

### 5. Seams-only + the anti-forgetting mechanism (added 2026-10-01)

Operator accepted seams-only with one worry, verbatim: "But if implement seams-only now, I'm afraid I'll forget to implement the machinery later." Legitimate — dormant schema columns are where roadmaps go to die. The fix is to make the seam LOUD instead of silent:

1. **The seam is tested, not just present.** A v1 test creates a parent session + child session linked via `parent_session_id`, asserts the tree is representable and queryable ("children of X"). The seam can't rot unnoticed — CI exercises it every run.
2. **A standing backlog item that CI can see.** `ROADMAP.md` in the butler repo carries a tracked `orchestration-L2` entry listing the trigger conditions (a real use case: parallel repo ingestion, per-failed-run triage, eval fan-out). The README links it under "Planned." When the trigger fires, the entry graduates to a plan — the repo itself remembers.
3. **The spawn-tool slot is typed, not hacked in later.** The tool registry's docs/types include the sub-agent spawn signature as a documented extension point (a `spawn` tool example in the demo repo's docs, marked "machinery not built — see ROADMAP"). Future implementers inherit the intended shape, not archaeology.

This converts "forgot" into "CI reminds you every day" — the same eval-gated discipline the rest of the plan already uses.

1. ~~Repo strategy~~ — **answered 2026-10-01: new repo from the start.**
2. ~~Orchestration depth~~ — **answered 2026-10-01: seams-only + anti-forgetting mechanism** (§5: tested seam, ROADMAP entry, typed spawn-tool slot). Full L2 deferred until a real use case fires the trigger.
3. ~~Plugin compatibility~~ — **answered 2026-10-01: MCP it is** (3a; per-host packaging later, opportunistic).
4. ~~"Custom implementation for the web"~~ — Lionidas's own chat UI on the conversation API + WS events (D4, deferred); re-open only if meant otherwise.
5. ~~Lionidas integration in v1?~~ — **answered 2026-10-01: NO — demo-project validation in the new repo; Lionidas integration becomes a follow-up plan.** (§4)
6. ~~Demo domain~~ — **answered 2026-10-01: GENERIC — no Lionidas coupling; works for any use case.**
7. ~~Repo specifics~~ — **answered 2026-10-01: name "Butler", PRIVATE visibility** (npm: bare name taken; `@mainactordev/butler` free → repo `MainActorDev/butler` private, package `@mainactordev/butler`; publishing to public npm not needed — git dependency until an extract moment demands it).

## Next step

All questions answered. Plan rev 3 now: relocate Stages 0–3+5 into the new private `MainActorDev/butler` repo, replace Stage 4 with the generic demo app (Lionidas integration content preserved as the follow-up plan's seed), re-target completion conditions 3/5/6 to the demo, add D13–D17 to the decision log (new repo, MCP-only plugin surface, demo-not-Lionidas, seams-only+anti-forgetting, Butler/private).
