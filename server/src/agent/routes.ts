/** Agent transports (breakdown steps_004): conversation API + MCP + bus bridge.
 *  Everything operator-gated via a scoped preHandler (auth choice A) — session
 *  cookies AND PATs both resolve through registerUserResolution. */
import type { FastifyInstance } from 'fastify';
import { registerConversationApi, mountMcp } from '@mainactordev/butler';
import { registerMentionRoutes } from './mention-search.ts';
import { makeTurnDecorator } from './identifier-flow.ts';
import { join, resolve } from 'node:path';
import { orderCommands, overlayBlock, toolsFor, registerCommandRoutes } from './commands.ts';
import { requireRole } from '../auth/roles.ts';
import type { AgentContext } from './context.ts';
import type { AppEvents, TypedEventBus } from '../ws/bus.ts';

export function registerAgentRoutes(app: FastifyInstance, ctx: AgentContext, bus: TypedEventBus<AppEvents>): void {
  // /implement-identifiers auto flow (butler v0.6.2 seams): the proposal turn parks
  // state; the user's confirmation turn runs INSIDE the host worktree (editor
  // provider); afterTurn commits/pushes/PRs. The human stays in the loop.
    const reposRoot = resolve(process.env['CRUCIBLE_REPOS_ROOT'] ?? join(process.cwd(), 'repos'));
  type EditorSeam = { makeEditorProvider?: (cwd: string) => import('@mainactordev/butler').Provider };
  const editorFactory = (ctx as AgentContext & EditorSeam).makeEditorProvider?.bind(ctx);
  const decorator = editorFactory ? makeTurnDecorator({
    db: (ctx as AgentContext & { db: import('better-sqlite3').Database }).db,
    reposRoot,
    makeEditorProvider: (cwd) => editorFactory(cwd),
    lastAssistant: () => '',
    onAuto: (msg) => { app.log.info(msg); },
  }) : null;
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
      // model routing (v0.6.0): the chat body's model rides the router when one exists
      ...(ctx.routeComplete ? {
        resolveModel: (b: { model?: string }) => b.model,
        routeComplete: ctx.routeComplete,
      } : {}),
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
      ...(decorator ? {
        prepareTurn: decorator.prepareTurn,
        afterTurn: (sessionId: string, outcome: { ok: boolean; turnId: string; answer: string }) => {
          try { decorator.afterTurn(sessionId, outcome); } catch (err) { app.log.warn({ err: String(err) }, 'afterTurn hook failed'); }
        },
      } : {}),
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
