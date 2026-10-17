# Dynamic Skill Selection — No Slash Command Required

- Source prompt: "Why didn't we have some kind of dynamic skills? A regular chat without explicitly use a particular slash command, but the engine can decide if we should use any skills available?"
- Created: 2026-10-16T06:16Z (revised 2026-10-16 after code verification + frontier-pattern review)
- Status: Direction selected — **frontier-copy (Claude Code skill model), operator-approved 2026-10-16**

## Goal and context

Today, Lionidas chat commands are **explicit**: the user types `/planning`, `/author`, etc. The user wants regular chat to route into command workflows when the message warrants it — the way Claude Code picks up skills from descriptions without being told. Operator directive (2026-10-16): **"we shouldn't reinvent the wheel. Just copy how the frontier agentic apps do this."**

Two layers (worth separating):

1. **Lionidas agent commands** — server-side, in `server/src/agent/commands.ts` (COMMANDS registry: description + instructions + tool narrowing + ordering). Fire only on explicit `[cmds: /…]` tags today.
2. **Hermes-side skills** — already dynamic in Hermes itself; out of scope here.

## Confirmed inputs and decisions (verified in code, 2026-10-16)

- COMMANDS registry: **6 commands**, each with `description`, `instructions`, `tools?`, `order` — `commands.ts:27-112` (/planning, /breakdown, /author, /implement-identifiers, /build-config-propose, /build-diagnose).
- The chat loop supports multi-command chaining (`[cmds:]` + orchestrator block + `stage.run`) — execution machinery is command-agnostic; only *selection* is explicit (`routes.ts:59-79`).
- **Correction to earlier draft**: the system prompt names only **3** commands (`system-prompt.ts:81-82`), not 6, and states they are UI-routed and never arrive as raw chat. The other 3 aren't described to the model at all. Dynamic routing therefore *rewrites* that prompt section, and must preserve the standing rule verbatim: any other `/text` is ordinary prose — never "unknown command".
- **Frontier pattern verified from t3code source** (`ClaudeAdapterV2.ts:1587-1649`, `ClaudeSkillDispatch.ts`, `CodexAdapterV2.ts:418-422`): the provider harness injects skill descriptions into context; the MODEL decides when a plain message warrants a skill; invocation is a tool call whose result expands the skill body into the same turn; the app's only job is mention plumbing (`$name` chips → `/name` dispatch for Claude, `$name` native for Codex); guardrails live in the skill body itself.
- `[cmds:]` is a transport convention parsed from stored message text by the UI — the model must NEVER emit it as free text (literal-render/double-parse hazard).

## Selected design — the Claude Code skill model, host-implemented

We are the harness for our claude-cli/GLM children, so we implement exactly what Claude Code's harness does:

1. **Discovery = prompt section.** All 6 command `description`s go into the system prompt as a numbered list with one-line purposes. This replaces (not extends) the current "Slash commands in chat" section; the ordinary-prose rule for unknown `/text` is preserved verbatim.
2. **Invocation = one MCP tool.** `command.run {name}` → validates name against the registry, returns the command's `instructions` body as the tool result. The model executes in the SAME turn, in-context. No routing classifier, no propose-then-run interstitial, no next-turn composition, no per-command gating machinery.
3. **Guardrails stay in the command body.** Each command's instructions already encode their own hard stops (author's draft wall, implement-identifiers' confirm, build-* "never write the recipe"). Dynamic selection does not weaken them — identical to SKILL.md semantics.
4. **Explicit chips unchanged.** `/cmd` palette chips keep today's `prepareTurn` overlay path (single = inline overlay; multi = `stage.run` orchestration). This is the `$name`-chip equivalent — same wheel, already shipped.
5. **Audit for free.** The `command.run` tool call lands in `butler_turn_events` with phase call/result; Phase 5's fold renders it as the command's work row + the message's intent marker. No extra logging.

**Known limitation (accepted, frontier-shared):** implicitly-routed turns get prompt-level tool guidance instead of engine-enforced `toolsFor()` narrowing. Claude Code accepts exactly this trade for skills. Explicit chips keep full narrowing.

## Rejected alternatives (record)

- **Front classifier/router** — reinvents the model worse; brittle to phrasing. (Frontier: nobody does this.)
- **Hybrid by blast radius** (in-context for read-only, announce+next-turn for stateful) — withdrawn 2026-10-16: over-engineering vs the frontier pattern; the in-command hard stops are the frontier's own answer to blast radius.
- **Model-emitted `[cmds:]` tags** — transport-convention collision; structured `command.run` instead.

## Open questions

1. Should implicitly-routed turns show a visible marker in the thread (command chip on the routed turn), or is the tool-call work row enough? (Lean: work row + intent marker via Phase 5 fold is sufficient; chips stay for explicit sends.)

## Next step

Plan slice (server, small): rewrite the system-prompt section (6 descriptions + preserved prose rule), register `command.run` on the MCP registry with tests (unknown name → honest error; description list matches registry; prose rule intact), sentinel test that the base system prompt still appears exactly once. Web changes none (Phase 5 renders the tool call). Sequence AFTER or ALONGSIDE Phase 5 step 2 — the prompt + tool land independently of the UI rebuild.
