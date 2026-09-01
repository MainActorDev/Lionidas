import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { createReadStream, statSync } from 'node:fs';
import { withEngineHeal } from '../alloy/heal.ts';
import { crucibleAlloy } from '../alloy/client.ts';
import { alloyDispatchDepsSync } from '../alloy/runtime.ts';

export function registerDeviceRoutes(app: FastifyInstance, db: Database.Database): void {
  app.get('/api/devices', async () => {
    // simulator-only wall: physical devices stay out of the list entirely
    const rows = db
      .prepare("SELECT udid, name, state, platform, kind, os_version, lease_holder, lease_engine, last_seen FROM devices WHERE kind = 'simulator' ORDER BY state = 'Booted' DESC, name")
      .all();
    return { devices: rows };
  });

  // Boot/shutdown a simulator through the choke point (alloy_devices action passthrough).
  app.post('/api/devices/:udid/power', async (req, reply) => {
    const { udid } = req.params as { udid: string };
    const b = req.body as { action?: string };
    if (b?.action !== 'boot' && b?.action !== 'shutdown') {
      return reply.code(400).send({ error: 'action (boot|shutdown) required' });
    }
    const row = db.prepare('SELECT kind FROM devices WHERE udid = ?').get(udid) as { kind: string | null } | undefined;
    if (!row) return reply.code(404).send({ error: 'unknown device (is the poller running?)' });
    if (row.kind !== 'simulator') return reply.code(409).send({ error: 'power control is simulator-only' });
    if (db.prepare(`SELECT 1 FROM runs WHERE device_udid = ? AND status IN ('queued','running') LIMIT 1`).get(udid)) {
      return reply.code(409).send({ error: 'a run is active on this device' });
    }
    if (db.prepare(`SELECT 1 FROM manual_sessions WHERE udid = ? AND finished_at IS NULL LIMIT 1`).get(udid)) {
      return reply.code(409).send({ error: 'a manual session holds this device' });
    }
    const alloy = crucibleAlloy();
    const r = (await alloy.dispatch('alloy_devices', { action: b.action, udid }, alloyDispatchDepsSync())) as
      | { ok: true }
      | { ok: false; error: { message: string } };
    if (!r.ok) return reply.code(502).send({ error: `${b.action} failed: ${r.error.message}` });
    return { ok: true };
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

  // S1: live stream URL (watch = read-only, no lease). Fails soft → wall falls back to pulse.
  // Streaming is simulator-only (engine MJPEG has no physical-device source) — gate early
  // so the UI gets an honest, typed reason instead of a generic engine failure.
  app.post('/api/devices/:udid/stream', async (req, reply) => {
    const { udid } = req.params as { udid: string };
    const booted = db.prepare(`SELECT state, platform, kind FROM devices WHERE udid = ?`).get(udid) as
      | { state: string | null; platform: string | null; kind: string | null }
      | undefined;
    if (!booted || booted.state !== 'Booted') return reply.code(409).send({ error: 'device not booted' });
    if (booted.kind !== 'simulator') {
      return reply.code(422).send({ error: 'live stream is simulator-only (no MJPEG source for physical devices)', code: 'SIM_ONLY' });
    }
    // self-heal: a dead tool-server ("fetch failed") is the known staleness
    // class — one engine reset + retry before surfacing the error
    const r = (await withEngineHeal(async () =>
      crucibleAlloy().dispatch('alloy_stream', { udid }, alloyDispatchDepsSync()))) as
      | { ok: true; result: { streamUrl: string; platform: string } }
      | { ok: false; error: { code: string; message: string } };
    if (!r.ok) return reply.code(503).send({ error: `stream unavailable: ${r.error.message}`, code: r.error.code });
    return r.result;
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
