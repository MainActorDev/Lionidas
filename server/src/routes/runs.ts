import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { enqueue, abort, type QueueSpec } from '../queue/store.ts';
import { abortRun } from '../manual/playback.ts';
import type { TypedEventBus, AppEvents } from '../ws/bus.ts';
import { executeRun } from '../alloy/runner.ts';
import { jiraConfig, buildCommentBody, postComment } from '../integrations/jira.ts';
import { alloyDispatchDepsSync } from '../alloy/runtime.ts';
import { scanFlowSet } from '../domain/acs.ts';
import { diskState } from '../gc/retention.ts';
import { requirePinOrAgent } from '../auth/gate.ts';

interface RunRow {
  id: string; ticket_key: string; kind: string; status: string; triggered_by: string;
  device_udid: string; artifact_hash: string | null; freshness: string;
  launch_args_json: string; started_at: number | null; finished_at: number | null;
}

export function registerRunRoutes(app: FastifyInstance, db: Database.Database, bus?: TypedEventBus<AppEvents>): void {
  app.post('/api/runs', { preHandler: requirePinOrAgent() }, async (req, reply) => {
    const body = req.body as Partial<QueueSpec> & { priority?: 'manual' | 'scheduled' | 'agent'; scenarioId?: string };
    // disk quota: pause new runs at 100% (PLAN §11)
    const disk = diskState(process.env['CRUCIBLE_ARTIFACTS_DIR'] ?? './artifacts');
    if (disk.paused) {
      return reply.code(507).send({ error: `evidence quota exhausted (${Math.round(disk.usageBytes / 1e9)}GB ≥ limit) — run GC or raise CRUCIBLE_QUOTA_BYTES` });
    }
    // pre-flight: everything validated BEFORE enqueue (invalid never queues)
    const required: Array<keyof QueueSpec> = ['ticketKey', 'flowsDir', 'udid', 'app', 'artifactPath', 'triggeredBy'];
    for (const k of required) {
      if (!body[k]) return reply.code(400).send({ error: `missing field: ${k}` });
    }
    if (!existsSync(body.flowsDir!)) return reply.code(400).send({ error: `flowsDir not found: ${body.flowsDir}` });
    const set = scanFlowSet(body.flowsDir!);
    if (set.duplicateAcError) return reply.code(400).send({ error: `pre-flight: ${set.duplicateAcError}` });
    if (set.flows.length === 0) return reply.code(400).send({ error: 'no flows in flowsDir' });
    if (!existsSync(body.artifactPath!)) return reply.code(400).send({ error: `artifactPath not found: ${body.artifactPath}` });
    const dev = db.prepare('SELECT udid FROM devices WHERE udid = ?').get(body.udid!);
    if (!dev) return reply.code(400).send({ error: `unknown device: ${body.udid} (is the poller running?)` });
    const prio = body.priority === 'agent' ? 2 : body.priority === 'scheduled' ? 1 : 0;
    const spec: QueueSpec = {
      ticketKey: body.ticketKey!,
      flowsDir: body.flowsDir!,
      udid: body.udid!,
      app: body.app!,
      artifactPath: body.artifactPath!,
      ...(body.srcPath !== undefined ? { srcPath: body.srcPath } : {}),
      ...(body.launchArgs !== undefined ? { launchArgs: body.launchArgs } : {}),
      triggeredBy: body.triggeredBy!,
      ...(body.triage !== undefined ? { triage: body.triage } : {}),
      ...(body.kind !== undefined ? { kind: body.kind } : {}),
      ...(body.parentRunId !== undefined ? { parentRunId: body.parentRunId } : {}),
    };
    const queueId = enqueue(db, spec, body.triggeredBy!, prio);
    bus?.emit('queue.changed', { queueId, state: 'waiting' });
    return reply.code(202).send({ queueId });
  });

  app.get('/api/queue', async () => {
    const rows = db.prepare('SELECT * FROM queue ORDER BY priority ASC, enqueued_at ASC').all();
    return { queue: rows };
  });

  app.delete('/api/queue/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = abort(db, id);
    if (!ok) return reply.code(409).send({ error: 'not abortable (already dispatched/done)' });
    bus?.emit('queue.changed', { queueId: id, state: 'aborted' });
    return { aborted: true };
  });

  app.get('/api/runs', async (req) => {
    const q = req.query as { ticket?: string; limit?: string; template?: string; app_version?: string };
    const limit = Math.min(Number.parseInt(q.limit ?? '50', 10) || 50, 200);
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.ticket) { where.push('ticket_key = ?'); params.push(q.ticket); }
    if (q.template) { where.push('template_id = ?'); params.push(q.template); }
    if (q.app_version) { where.push('app_version = ?'); params.push(q.app_version); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = db.prepare(`SELECT * FROM runs ${clause} ORDER BY started_at DESC LIMIT ?`).all(...params, limit);
    return { runs: rows as RunRow[] };
  });

  app.get('/api/runs/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
    if (!run) return reply.code(404).send({ error: 'run not found' });
    return { run };
  });

  // B2: abort a running manual/template run — idempotent on terminal runs.
  // Wedged dispatch promises can't be cancelled (no engine abort), but the
  // run record terminates and the device frees (B5 guard reads status).
  app.post('/api/runs/:id/abort', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const res = abortRun(db, id);
      return res;
    } catch (err) {
      return reply.code(404).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Triage bundle for one failed step: reason + evidence (screenshot/diff/video/logs/network)
  app.get('/api/runs/:id/steps/:idx/triage', async (req, reply) => {
    const { id, idx } = req.params as { id: string; idx: string };
    const step = db.prepare('SELECT * FROM run_steps WHERE run_id = ? AND idx = ?').get(id, Number(idx)) as
      | { idx: number; flow_name: string; status: string; reason: string | null; evidence_ids_json: string; duration_ms: number }
      | undefined;
    if (!step) return reply.code(404).send({ error: 'step not found' });
    const evIds = JSON.parse(step.evidence_ids_json) as string[];
    const evidence = evIds.length
      ? (db.prepare(`SELECT id, type, path, sha256, bytes FROM evidence WHERE id IN (${evIds.map(() => '?').join(',')})`).all(...evIds) as Array<{ id: string; type: string; path: string; sha256: string; bytes: number }>)
      : [];
    // video + logs attach at run level
    const runEvidence = db.prepare(`SELECT id, type FROM evidence WHERE bundle_id = ? AND type IN ('video','logs','network')`).all(id) as Array<{ id: string; type: string }>;
    const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Record<string, unknown>;
    return {
      step: { idx: step.idx, flow: step.flow_name, status: step.status, reason: step.reason, durationMs: step.duration_ms },
      evidence,
      runEvidence,
      run: { ticket: run['ticket_key'], artifactHash: run['artifact_hash'], freshness: run['freshness'], launchArgs: run['launch_args_json'], device: run['device_udid'] },
    };
  });

  // Jira evidence attachment (opt-in via env; 404 when disabled)
  app.post('/api/runs/:id/attach', async (req, reply) => {
    const cfg = jiraConfig();
    if (!cfg) return reply.code(404).send({ error: 'jira integration disabled (set JIRA_BASE/EMAIL/TOKEN)' });
    const { id } = req.params as { id: string };
    const built = buildCommentBody(db, id, cfg);
    if (!built) return reply.code(404).send({ error: 'run not found' });
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const commentId = await postComment(cfg, built.ticket, built.body);
        db.prepare('UPDATE runs SET jira_comment_id = ? WHERE id = ?').run(commentId, id);
        return { attached: true, commentId, ticket: built.ticket };
      } catch (err) {
        lastErr = err;
      }
    }
    return reply.code(502).send({ error: `jira failed twice: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}` });
  });

  // Re-run fragment: single flow, rerun kind, parent linked (synchronous for gate; queue path in M3 UI)
  app.post('/api/runs/:id/steps/:idx/rerun', async (req, reply) => {
    const { id, idx } = req.params as { id: string; idx: string };
    const step = db.prepare('SELECT flow_name FROM run_steps WHERE run_id = ? AND idx = ?').get(id, Number(idx)) as { flow_name: string } | undefined;
    if (!step) return reply.code(404).send({ error: 'step not found' });
    const q = db.prepare('SELECT spec_json FROM queue WHERE dispatched_run_id = ? ORDER BY rowid DESC LIMIT 1').get(id) as { spec_json: string } | undefined;
    if (!q) return reply.code(409).send({ error: 'original queue spec not found (runs API rerun requires queue-originated runs)' });
    const spec = JSON.parse(q.spec_json) as QueueSpec;
    const rerunId = await executeRun(
      {
        ticketKey: spec.ticketKey,
        flowsDir: spec.flowsDir,
        udid: spec.udid,
        app: spec.app,
        artifactPath: spec.artifactPath,
        ...(spec.srcPath !== undefined ? { srcPath: spec.srcPath } : {}),
        triggeredBy: `rerun:${(req.body as { by?: string } | undefined)?.by ?? 'api'}`,
        kind: 'rerun',
        parentRunId: id,
        onlyFlow: step.flow_name,
      },
      { db, bus: (req.server as unknown as { crucibleBus: TypedEventBus<AppEvents> }).crucibleBus, artifactsDir: process.env['CRUCIBLE_ARTIFACTS_DIR'] ?? './artifacts', dispatchDeps: alloyDispatchDepsSync() },
    );
    return { rerunId };
  });

  app.get('/api/runs/:id/steps', async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = db.prepare('SELECT id FROM runs WHERE id = ?').get(id);
    if (!run) return reply.code(404).send({ error: 'run not found' });
    const steps = db.prepare('SELECT * FROM run_steps WHERE run_id = ? ORDER BY idx').all(id);
    return { steps };
  });
}
