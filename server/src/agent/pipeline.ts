/** P2 — the author pipeline: knowledge → planner (pause on questions) →
 *  breaker → author. Built on Butler P1 workflows; profiles resolve against
 *  the SAME registry/policy the conversation API uses (act tools still
 *  refused — v1 policy untouched). */
import { SqliteWorkflowStorage, runWorkflow, answerWorkflow } from '@mainactordev/butler';
import type { WorkflowSpec } from '@mainactordev/butler';
import type Database from 'better-sqlite3';
import type { AgentContext } from './context.ts';
import { buildProfiles } from './profiles.ts';
import { compileKnowledge } from './knowledge.ts';
import type { PipelineRef } from './knowledge.ts';

export interface PipelineInput {
  appBundle: string;
  refs: PipelineRef[];
}

const SPEC: WorkflowSpec = {
  id: 'lionidas.author',
  input: (x) => {
    if (typeof x !== 'object' || x === null) return { ok: false, error: 'object required' };
    const o = x as { appBundle?: unknown; refs?: unknown };
    if (typeof o.appBundle !== 'string' || !o.appBundle) return { ok: false, error: 'appBundle required' };
    if (!Array.isArray(o.refs) || o.refs.length === 0) return { ok: false, error: 'refs (non-empty) required' };
    return { ok: true, value: x };
  },
  stages: [
    {
      id: 'plan', profileId: 'lionidas.planner', pauseOnQuestion: true, replanLimit: 2,
      input: (x) => (typeof x === 'object' && x !== null && 'knowledge' in x ? { ok: true, value: x } : { ok: false, error: 'knowledge required' }),
      handoff: (o) => ({ scope: String(o) }),
    },
    {
      id: 'breakdown', profileId: 'lionidas.breaker', replanLimit: 2,
      input: (x) => (typeof x === 'object' && x !== null && 'scope' in x ? { ok: true, value: x } : { ok: false, error: 'scope required' }),
      handoff: (o) => ({ breakdown: String(o) }),
    },
    {
      id: 'author', profileId: 'lionidas.author', replanLimit: 2,
      input: (x) => (typeof x === 'object' && x !== null && 'breakdown' in x ? { ok: true, value: x } : { ok: false, error: 'breakdown required' }),
    },
  ],
};

export interface PipelineHandle {
  workflow: SqliteWorkflowStorage;
  run(input: PipelineInput, env: Record<string, string | undefined>, mockScripts?: Parameters<typeof buildProfiles>[1]['mockScripts']): Promise<unknown>;
  answer(runId: string, stageId: string, answers: Record<string, string>): Promise<void>;
  resume(runId: string, env: Record<string, string | undefined>, mockScripts?: Parameters<typeof buildProfiles>[1]['mockScripts']): Promise<unknown>;
}

type WorkflowEventType = 'workflow.started' | 'workflow.knowledge_compiled' | 'workflow.stage_started' | 'workflow.stage_done' | 'workflow.paused' | 'workflow.answered' | 'workflow.stage_failed' | 'workflow.done';

export function buildPipeline(ctx: AgentContext, db: Database.Database, env: Record<string, string | undefined>, bus?: { emit: (event: 'agent.workflow', payload: { runId: string; type: WorkflowEventType; stageId?: string; detail?: unknown }) => void }): PipelineHandle {
  const workflow = new SqliteWorkflowStorage((ctx.storage as unknown as { db: Database.Database }).db);
  const emit = (e: { type: string; runId: string; stageId?: string; detail?: unknown }): void => {
    // bridge onto the crucible bus as typed agent.* events (same family as the turn bridge)
    bus?.emit('agent.workflow', e as { runId: string; type: WorkflowEventType });
  };

  const deps = (appBundle: string, mockScripts?: Parameters<typeof buildProfiles>[1]['mockScripts']) => ({
    storage: ctx.storage,
    workflow,
    registry: ctx.registry,
    profiles: (() => {
      const b = buildProfiles(env, { appBundle, ...(mockScripts ? { mockScripts } : {}) });
      return { [b.planner.id]: b.planner, [b.breaker.id]: b.breaker, [b.author.id]: b.author };
    })(),
    emit,
  });

  return {
    workflow,
    async run(input, env2, mockScripts) {
      // stage 0 (deterministic, no model): compile knowledge first (artifacts
      // carry provenance even before stages run)
      const tmpId = `wfr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const knowledge = await compileKnowledge(input.appBundle, input.refs, { storage: ctx.storage, retriever: ctx.retriever, artifactsDir: ctx.artifactsDir }, tmpId);
      emit({ type: 'workflow.knowledge_compiled', runId: tmpId, detail: { version: knowledge.page.version, contradictions: knowledge.contradictions.length } });
      // runWorkflow OWNS the run row (one truth); the knowledge page carries tmpId provenance
      const payload = { knowledge: knowledge.page.body, refs: input.refs, appBundle: input.appBundle };
      try {
        const out = await runWorkflow(SPEC, deps(input.appBundle, mockScripts), { input: payload });
        return { ...out, knowledge: { pageId: knowledge.page.id, version: knowledge.page.version, contradictions: knowledge.contradictions } };
      } catch (err) {
        emit({ type: 'workflow.stage_failed', runId: tmpId, detail: err instanceof Error ? err.message : 'pipeline failed' });
        throw err;
      }
    },
    async answer(runId, stageId, answers) {
      await answerWorkflow(deps('', undefined), runId, stageId, answers);
    },
    async resume(runId, env2, mockScripts) {
      const run = await workflow.getWorkflowRun(runId);
      if (!run) throw new Error('run not found');
      const input = JSON.parse(run.input_json) as PipelineInput;
      return runWorkflow(SPEC, deps(input.appBundle, mockScripts), { runId });
    },
  };
}
