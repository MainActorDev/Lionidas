/** P2 — pipeline + artifacts routes (operator-gated, existing auth hook).
 *  POST /api/agent/pipeline            start a run (refs → knowledge → stages)
 *  GET  /api/agent/pipeline/:id        run state (stages, questions, artifacts)
 *  POST /api/agent/pipeline/:id/answer answer a paused stage; caller resumes
 *  POST /api/agent/pipeline/:id/resume continue a paused/crashed run
 *  GET  /api/agent/artifacts           list (kind/runId/name filters)
 *  GET  /api/agent/artifacts/:id       fetch one (versioned chain) */
import type { FastifyInstance } from 'fastify';
import type { PipelineHandle } from './pipeline.ts';
import type { AgentContext } from './context.ts';
import { requireRoleAtLeast } from '../auth/roles.ts';
import { detectBundles } from './repo-refs.ts';
import path from 'node:path';

/** rev23: derive the app server-side — the user never picks one.
 *  1. an @repo ref's project → its main bundle id
 *  2. exactly one registered app (app_screens ∪ templates)
 *  3. give up honestly */
async function resolveAppBundle(ctx: AgentContext, refs: Array<{ kind: string; locator: string }>, env: Record<string, string | undefined>): Promise<string | null> {
  const reposRoot = env['CRUCIBLE_REPOS_ROOT'] ?? './repos';
  for (const r of refs) {
    if (r.kind !== 'github-pr' && r.kind !== 'github-commit') continue;
    const project = r.locator.split('/')[0] ?? '';
    if (!/^[A-Za-z0-9._-]+$/.test(project)) continue;
    const bundles = await detectBundles(path.join(reposRoot, project)).catch(() => [] as string[]);
    if (bundles.length) return bundles[0]!;
  }
  // 2. most recent knowledge page app (chat continuity) — storage owns the agent db
  try {
    const arts = await ctx.storage.listArtifacts({ kind: 'knowledge' });
    const recentName = arts.at(-1)?.name;
    if (recentName?.startsWith('app:')) return recentName.replace(/^app:/, '');
  } catch { /* fall through */ }
  // 3. exactly one registered app
  const registered = ctx.db.prepare("SELECT app_bundle_id AS b FROM app_screens WHERE app_bundle_id IS NOT NULL UNION SELECT app_bundle_id FROM templates WHERE app_bundle_id IS NOT NULL").all() as Array<{ b: string }>;
  if (registered.length === 1) return registered[0]!.b;
  return null;
}

