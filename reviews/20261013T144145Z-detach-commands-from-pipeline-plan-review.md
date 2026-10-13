# Review: detach commands from the pipeline — chat-turn skills plan

- Plan reviewed: `plans/20261013T144145Z-detach-commands-from-pipeline-plan.md` @ Ready
- Evidence: profiles.ts:10-31 (prompt constants — verbatim-movable confirmed), profiles.ts tool arrays (3), PR #37 state OPEN, brainstorm research citations, butler conversation.ts (R3 state)
- Verdict: **Ready for implementation with 2 required edits** (1 High correctness, 1 Medium consistency)

## Coverage

Traced decision log → stages → acceptance against the actual profile/prompt/transport code. Lenses: correctness, robustness (the "everything must work" bar), feasibility, regression surface.

## Findings

### CR1 — HIGH — AUTHOR_PROMPT embeds the base prompt; verbatim move DOUBLE-composes it
- **Location:** plan §Registry ("instructions moved verbatim from profiles").
- **Evidence:** `profiles.ts:31` — `const AUTHOR_PROMPT = \`${LIONIDAS_SYSTEM_PROMPT}\n…\``. The plan composes `base + command.instructions`; author's instructions ALREADY contain the base. Moving verbatim = base prompt twice per author turn (token bloat, confusing precedence).
- **Correction:** registry `instructions` must be the COMMAND-SPECIFIC body only (author's strip the embedded base — it composes once in the turn builder).
- **Verify:** test asserts the composed prompt contains exactly ONE occurrence of a base-prompt sentinel string for every command.

### CR2 — MEDIUM — History/follow-up contract: command turns must record what later turns need
- **Location:** plan §C ("records the command labels in the message content").
- **Evidence:** the pipeline path appended tool narratives + refs to messages so follow-ups see derivation (R2-F1). Chat-turn commands get this via the durable log, but the USER message row must carry the command labels (e.g. `[cmds: /planning]`-style suffix) or reloaded history and follow-ups lose which command produced which answer — Thread tags would break on reload.
- **Correction:** specify the exact convention now: user message content = `ask [cmds: /planning /breakdown] [refs: …]`, and Thread parses `[cmds:]` in addition to `[refs:]`.
- **Verify:** reload drill (stage E) asserts command tags render after reload; a follow-up turn sees the prior command answer via history (existing behavior — assert in test).

### CR3 — LOW — Tool-narrowing union may EXCEED default chat tools
- **Evidence:** planner's allowlist includes repo tools already; author's includes draft tools the CHAT policy may not grant ('draft' permission). If a command requests tools the chat turn's policy forbids, silently granting them widens permissions; silently dropping breaks the command.
- **Correction:** registry `tools` filters WITHIN the chat turn's existing permission envelope (read-class); draft-class commands (author) rely on prompting, not tool grants, in chat mode — state this explicitly in the registry (`tools` intersects, never expands).
- **Verify:** test asserts tool set = intersection for a command requesting an act-class tool.

### CR4 — LOW — Registry fallback duplication
- **Evidence:** plan says web falls back to "built-in defaults (the three commands)" on fetch failure — that reintroduces a hardcoded list the registry was meant to kill. Acceptable as a degrade path ONLY if it ships as one shared constant imported (not a second literal list) and logs loudly.
- **Verify:** grep shows a single source for the fallback names+descriptions (imported from a shared module with the registry shape).

## Non-findings (checked, clean)

- Butler seam minimality (commandOverlay as optional dep) — sound; butler stays command-agnostic.
- PR #37 gate: plan already requires merge-first (human gate) — OPEN state noted, execution order explicit.
- `POST /api/agent/skill` frozen path — no UI callers after D; API contract untouched.
- Kill -9 mid-command-turn — R3 recovery covers it (proven for plain turns; drill in E).
- Gate semantics preserved on the pipeline path — no changes there.

## Required edits before implementation

1. §Registry/§Method: instructions = command body only; author strips the embedded base (CR1) + one-sentinel test.
2. §C: exact `[cmds: …]` message convention + Thread parses it (CR2); §Method: tools intersect, never expand (CR3); fallback = shared imported constant (CR4).

## What remains to validate during implementation

Stage E drills are the bar (single/multi/ref/follow-up/reload/kill-9). Also: token cost of stacked blocks for multi-command (measure once; window if >8k chars).
