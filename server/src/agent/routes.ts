/** Agent transports (breakdown steps_004): conversation API + MCP + bus bridge.
 *  Everything operator-gated via a scoped preHandler (auth choice A) — session
 *  cookies AND PATs both resolve through registerUserResolution. */
import type { FastifyInstance } from 'fastify';
import { registerConversationApi, mountMcp } from '@mainactordev/butler';
import { registerMentionRoutes } from './mention-search.ts';
import { orderCommands, overlayBlock, toolsFor, registerCommandRoutes } from './commands.ts';
import { requireRole } from '../auth/roles.ts';
import type { AgentContext } from './context.ts';
import type { AppEvents, TypedEventBus } from '../ws/bus.ts';

export function registerAgentRoutes(app: FastifyInstance, ctx: AgentContext, bus: TypedEventBus<AppEvents>): void {
  void app.register(async (scope) => {
    // operator gate FIRST — applies to every route registered in this scope
    // (butler's conversation routes + the MCP mount), cookies and PATs alike.
    scope.addHook('preHandler', requireRole('operator'));

    // Guardrail layer 2 (rev23): NO deterministic keyword wall — every turn goes
    // to the model and the SYSTEM-PROMPT scope guardrails decide (the LLM refuses
    // off-scope asks in one line). Keyword filters misfire on greetings and
    // legitimate phrasing; judgment beats pattern-matching here.

    await registerConversationApi(scope, {
      storage: ctx.storage,
      provider: ctx.provider,
      registry: ctx.registry,
      policy: ctx.policy,
      systemPrompt: ctx.systemPrompt,
      embedder: ctx.embedder, // R2-F3: ranked note injection
      emit: (e) => { bus.emit('agent.turn', { sessionId: e.sessionId, type: e.type, hop: e.hop, ...(e.detail !== undefined ? { detail: e.detail } : {}) }); },
      // live chunk streaming (the forever-loading fix): without onDelta the
      // provider runs NON-streaming (openai-compat only sets stream:true when
      // a delta sink exists) — zero turn.delta events, UI dots for the whole
      // turn. A no-op consumer is enough: loop.ts forwards deltas via
      // onEvent(turn.delta) which both emits to the bus AND lands durable
      // chunks in the sink (conversation.ts:219).
      onDelta: () => () => {},
      commandOverlay: (cmds) => {
        const specs = orderCommands(cmds);
        if (!specs.length) return null;
        const envelope = ctx.registry.list().filter((t) => t.permission === 'read').map((t) => t.name);
        const t = toolsFor(specs, envelope);
        if (specs.length === 1) {
          // single command: inline overlay (pi pole — proven, zero-cost)
          return { promptBlock: overlayBlock(specs), ...(t ? { tools: t } : {}) };
        }
        // MULTI-command: the MODEL orchestrates (plan 20261013T162000Z) — no stacked
        // bodies, no engine sort; stage.run is the execution unit, semantics order it
        const names = specs.map((c) => c.cmd).join(', ');
        return {
          promptBlock: `\n\n--- MULTIPLE COMMANDS REQUESTED: ${names} ---\nYou orchestrate this turn. Each requested command names a stage of test-authoring work; the dependencies live in what each stage needs (breakdown consumes a scope; author consumes cases). Call stage.run once per command with the input it needs — order them yourself from the task semantics — then synthesize the results into one answer. The user's ask follows.\n---`,
          ...(t ? { tools: t } : {}),
        };
      },
      sink: ctx.sink, // R3-S5: durable turns — event log rides the storage DB
      contextWindow: 200_000,
    });

    registerMentionRoutes(scope, ctx);
    registerCommandRoutes(scope);

    await mountMcp(scope, {
      registry: ctx.registry,
      policy: ctx.policy,
      serverInfo: { name: 'lionidas-agent', version: '0.1.0' },
      instructions: ctx.systemPrompt,
    });
  });
}
