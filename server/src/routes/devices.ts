import type { FastifyInstance } from 'fastify';
import { ensureScreenstream, screenstreamUrl } from '../stream/screenstream.ts';
import type Database from 'better-sqlite3';
import { createReadStream, statSync } from 'node:fs';
import { crucibleAlloy } from '../alloy/client.ts';
import { dispatchWithHeal } from '../alloy/heal.ts';
import { alloyDispatchDepsSync } from '../alloy/runtime.ts';

export function registerDeviceRoutes(app: FastifyInstance, db: Database.Database): void {
  app.get('/api/devices', async () => {
    // simulator-only wall: physical devices stay out of the list entirely
    const rows = db
      .prepare(`SELECT d.udid, d.name, d.state, d.platform, d.kind, d.os_version, d.resolution, d.lease_holder, d.lease_engine, d.last_seen,
                       CASE WHEN d.lease_holder LIKE 'manual:%' THEN COALESCE((SELECT ms.operator FROM manual_sessions ms WHERE ms.id = substr(d.lease_holder, 8) AND ms.finished_at IS NULL), 'manual') ELSE d.lease_holder END AS lease_display
                FROM devices d WHERE d.kind = 'simulator' ORDER BY d.state = 'Booted' DESC, d.name`)
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
    // Boot is headless: a dashboard power button must not splash the
    // Simulator.app GUI over the user's desktop (ENGINE-A-CLI ≥ headless
    // support; the engine ignores the key on older builds — fail-open GUI).
    const dispatch = () =>
      alloy.dispatch(
        'alloy_devices',
        { action: b.action, udid, ...(b.action === 'boot' ? { headless: true } : {}) },
        alloyDispatchDepsSync(),
      ) as
        | Promise<{ ok: true }>
        | Promise<{ ok: false; error: { message: string } }>;
    let r = await dispatch();
    // DEVICE_IN_USE with no Crucible-side run/session = engine-A's shared
    // 'alloy' session (fixed name, re-opened by every dispatch) is still open.
    // It's ours — release it (closes the session + clears the device claim)
    // and retry once. Genuine third-party ownership still errors out.
    if (!r.ok && b.action === 'shutdown' && /active session device/i.test(r.error.message)) {
      await alloy.dispatch('alloy_release', { udid }, alloyDispatchDepsSync()).catch(() => undefined);
      r = await dispatch();
    }
    if (!r.ok) return reply.code(502).send({ error: `${b.action} failed: ${r.error.message}` });
    return { ok: true };
  });

  // Watch pulse: one screenshot on demand (read-only; never takes a lease).
  // Watching is NOT holding — the wall must not block automation.
  app.post('/api/devices/:udid/watch-frame', async (req, reply) => {
    const { udid } = req.params as { udid: string };
    const booted = db.prepare(`SELECT state FROM devices WHERE udid = ?`).get(udid) as { state: string | null } | undefined;
    if (!booted || booted.state !== 'Booted') return reply.code(409).send({ error: 'device not booted' });
    // a run holds the device: a screenshot capture here races the run's acts
    // on one runner session and wedges its watchdog on heavy screens —
    // refuse; the UI keeps the last frame and the run finishes clean.
    const runHolds = db.prepare(`SELECT 1 FROM runs WHERE device_udid = ? AND status IN ('queued','running') LIMIT 1`).get(udid);
    if (runHolds) return reply.code(409).send({ error: 'a run holds this device — frame paused', code: 'RUN_ACTIVE' });
    const alloy = crucibleAlloy();
    const r = (await alloy.dispatch('alloy_screenshot', { udid }, alloyDispatchDepsSync())) as
      | { ok: true; result: { path: string } }
      | { ok: false; error: { message: string } };
    if (!r.ok) return reply.code(503).send({ error: `frame failed: ${r.error.message}` });
    return { path: r.result.path };
  });

  // S1: live stream URL (watch = read-only, no lease). Fails soft → wall falls back to pulse.
  // crucible-screenstream is the ONLY engine (no MJPEG fallback): gate early,
  // surface engine failures honestly with a retry hint.
  app.post('/api/devices/:udid/stream', async (req, reply) => {
    const { udid } = req.params as { udid: string };
    const booted = db.prepare(`SELECT state, kind FROM devices WHERE udid = ?`).get(udid) as
      | { state: string | null; kind: string | null }
      | undefined;
    if (!booted || booted.state !== 'Booted') return reply.code(409).send({ error: 'device not booted' });
    if (booted.kind && booted.kind !== 'simulator') {
      return reply.code(422).send({ error: 'live stream is simulator-only (no framebuffer source for physical devices)', code: 'SIM_ONLY' });
    }
    try {
      await ensureScreenstream();
      return { streamUrl: screenstreamUrl(udid), format: 'avcc' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      req.log.warn({ err: msg }, 'crucible-screenstream unavailable');
      // A spawn/health failure is transient by construction (binary missing is
      // the one permanent class) — the UI offers a retry.
      const permanent = msg.includes('binary not found');
      return reply.code(503).send({ error: `stream unavailable: ${msg}`, retryable: !permanent });
    }
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
