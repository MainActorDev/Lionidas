import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';

interface RunRow {
  id: string; ticket_key: string; kind: string; status: string; triggered_by: string;
  device_udid: string; artifact_hash: string | null; freshness: string;
  launch_args_json: string; started_at: number | null; finished_at: number | null;
}

export function registerRunRoutes(app: FastifyInstance, db: Database.Database): void {
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
