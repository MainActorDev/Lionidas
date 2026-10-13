/** stage.run — the model-called stage executor (plan 20261013T162000Z, the
 *  Claude Code/t3code/dsh delegation model: the MODEL orchestrates; the engine
 *  provides isolated execution units).
 *
 *  One call = one isolated child turn: the command's instruction body as system
 *  prompt, its tool allowlist (CR3-intersected), its own provider (SR1: the
 *  executor ladder — AGENT_PLANNER/_BREAKER/_AUTHOR env, chat provider
 *  fallback), a child budget, and NO stage.run in the child (depth cap 1).
 *  The returned artifact text is the durable lineage record (SR2). */
import type { ToolRegistry } from '@mainactordev/butler';
import { runLoop, type LoopTool, type Provider } from '@mainactordev/butler';
import { commandByCmd, toolsFor } from './commands.ts';
import type { AgentContext } from './context.ts';

const STAGE_OUTPUT_CAP = 12_000;

/** SR1: per-command provider via the executor ladder (AGENT_PLANNER/_BREAKER/_AUTHER).
 *  When a per-stage provider IS configured, context.executor holds the resolved one
 *  (built with the profile ladder at boot); otherwise fall back to the live chat
 *  provider. This preserves per-stage model choice without re-importing the ladder. */
function stageProvider(ctx: AgentContext, cmd: string): Provider {
  const key = `stage:${cmd}`;
  const resolved = (ctx as unknown as { [k: string]: unknown })[key];
  return resolved instanceof Object && 'complete' in (resolved as object) ? (resolved as Provider) : ctx.provider;
}

export function registerStageRunTool(registry: ToolRegistry, ctx: AgentContext, env: Record<string, string | undefined> = process.env as Record<string, string | undefined>): void {
  registry.register({
    name: 'stage.run',
    description: 'Execute one test-authoring stage (/planning, /breakdown, /author) as an isolated run: its own instructions, tools, and model. Pass the input the stage needs (a user ask for planning; the SCOPE for breakdown; the breakdown table for author). Returns the stage output.',
    permission: 'read',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['/planning', '/breakdown', '/author'] },
        input: { type: 'string', description: 'what the stage works on — the ask, the scope, or the breakdown' },
      },
      required: ['command', 'input'],
    },
    async execute(args, toolCtx) {
      const cmd = String(args['command'] ?? '');
      const input = String(args['input'] ?? '');
      const spec = commandByCmd(cmd);
      if (!spec) return `error: unknown command "${cmd}" — use /planning, /breakdown, or /author`;
      if (!input.trim()) return `error: input required — ${cmd} needs the material it works on`;

      // child toolset: the command's allowlist ∩ the registry's read envelope; stage.run excluded (depth cap)
      const envelope = ctx.registry.list().filter((t) => t.permission === 'read').map((t) => t.name).filter((n) => n !== 'stage.run');
      const narrowed = toolsFor([spec], envelope);
      const childTools: LoopTool[] = [];
      for (const name of narrowed ?? envelope) {
        const t = ctx.registry.get(name);
        if (!t) continue;
        childTools.push({
          name: t.name,
          description: t.description,
          parameters: t.parameters as Record<string, unknown>,
          execute: (a, c) => t.execute(a, { sessionId: toolCtx.sessionId, signal: c.signal }),
        });
      }

      try {
        const result = await runLoop(spec.instructions, input, {
          provider: stageProvider(ctx, cmd),
          tools: childTools,
          budget: { maxHops: 12, maxTokens: 400_000, wallMs: 300_000 },
        });
        const out = result.answer.length > STAGE_OUTPUT_CAP
          ? `${result.answer.slice(0, STAGE_OUTPUT_CAP)}\n[stage output truncated at ${STAGE_OUTPUT_CAP} chars]`
          : result.answer;
        return out || `(${cmd} produced no output — retry with more specific input)`;
      } catch (e) {
        return `error: stage ${cmd} failed — ${(e as Error).message.slice(0, 200)}`;
      }
    },
  });
}
