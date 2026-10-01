/** Agent transports (breakdown steps_004): conversation API + MCP + bus bridge.
 *  Everything operator-gated via a scoped preHandler (auth choice A) — session
 *  cookies AND PATs both resolve through registerUserResolution. */
import type { FastifyInstance } from 'fastify';
import { registerConversationApi, mountMcp } from '@mainactordev/butler';
import { requireRole } from '../auth/roles.ts';
import type { AgentContext } from './context.ts';
import type { AppEvents, TypedEventBus } from '../ws/bus.ts';

export function registerAgentRoutes(app: FastifyInstance, ctx: AgentContext, bus: TypedEventBus<AppEvents>): void {
  void app.register(async (scope) => {
    // operator gate FIRST — applies to every route registered in this scope
    // (butler's conversation routes + the MCP mount), cookies and PATs alike.
    scope.addHook('preHandler', requireRole('operator'));

    await registerConversationApi(scope, {
      storage: ctx.storage,
      provider: ctx.provider,
      registry: ctx.registry,
      policy: ctx.policy,
      systemPrompt: ctx.systemPrompt,
      emit: (e) => { bus.emit('agent.turn', { sessionId: e.sessionId, type: e.type, hop: e.hop, ...(e.detail !== undefined ? { detail: e.detail } : {}) }); },
    });

    await mountMcp(scope, {
      registry: ctx.registry,
      policy: ctx.policy,
      serverInfo: { name: 'lionidas-agent', version: '0.1.0' },
    });
  });
}
