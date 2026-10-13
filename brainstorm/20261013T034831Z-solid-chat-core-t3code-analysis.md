# Lionidas agent chat — rebuild the chat core on proven patterns (t3code analysis)

- Source prompt: "I think there are so many issues in our chat infra. Some might be hidden and I can't even debug it. Can you check this repo @url:https://github.com/pingdotgg/t3code on build a solid AI chat app. This repo can run on the web too. Do a thorough analysis"
- Created: 2026-10-13 (analysis session)
- Status: Exploring

## Goal and context

The operator's diagnosis is correct and worth stating precisely: Lionidas' chat infra has accumulated **hidden failure modes the user cannot debug** (this round alone: cross-session UI state leaks, silent author-pipeline hijack, dropped history in the claude-cli provider, 200k token-budget false trips, stale-session errors during restarts). The root pattern behind all of them: **UI state, turn state, and side effects share mutable globals with no durable record of intent** — when something goes wrong mid-turn there is nothing to inspect.

The ask: analyze pingdotgg/t3code (Theo Browne's "agent harness control surface", 27k stars, 500k users — the same problem class as Lionidas' agent chat: typed WS server + web client + provider adapters) and extract what makes it solid, as the basis for hardening Lionidas' chat core.

## What t3code actually is (verified by reading the repo, cloned at scratch/t3code-analysis)

Not a chat *app* — a **control surface for coding-agent CLIs** (Codex, Claude Code, Cursor, Grok, OpenCode, Antigravity). Node WebSocket server wraps provider CLIs as subprocesses; web/desktop(Electron)/mobile(React Native) clients. ~465k LOC server, ~380k LOC web. 24+ packages. The relevant part for Lionidas is the **orchestration-v2 core** — the chat/turn engine.

## The five architectural patterns that make it solid (the extract)

1. **Event-sourced orchestration — "durable intent"** (`orchestration-v2/`): Clients send typed WS commands → a pure **Orchestrator** serializes commands and *decides events without doing any I/O* → **EventSink** commits events + projections + command receipt + outbox effects in ONE db transaction → an **EffectWorker** runs side effects (provider turns, checkpoints) *after* intent is recorded, feeding results back as new commands. Consequences: command retries are idempotent; a crash mid-side-effect never corrupts state (intent is already durable); every turn has a full event log you can replay and inspect. **This is the single biggest thing Lionidas lacks** — our turns are ephemeral: fetch → maybe run loop → hope.
2. **Contracts package as the only wire** (`packages/contracts`, 3.8k-line orchestration schema): everything crossing WS is typed Effect/Schema; server, web, mobile all follow the schema. Version skew is negotiated via capability flags (e.g. `threadPullRequests: true`), never assumed coordinated releases. Lionidas' bus events are stringly-typed in comparison, with hand-synced type unions in three places.
3. **Subscriptions scoped to what's on screen**: "a client viewing one thread does not pay for every thread's history." Projections are read-models derived from events; the UI renders dumb projection state. This is the principled fix for our per-session-state-leak class of bugs — the UI doesn't own state at all.
4. **Provider weirdness isolated at adapters**: a `ProviderAdapterV2` interface per provider; orchestration reads **capabilities, never driver kind**. Their rule: "a capability left on that fails at runtime is a bug" and "report only what the provider does" (e.g. don't fake permission modes). Our claude-cli provider leaking `--resume` semantics into everything is exactly the anti-pattern their adapter boundary prevents.
5. **AGENTS.md as an operational contract**: the repo documents its *own* failure modes ("the three ways to hurt yourself", "hit every surface" checklist: entry points × clients × providers × contracts × reverse states × connection modes). The "reverse states" rule (every one-way door is a bug — snooze needs unsnooze) is a UI-state audit checklist we never had.

Also notable: per-turn **checkpoints as git refs** (diff/restore any turn), tests must drain the effect worker rather than sleep ("a test that needs a timeout to pass is wrong"), no continuously-repainting animations (their users notice a dropped frame or a lying spinner — same bar as ours).

## Honest assessment — what NOT to copy

- **Scale mismatch**: 24 packages, Effect-TS everywhere, event-sourcing with outbox + projections is ~50-100x our chat core's size. Adopting the machinery wholesale would be months and violates their own stated taste ("do not introduce machinery because it looks architecturally impressive... fight for the smallest model").
- **Different problem**: they orchestrate external CLIs with checkpoints/diffs/PR linking; our provider seam is in-process and our domain is test-case authoring. The *orchestration core* is the transferable part, not the product.
- MIT license, no legal barrier.

## The recommendation (proposal, not accepted)

**Adopt the event-sourced turn core, not the app.** A focused rebuild of Lionidas' chat internals — "orchestration-lite" — in butler:

1. **Durable turn log**: every user message becomes a `turn.command` row (intent) before anything runs; provider deltas/tool events/outcome append as events; the UI renders a projection of that log. Crashes become *resumable and inspectable* — the "hidden, can't debug" class dies because there is always a log.
2. **One typed contract** (schema'd events, one source) replacing the stringly bus + hand-synced unions; UI subscribes per-session (kills the state-leak class permanently — the UI owns nothing).
3. **Provider adapters declare capabilities** (streaming: yes/no, resume: yes/no, session semantics) and orchestration branches on flags — the claude-cli leakage pattern becomes structurally impossible.
4. **UI-state audit pass** against t3code's "hit every surface"/"reverse states" checklists (cheap, immediate).
5. **Token accounting fix** (from the budget bug): per-hop marginal cost, windowed history — folds in naturally since events make accounting explicit.

Estimated: 2-3 focused sessions for 1-3 (butler + lionidas), half a session for 4-5. NOT a rewrite of the UI — Thread/Composer components keep rendering, just fed by projections.

## Open questions

1. Scope: harden the chat core only (recommend), or also reconsider the workflow/pipeline engine's storage under the same event model (bigger, later)?
2. Butler stays the home (recommend — the turn engine already lives there), or a new lionidas-side package?
3. Sequencing: this as round 3, before or after the C4 golden-set evals?

## Next step

Answer the three questions (or take recommendations: chat-core only / butler / round 3 before C4), then `/plan` it as "R3: durable chat core".
