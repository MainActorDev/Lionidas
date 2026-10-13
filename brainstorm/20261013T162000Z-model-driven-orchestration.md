# Model-driven orchestration — stage.run as a model-called tool (delta brainstorm)

- Source prompt: "go. research it. learn from popular repos. including the repos I gave to you previously" (following the delegation discussion)
- Created: 2026-10-13T16:20:00Z
- Status: Direction selected (research-complete); feeds plan next

## Goal and context

Evolve from engine-ordered commands to the proven-app model: **the model orchestrates; the engine provides trustworthy execution units.** Research completed across all four previously-studied harnesses + Claude Code docs.

## Research findings (all verified in-repo/docs, 2026-10-13)

**Claude Code (docs):** No command sequencing engine. Skills = instruction bodies; the model sequences. For decomposition, subagents: *"each subagent runs in its own context window… Claude uses each subagent's description to decide when to delegate"* — **the model decides**, the engine isolates.

**t3code (contracts/orchestrationV2.ts:119,445):** `subagent_spawn` is a **provider-emitted context transfer** — "A subagent the provider spawned on its own (Claude's Agent tool, Codex or Cursor native subagents)" is a first-class tracked thread lineage (`relationshipToParent: "subagent"`). The MODEL spawns; the engine records lineage and results.

**DeepSeek Harness (packages/subagent/):** The most complete reference — a whole package family: `tool-subagent` *"model-facing subagent delegation tool"* — every call starts a managed activation, returns a child id, completion notices flow back; plus `tool-subagent-control` (message/interrupt/list) and backends (in-process spawn, fork, ACP, Codex, Claude children). **Delegation is a capability mounted as tools**, incl. `maxDepth` guard.

**pi (README:19):** Deliberately ships WITHOUT sub-agents — "skips features like sub-agents… Ask Pi to build what you want." Proves the minimal pole: single-loop + skills covers most work; delegation is opt-in machinery.

**OmO (ulw-research SKILL.md):** The model is literally addressed as "the research orchestrator AND the team lead" driving `team_create`/`task_send`/`task` (spawn lane)/`task_output` tools — multi-agent graphs built BY THE MODEL at runtime, engine just executes units.

**Butler (ours, already shipped):** `fanOut`/`spawnTool` supervisor exists (R2) — children with budgets, named-skip, session tree. The engine under the tool is ~already built.

## Convergent pattern (5/5 sources)

1. Delegation/stage-execution is a **model-facing TOOL** (spawn → child id → async completion), never an external sequencer.
2. Children are **isolated** (own context, scoped tools, depth caps).
3. **Instruction text carries dependency semantics**; the model chains because content demands it.
4. The engine's jobs: isolation primitive, lineage tracking, completion plumbing, guards.

## Proposed direction

**`stage.run` as a model-called tool in lionidas** (small, honest scope for this round):

1. New tool `stage.run { command: '/planning'|'/breakdown'|'/author', input: string, priorOutput?: string }` — executes that command's profile turn in an ISOLATED child (butler `spawnTool`/fanOut machinery: own context, the command's tool allowlist, child budget) and returns its output to the model.
2. Commands-as-chat-turns stays for the simple case (single command = inline overlay — pi pole). When the user's message carries MULTIPLE commands, the chat turn gets a **light orchestrator prompt** ("commands requested: X, Y — decide order and execute via stage.run; dependencies live in what each stage needs") instead of stacked bodies.
3. `orderCommands()` sort + stacked-block composition **deleted** for the multi case; `order` field stays as documentation in the registry (rendering order for tags only).
4. Depth cap 1 (a stage may not spawn stages) — dsh's `maxDepth` guard, mirrored.

Open during implementation: whether single-command turns keep the overlay (yes — recommended; zero cost, proven) vs routing everything through stage.run (no — adds a hop for nothing).

## Next step

Plan (hms-plan-from-brainstorm) on this delta → review → implement on feat/commands-as-chat (PR #38 open — this rides the same branch since it evolves the same surface, or a stacked branch if #38 merges first).