export function registerPipelineRoutes(app: FastifyInstance, ctx: AgentContext, pipeline: PipelineHandle): void {
  app.post('/api/agent/pipeline', { preHandler: requireRoleAtLeast('operator') }, async (req, reply) => {
    const b = req.body as { appBundle?: string; refs?: Array<{ kind?: string; locator?: string; note?: string }> } | null;
    if (!Array.isArray(b?.refs) || b.refs.length === 0) {
      return reply.code(400).send({ error: 'refs required' });
    }
    const KNOWN: ReadonlySet<string> = new Set(['jira', 'github-pr', 'github-commit', 'doc', 'repo', 'attachment']);
    const refs = b.refs
      .filter((r) => r.kind && r.locator && KNOWN.has(r.kind))
      .map((r) => ({ kind: r.kind as 'jira' | 'github-pr' | 'github-commit' | 'doc' | 'repo' | 'attachment', locator: r.locator!, ...(r.note ? { note: r.note } : {}) }));
    if (!refs.length) return reply.code(400).send({ error: 'refs entries need kind + locator' });
    try {
      // rev23: app resolved server-side (explicit override still honored if sent)
      const appBundle = (b.appBundle ?? '').trim() || await resolveAppBundle(ctx, refs, process.env);
      if (!appBundle) {
        return reply.code(400).send({ error: 'could not determine the target app — reference an @repo (its bundle id is detected automatically) or register the app' });
      }
      const out = await pipeline.run({ appBundle, refs }, process.env);
      return reply.code(201).send(out);
    } catch (err) {
      return reply.code(422).send({ error: err instanceof Error ? err.message : 'pipeline failed' });
    }
  });

  app.get('/api/agent/pipeline/:id', { preHandler: requireRoleAtLeast('operator') }, async (req) => {
    const { id } = req.params as { id: string };
    const run = await pipeline.workflow.getWorkflowRun(id);
    if (!run) return { error: 'not found' };
    const stages = await pipeline.workflow.workflowStages(id);
    return {
      run: { id: run.id, status: run.status, currentStage: run.current_stage, createdAt: run.created_at },
      stages: stages.map((s) => ({
        id: s.stage_id, status: s.status, attempt: s.attempt,
        ...(s.question_json ? { question: JSON.parse(s.question_json) } : {}),
      })),
    };
  });

  // rev20b: slash skills — /planning /breakdown /author run ONE profile as a
  // single-stage workflow (bare input: knowledge page + profile prompt).
  app.post('/api/agent/skill', { preHandler: requireRoleAtLeast('operator') }, async (req, reply) => {
    const b = req.body as { command?: string; ask?: string; appBundle?: string } | null;
    const KNOWN: ReadonlyMap<string, string> = new Map([['/planning', 'lionidas.planner'], ['/breakdown', 'lionidas.breaker'], ['/author', 'lionidas.author']]);
    if (!b?.command || !KNOWN.has(b.command)) return reply.code(400).send({ error: `unknown skill — use one of ${[...KNOWN.keys()].join(' ')}` });
    if (!b.ask?.trim()) return reply.code(400).send({ error: 'ask required' });
    try {
      const out = await pipeline.skill(b.command, b.ask.trim(), b.appBundle ?? '', process.env);
      return { ok: true, run: out };
    } catch (err) {
      return reply.code(409).send({ error: err instanceof Error ? err.message : 'skill failed' });
    }
  });

  // rev20: manual handoff — release a stage gate (human approves the transition)
  app.post('/api/agent/pipeline/:id/advance', { preHandler: requireRoleAtLeast('operator') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await pipeline.advance(id);
      const out = await pipeline.resume(id, process.env);
      return { ok: true, run: out };
    } catch (err) {
      return reply.code(409).send({ error: err instanceof Error ? err.message : 'advance failed' });
    }
  });

  app.post('/api/agent/pipeline/:id/answer', { preHandler: requireRoleAtLeast('operator') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as { stageId?: string; answers?: Record<string, string> } | null;
    if (!b?.stageId || !b.answers) return reply.code(400).send({ error: 'stageId and answers required' });
    try {
      await pipeline.answer(id, b.stageId, b.answers);
      return { ok: true, hint: 'POST /api/agent/pipeline/:id/resume to continue' };
    } catch (err) {
      return reply.code(409).send({ error: err instanceof Error ? err.message : 'answer failed' });
    }
  });

  app.post('/api/agent/pipeline/:id/resume', { preHandler: requireRoleAtLeast('operator') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await pipeline.resume(id, process.env);
    } catch (err) {
      return reply.code(409).send({ error: err instanceof Error ? err.message : 'resume failed' });
    }
  });

  app.get('/api/agent/artifacts', { preHandler: requireRoleAtLeast('operator') }, async (req) => {
    const q = req.query as { kind?: string; runId?: string; name?: string };
    const list = await ctx.storage.listArtifacts(q);
    return { artifacts: list.map((a) => ({ id: a.id, kind: a.kind, name: a.name, version: a.version, runId: a.run_id, supersededBy: a.superseded_by, createdAt: a.created_at })) };
  });

  app.get('/api/agent/artifacts/:id', { preHandler: requireRoleAtLeast('operator') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const a = await ctx.storage.getArtifact(id);
    if (!a) return reply.code(404).send({ error: 'not found' });
    return a;
  });
}
