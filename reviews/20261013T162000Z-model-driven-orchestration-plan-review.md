# Review: model-driven orchestration (stage.run) delta plan

- Plan reviewed: `plans/20261013T162000Z-model-driven-orchestration-plan.md` @ Ready
- Evidence: butler supervisor.ts:104 (spawnTool/fanOut exist), commands.ts (registry + CR3 helper), conversation.ts (overlay seam), brainstorm research citations (5 sources verified in-repo)
- Verdict: **Ready for implementation with 2 required edits** (1 High, 1 Medium)

## Coverage

Checked the plan's claims against butler's actual supervisor (is runLoop-as-child sufficient?), the registry helpers, and the conversation seam. Lenses: correctness, feasibility, regression surface, cost.

## Findings

### SR1 — HIGH — runLoop-as-child loses per-command PROVIDER config
- **Location:** plan §Method (child = runLoop with command prompt/tools).
- **Evidence:** pipeline profiles each carry their own executor config (env `AGENT_PLANNER`/`AGENT_AUTHOR` per-profile providers — profiles.ts `executor(env, prefix, …)`). A plain runLoop with the CHAT provider flattens per-stage model choice (e.g. author on a stronger model).
- **Consequence:** stages silently run on the chat model; behavior regression vs the pipeline path for deployments that use per-profile providers.
- **Correction:** stage.run resolves the command's provider via the SAME executor() ladder (fall back to chat provider when unset — the drill env has none set, so drills are unaffected; the config capability is preserved).
- **Verify:** unit test asserts stage.run uses `executor(env, 'AGENT_PLANNER')`-resolved provider when configured.

### SR2 — MEDIUM — Stage outputs must reach the durable log as lineage
- **Location:** plan §C drills ("stage's tool calls visible in the durable log lineage").
- **Evidence:** stage.run children run inside the PARENT turn's tool call; their events (chunks/tools) currently would be invisible unless forwarded. t3code tracks subagent lineage as first-class; our minimum: the stage.run tool result IS the lineage record (result text lands in the parent's tool_call_update event — already durable). Children's internal tool calls can ride the workflow-style `onEvent` forward as nested `turn.tool` events with a stage prefix, or be omitted this round.
- **Correction:** this round: the stage.run RESULT (the artifact) is the durable record (sufficient for replay of the parent); children's internal hop events are out of scope — state it in the plan so the drill asserts what's actually built.
- **Verify:** drill asserts the parent turn's log contains tool_call stage.run + its result, not children's internal calls.

### SR3 — LOW — Orchestrator prompt should name the dependency shape
- **Evidence:** "order them yourself from task semantics" is thin guidance for GLM-flash; one sentence naming the actual chain semantics ("breakdown consumes a scope; author consumes cases") — already in the plan text but must be IN the composed prompt, not just the plan.
- **Verify:** composition test asserts the orchestrator block mentions the dependency sentence.

## Non-findings (checked, clean)

- Depth cap: child allowlists exclude stage.run — sound and testable.
- 12k output cap: consistent with the chunk policy.
- Riding PR #38 branch: same surface, stacked — fine.
- Frozen skill endpoint: untouched.
- Cost: one extra model hop vs stacked overlay — accepted trade (isolation), noted.

## Required edits

1. §Method: stage.run resolves per-command provider via the executor ladder, chat provider fallback (SR1) + test.
2. §C: durable-record scope = parent tool_call + result; children's internal events out of scope this round (SR2); orchestrator block carries the dependency sentence (SR3).

## Remaining to validate in implementation

Whether GLM-flash reliably orders stages from semantics alone (drill is the test); token cost of orchestrator + stage.run hops vs stacked (measure once).
