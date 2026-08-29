/** Flake analytics + quarantine (auto via runner hook, manual release with reason). */
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { TypedEventBus, AppEvents } from '../ws/bus.ts';
import { flowHistory, flakeScore } from '../domain/flake.ts';

export function registerFlakeRoutes(app: FastifyInstance, db: Database.Database, bus: TypedEventBus<AppEvents>): void {
  app.get('/api/flakes', async () => {
    const flows = db
      .prepare(`SELECT DISTINCT flow_name FROM run_steps ORDER BY flow_name`)
      .all() as Array<{ flow_name: string }>;
    const out = flows.map(({ flow_name }) => {
      const hist = flowHistory(db, flow_name);
      const q = db.prepare('SELECT * FROM flow_quarantine WHERE flow_key = ? AND released_at IS NULL').get(flow_name) as
        | { reason: string; by: string; at: number }
        | undefined;
      return {
        flow: flow_name,
        score: Math.round(flakeScore(hist) * 100) / 100,
        recent: hist.slice(0, 10).map((h) => h.status),
        quarantined: q !== undefined,
        quarantineReason: q?.reason ?? null,
      };
    });
    return { flakes: out.filter((f) => f.quarantined || f.score > 0) };
  });

  app.post('/api/flows/:key/quarantine', async (req, reply) => {
    const { key } = req.params as { key: string };
    const b = (req.body ?? {}) as { reason?: string; by?: string };
    if (!b.reason) return reply.code(400).send({ error: 'reason required (quarantine decisions are auditable)' });
    db.prepare(`INSERT OR REPLACE INTO flow_quarantine(flow_key, reason, by, at) VALUES (?, ?, ?, ?)`).run(key, b.reason, b.by ?? 'api', Date.now());
    bus.emit('flow.quarantined', { flowKey: key, reason: b.reason });
    return { quarantined: true };
  });

  app.delete('/api/flows/:key/quarantine', async (req, reply) => {
    const { key } = req.params as { key: string };
    const b = (req.body ?? {}) as { reason?: string; by?: string };
    if (!b.reason) return reply.code(400).send({ error: 'reason required to release' });
    const r = db
      .prepare(`UPDATE flow_quarantine SET released_by = ?, released_at = ? WHERE flow_key = ? AND released_at IS NULL`)
      .run(b.by ?? 'api', Date.now(), key);
    if (r.changes === 0) return reply.code(404).send({ error: 'no active quarantine' });
    return { released: true };
  });
}
