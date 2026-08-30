import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { createReadStream, statSync } from 'node:fs';
import { crucibleAlloy } from '../alloy/client.ts';
import { alloyDispatchDepsSync } from '../alloy/runtime.ts';

export function registerDeviceRoutes(app: FastifyInstance, db: Database.Database): void {
  app.get('/api/devices', async () => {
    const rows = db.prepare('SELECT udid, name, state, lease_holder, lease_engine, last_seen FROM devices ORDER BY name').all();
    return { devices: rows };
  });

  // Watch pulse: one screenshot on demand (read-only; never takes a lease).
  // Watching is NOT holding — the wall must not block automation.
  app.post('/api/devices/:udid/watch-frame', async (req, reply) => {
    const { udid } = req.params as { udid: string };
    const booted = db.prepare(`SELECT state FROM devices WHERE udid = ?`).get(udid) as { state: string | null } | undefined;
    if (!booted || booted.state !== 'Booted') return reply.code(409).send({ error: 'device not booted' });
    const alloy = crucibleAlloy();
    const r = (await alloy.dispatch('alloy_screenshot', { udid }, alloyDispatchDepsSync())) as
      | { ok: true; result: { path: string } }
      | { ok: false; error: { message: string } };
    if (!r.ok) return reply.code(503).send({ error: `frame failed: ${r.error.message}` });
    return { path: r.result.path };
  });

  // frame file serve for watch (same guard shape as manual-frame but allows a booted device)
  app.get('/api/watch-frame', async (req, reply) => {
    const q = req.query as { path?: string };
    if (!q.path) return reply.code(400).send({ error: 'path required' });
    try {
      const st = statSync(q.path);
      reply.header('content-type', 'image/png');
      reply.header('content-length', String(st.size));
      return reply.send(createReadStream(q.path));
    } catch {
      return reply.code(404).send({ error: 'frame not found' });
    }
  });
}
