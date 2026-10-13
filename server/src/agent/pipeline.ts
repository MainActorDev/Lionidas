/** P2 — the author pipeline: knowledge → planner (pause on questions) →
 *  breaker → author. Built on Butler P1 workflows; profiles resolve against
 *  the SAME registry/policy the conversation API uses (act tools still
 *  refused — v1 policy untouched). */
import { SqliteWorkflowStorage, runWorkflow, answerWorkflow, advanceWorkflow } from '@mainactordev/butler';
import type { WorkflowSpec } from '@mainactordev/butler';
import type Database from 'better-sqlite3';
import type { AgentContext } from './context.ts';
import { buildProfiles } from './profiles.ts';
import { compileKnowledge } from './knowledge.ts';
import { fetchExternalText } from './ref-fetch.ts';
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
  /** R2-F2: compile refs into the knowledge page without running stages (skills call this) */
  compileOnly(appBundle: string, refs: PipelineRef[], env: Record<string, string | undefined>): Promise<{ pageId: string; version: number }>;
  /** R2-F2: latest knowledge page body for an app (skill prompt grounding) */
  knowledgePage(appBundle: string): Promise<string | null>;
  answer(runId: string, stageId: string, answers: Record<string, string>): Promise<void>;
  advance(runId: string): Promise<void>;
  skill(command: string | string[], ask: string, appBundle: string, env: Record<string, string | undefined>): Promise<unknown>;
  resume(runId: string, env: Record<string, string | undefined>, mockScripts?: Parameters<typeof buildProfiles>[1]['mockScripts']): Promise<unknown>;
}

type WorkflowEventType = 'workflow.started' | 'workflow.knowledge_compiled' | 'workflow.stage_started' | 'workflow.stage_done' | 'workflow.paused' | 'workflow.answered' | 'workflow.stage_failed' | 'workflow.done' | 'workflow.turn.delta' | 'workflow.turn.tool';

/** apply handoff gating to every stage except the last (auto = no gates). */
function gate(spec: WorkflowSpec, env: Record<string, string | undefined>): WorkflowSpec {
  if ((env['AGENT_PIPELINE_HANDOFF'] ?? 'manual') === 'auto') return spec;
  const stages = spec.stages.map((st, i) => (i < spec.stages.length - 1 ? { ...st, gated: true } : st));
  return { ...spec, stages } as WorkflowSpec;
}

