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

    // Guardrail layer 2 (rev5 #4): deterministic off-scope tripwire. The system
    // prompt is the soft wall and the DRAFT tool policy is the hard wall; this
    // cheap filter refuses clearly non-Lionidas asks before any provider call.
    scope.addHook('preHandler', async (req, reply) => {
      if (req.method !== 'POST' || !req.url.includes('/messages')) return;
      const b = (req.body ?? {}) as { content?: string };
      const c = (b.content ?? '').toLowerCase();
      if (!c.trim()) return;
      const offScope = (/\b(write|make|give)\b[^.?!]{0,24}\b(poem|story|song|essay|joke|recipe)\b/.test(c)
        || /\b(weather|stock price|bitcoin|crypto price)\b/.test(c)
        || /\btranslate\b/.test(c)
        || /^\s*(hi|hello|hey|yo)\s*[!.]?\s*$/.test(c));
      if (offScope) {
        return reply.code(422).send({ error: 'That looks outside my scope — I do Lionidas test automation (cases, suites, scenarios, runs, triage, and the repo). Ask me about those.' });
      }
    });

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
      instructions: ctx.systemPrompt,
    });
  });
}
