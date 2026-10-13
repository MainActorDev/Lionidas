# Model-driven orchestration — stage.run tool — PLAN (delta)

- Source brainstorm: `brainstorm/20261013T162000Z-model-driven-orchestration.md` (`0d8b280`)
- Created: 2026-10-13T16:35:00Z
- Status: **Ready** — direction operator-approved ("go"); single open point resolved by recommendation below

## Decision log

1. **Direction approved by operator** ("go. research it. learn from popular repos…") — research done (5 sources), convergent pattern confirmed: delegation as a model-called tool, engine provides isolated execution units.
2. **Single-command turns keep the overlay** (research-recommended): pi pole — inline is proven, zero-cost. Multi-command turns get the orchestrator prompt + stage.run tool. No open questions remain.

## Objective and completion conditions

The MODEL sequences multi-command work; the engine executes isolated stages on demand. Done when:

1. `stage.run { command, input }` is a registered read-class tool: executes the command's profile (its instruction body + tool allowlist from the registry) in an isolated child context via butler's supervisor machinery, returns the stage's output text to the model. Depth cap: the child does NOT get stage.run (no recursion).
2. A message with MULTIPLE commands composes an **orchestrator turn**: base prompt + a short orchestration instruction naming the requested commands + stage.run available. No stacked bodies, no engine sort.
3. Single-command messages: unchanged (overlay, inline) — regression-verified.
4. Plain messages: unchanged.
5. `[cmds:]` convention + bubbles: unchanged (rendering only).
6. Drills: multi-command (reversed typing) still produces planning-shaped then breakdown-shaped artifacts (the model orders via content semantics); single-command regression; plain chat regression; the stage's tool calls visible in the durable log lineage.

## Scope

**In:** lionidas `stage.run` tool (wraps pipeline profiles via butler spawn/child machinery — one child, awaited, output returned); orchestrator prompt block for multi-command turns (replaces stacking); `orderCommands` demoted (kept for [cmds:] tag rendering only); tests + drills.

**Out:** async/team semantics (team_create, task_send — OmO-scale; not needed at 3 commands); cross-session children; UI changes; touching the frozen skill endpoint; removing `order` from the registry (stays as doc).

## Method

**stage.run implementation (lionidas-side tool):**
```
registry.register({
  name: 'stage.run',
  parameters: { command: enum(['/planning','/breakdown','/author']), input: string },
  execute: runs ONE isolated turn: system prompt = command.instructions (from the registry),
    provider = chat provider, tools = command.tools ∩ registry (CR3 intersection),
    budget = child budget; returns the child's final answer text (truncated 12k).
})
```
Use butler's `runLoop` directly (the supervisor's fanOut is concurrent multi-child; we need one awaited child — runLoop with the child's prompt/tools IS the isolated child at this scale; no subprocess needed). Depth cap = the child's toolset simply excludes stage.run (it's not in any command's allowlist).

**Provider fidelity (review SR1):** stage.run resolves the command's PROVIDER via the same executor ladder the pipeline profiles use (`AGENT_PLANNER`/`AGENT_BREAKER`/`AGENT_AUTHOR` env), falling back to the chat provider when unset — per-stage model choice is preserved, not flattened.

**Multi-command turn composition (replaces stacked overlay):**
```
--- MULTIPLE COMMANDS REQUESTED: /breakdown, /planning ---
You orchestrate this turn. Each requested command names a stage of test-authoring work; the
dependencies live in what each stage needs (breakdown consumes a scope; author consumes cases).
Call stage.run once per command with the input it needs — order them yourself from the task
semantics (breakdown consumes a scope; author consumes cases) — then synthesize the results
into one answer. The user's ask follows.
---
<user ask>
```

**What gets deleted:** stacked-block composition for multi-command; `orderCommands()` use in the chat path (kept for tags).

## Stages

### A — stage.run tool (lionidas) + unit tests
Registry-driven child turn; CR3 intersection; 12k output cap; child has NO stage.run (assert allowlist); honest errors (unknown command).
### B — orchestrator composition for multi-command turns + tests
Route: >1 commands → orchestrator block; 1 command → overlay (unchanged); 0 → plain. Server tests assert the three compositions by prompt shape (mock provider sees the system prompt via a test seam or the durable log).
### C — drills + regression
Live: reversed multi-command → ordered artifacts; single /planning regression (cites case ref); plain chat; [cmds:] bubbles; suites ×3.

**Durable-record scope (review SR2):** the stage.run tool_call + its RESULT (the artifact) in the parent turn's event log IS the lineage record this round; children's internal hop events are out of scope. Orchestrator block carries the dependency sentence verbatim (review SR3).

## Edge cases

- Model calls stage.run with an unregistered command → honest tool error string, model retries.
- Model skips stage.run and answers inline → acceptable (its judgment); drills show it uses the tool when stages are named.
- Stage output huge → 12k cap with explicit truncation marker.
- Refs + multi-command → refs ride the orchestrator turn as today (kind-tagged); the model passes what stages need via `input`.

## Validation & acceptance

Unit tests (A/B) + live drills (C): the ordering question answered by the MODEL, verified by artifact shape, not by an array.

## Rollout

Rides `feat/commands-as-chat` (PR #38) — same surface, stacked commits. Butler unchanged (v0.5.1 pinned).