export function buildPipeline(ctx: AgentContext, db: Database.Database, env: Record<string, string | undefined>, bus?: { emit: (event: 'agent.workflow', payload: { runId: string; type: WorkflowEventType; stageId?: string; detail?: unknown }) => void }): PipelineHandle {
  const workflow = new SqliteWorkflowStorage((ctx.storage as unknown as { db: Database.Database }).db);
  const emit = (e: { type: string; runId: string; stageId?: string; detail?: unknown }): void => {
    // bridge onto the crucible bus as typed agent.* events (same family as the turn bridge)
    bus?.emit('agent.workflow', e as { runId: string; type: WorkflowEventType });
  };

  const deps = (appBundle: string, mockScripts?: Parameters<typeof buildProfiles>[1]['mockScripts']) => ({
    storage: ctx.storage,
    embedder: ctx.embedder, // R2-F3: stage turns retrieve relevant notes
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
      const knowledge = await compileKnowledge(input.appBundle, input.refs, {
        storage: ctx.storage, retriever: ctx.retriever, artifactsDir: ctx.artifactsDir,
        readAttachment: (id) => ctx.attachments.readText(id),
        // rev23: real external fetchers — jira via env token, github via gh CLI
        fetchExternal: (ref) => fetchExternalText(ref, env),
      }, tmpId);
      emit({ type: 'workflow.knowledge_compiled', runId: tmpId, detail: { version: knowledge.page.version, contradictions: knowledge.contradictions.length } });
      // runWorkflow OWNS the run row (one truth); the knowledge page carries tmpId provenance
      const payload = { knowledge: knowledge.page.body, refs: input.refs, appBundle: input.appBundle };
      try {
        const out = await runWorkflow(gate(SPEC, env), deps(input.appBundle, mockScripts), { input: payload });
        return { ...out, knowledge: { pageId: knowledge.page.id, version: knowledge.page.version, contradictions: knowledge.contradictions } };
      } catch (err) {
        emit({ type: 'workflow.stage_failed', runId: tmpId, detail: err instanceof Error ? err.message : 'pipeline failed' });
        throw err;
      }
    },
    async answer(runId, stageId, answers) {
      await answerWorkflow(deps('', undefined), runId, stageId, answers);
    },
    async advance(runId) {
      await advanceWorkflow(deps('', undefined), runId);
    },
    async compileOnly(appBundle, refs, env) {
      const knowledge = await compileKnowledge(appBundle, refs, {
        storage: ctx.storage, retriever: ctx.retriever, artifactsDir: ctx.artifactsDir,
        readAttachment: (id) => ctx.attachments.readText(id),
        fetchExternal: (ref) => fetchExternalText(ref, env),
      }, `skill_${Date.now().toString(36)}`);
      return { pageId: knowledge.page.id, version: knowledge.page.version };
    },
    async knowledgePage(appBundle) {
      const page = await ctx.storage.latestArtifact('knowledge', `app:${appBundle}`);
      return page?.body ?? null;
    },
    async skill(command: string | string[], ask: string, appBundle: string, env: Record<string, string | undefined>) {
      void env;
      // MULTI-COMMAND (operator direction 2026-10-13): a message may carry
      // several commands anywhere in the text; the ENGINE decides the order —
      // the fixed Lionidas dependency chain planning → breakdown → author —
      // regardless of where the user typed them. Each command = one stage;
      // each stage's ask = the user ask + the PRIOR stage's output (chained).
      const CMDS = ['/planning', '/breakdown', '/author'];
      const wanted: string[] = Array.isArray(command) ? (command as unknown as string[]) : [command as string];
      const ordered = CMDS.filter((c) => wanted.includes(c)); // engine order, deduped
      const profileOf = (c: string): string => c === '/planning' ? 'lionidas.planner' : c === '/breakdown' ? 'lionidas.breaker' : 'lionidas.author';
      const profileId = profileOf(ordered[0] ?? '/planning');
      // R2-F2: knowledge-page grounding — the latest app page rides the ask as
      // BACKGROUND (tools are truth; the page is context)
      let grounding = '';
      if (appBundle && appBundle !== 'skill') {
        const page = await ctx.storage.latestArtifact('knowledge', `app:${appBundle}`);
        if (page) {
          // R2-F2: the page grows APPEND-first (fresh "Integrated this run" sections land at the
          // END after carried-forward priors) — a head-truncation window can cut the fresh content
          // the skill just compiled. Keep the TAIL; label the elided head.
          const body = page.body;
          const trimmed = body.length > 6000
            ? `[…older page content elided — ${body.length - 6000} chars]\n${body.slice(-6000)}`
            : body;
          grounding = `\n\n--- KNOWLEDGE PAGE BACKGROUND (app:${appBundle} — compiled from earlier refs; the LATEST integrated sections are at the end; may be stale — live tools WIN over this page) ---\n${trimmed}\n--- END BACKGROUND ---`;
        }
      }
      const spec: WorkflowSpec = {
        id: ordered.length > 1 ? `lionidas.skill.chain` : `lionidas.skill.${profileId.split('.')[1]}`,
        input: (x: unknown) => (typeof x === 'object' && x !== null && 'ask' in x ? { ok: true as const, value: x } : { ok: false as const, error: 'ask required' }),
        // one stage per command, in ENGINE order; stage input chains the prior
        // stage's output into the next ask (the workflow passes stage outputs)
        stages: ordered.map((c, i) => ({
          id: c.slice(1), // 'planning' | 'breakdown' | 'author'
          profileId: profileOf(c),
          // chain: stage N's ask = user ask + stage N-1's OUTPUT (carry rides)
          input: (x: unknown) => {
            if (typeof x !== 'object' || x === null || !('ask' in x)) return { ok: false as const, error: 'ask required' };
            const base = x as { ask: string; appBundle?: string; priorOutput?: string };
            if (i === 0 || !base.priorOutput) return { ok: true as const, value: { ask: base.ask, appBundle: base.appBundle } };
            return { ok: true as const, value: { ask: `${base.ask}\n\n--- PRIOR STAGE OUTPUT (${ordered[i - 1]}) — build on it, do not redo it ---\n${base.priorOutput}`, appBundle: base.appBundle } };
          },
          handoff: (out: unknown) => ({ ask: '', priorOutput: typeof out === 'string' ? out.slice(0, 12_000) : JSON.stringify(out).slice(0, 12_000) }),
        })),
      } as WorkflowSpec;
      return runWorkflow(spec, deps(appBundle || 'skill', undefined), { input: { ask: `${ask}${grounding}`, appBundle } });
    },
    async resume(runId, env2, mockScripts) {
      const run = await workflow.getWorkflowRun(runId);
      if (!run) throw new Error('run not found');
      const input = JSON.parse(run.input_json) as PipelineInput;
      return runWorkflow(gate(SPEC, env2), deps(input.appBundle, mockScripts), { runId });
    },
  };
}
