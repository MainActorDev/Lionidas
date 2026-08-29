import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { enqueue, abort, type QueueSpec } from '../queue/store.ts';
import { scanFlowSet } from '../domain/acs.ts';

interface RunRow {
  id: string; ticket_key: string; kind: string; status: string; triggered_by: string;
  device_udid: string; artifact_hash: string | null; freshness: string;
  launch_args_json: string; started_at: number | null; finished_at: number | null;
}

export function registerRunRoutes(app: FastifyInstance, db: Database.Database): void {
  app.post('/api/runs', async (req, reply) => {
    const body = req.body as Partial<QueueSpec> & { priority?: 'manual' | 'scheduled' | 'agent' };
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
    return { aborted: true };
  });

  app.get('/api/runs', async (req) => {
    const q = req.query as { ticket?: string; limit?: string };
    const limit = Math.min(Number.parseInt(q.limit ?? '50', 10) || 50, 200);
    const rows = q.ticket
      ? db.prepare('SELECT * FROM runs WHERE ticket_key = ? ORDER BY started_at DESC LIMIT ?').all(q.ticket, limit)
      : db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?').all(limit);
    return { runs: rows as RunRow[] };
  });

  app.get('/api/runs/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
    if (!run) return reply.code(404).send({ error: 'run not found' });
    return { run };
  });

  app.get('/api/runs/:id/steps', async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = db.prepare('SELECT id FROM runs WHERE id = ?').get(id);
    if (!run) return reply.code(404).send({ error: 'run not found' });
    const steps = db.prepare('SELECT * FROM run_steps WHERE run_id = ? ORDER BY idx').all(id);
    return { steps };
  });
}
