import type { FastifyInstance } from 'fastify';
import { execFile } from 'node:child_process';
import { ensureSimdeck } from '../simdeck/supervisor.ts';
import type Database from 'better-sqlite3';
import { createReadStream, statSync } from 'node:fs';
import { crucibleAlloy } from '../alloy/client.ts';
import { alloyDispatchDepsSync } from '../alloy/runtime.ts';
import { execFileSync } from 'node:child_process';

/** Host-memory attribution for booted sims: one ps sweep per request, every
 *  process whose command line references the udid (sim processes + the
 *  engine's headless bridge) sums into that device's RSS. Injectable so
 *  tests fake it (a real sweep in CI is host-dependent). */
export type PsSweep = () => Array<{ rss: number; command: string }>;
export function realPsSweep(): Array<{ rss: number; command: string }> {
  const out = execFileSync('ps', ['-axo', 'rss=,command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 5_000 });
  return out.split('\n').flatMap((line) => {
    const m = /^\s*(\d+)\s(.+)$/.exec(line);
    return m ? [{ rss: Number(m[1]), command: m[2] as string }] : [];
  });
}
/** Test seam. */
export const __psSweep = { fn: realPsSweep };

/** Sum host RSS (bytes) per udid from one sweep. */
function memoryByUdid(sweep: PsSweep): Map<string, number> {
  const map = new Map<string, number>();
  for (const p of sweep()) {
    // udids are UUID-shaped (8-4-4-4-12 hex) — scan, don't split
    const re = /[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(p.command)) !== null) map.set(m[0], (map.get(m[0]) ?? 0) + p.rss * 1024);
  }
  return map;
}

/** Poll the LIVE device state (fresh `simctl list`, not the 2s-lagging
 *  mirror) until `want(state)` holds. CoreSimulator flips power state
 *  asynchronously AFTER simctl commands return — the mirror alone is too
 *  stale to sequence restart's shutdown→boot transition. False on timeout —
 *  callers surface, never guess. */
/** udids with a restart in flight (the power route holds the whole cycle).
 *  Exposed on GET /api/devices so ANY page can show the restarting state —
 *  not just the one that clicked the button (found live: cockpit reload
 *  mid-restart showed nothing; the client-only set lost the state). */
const restartingInFlight = new Set<string>();

/** test seam: replace the state source (unit tests inject a fake udid→state map) */
export let __deviceStateSource: ((udid: string, cb: (state: string | null) => void) => void) | null = null;
export function __setDeviceStateSourceForTest(fn: typeof __deviceStateSource): void { __deviceStateSource = fn; }

function waitForDeviceState(udid: string, want: (s: string | null) => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const readState = __deviceStateSource ?? ((u: string, cb: (s: string | null) => void) => {
    execFile('xcrun', ['simctl', 'list', 'devices', '-j'], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      let state: string | null = null;
      if (!err) {
        try {
          const payload = JSON.parse(String(stdout)) as { devices?: Record<string, Array<{ udid: string; state: string }>> };
          for (const list of Object.values(payload.devices ?? {})) {
            const hit = list.find((e) => e.udid === u);
            if (hit) { state = hit.state; break; }
          }
        } catch { /* parse failure = keep polling */ }
      }
      cb(state);
    });
  });
  return new Promise((resolve) => {
    const tick = () => {
      readState(udid, (state) => {
        if (state !== null && want(state)) return resolve(true);
        if (Date.now() >= deadline) return resolve(false);
        setTimeout(tick, 700);
      });
    };
    tick();
  });
}

export function registerDeviceRoutes(app: FastifyInstance, db: Database.Database): void {
  app.get('/api/devices', async (req) => {
    // simulator-only wall: physical devices stay out of the list entirely
    const rows = db
      .prepare(`SELECT d.udid, d.name, d.state, d.platform, d.kind, d.os_version, d.resolution, d.lease_holder, d.lease_engine, d.last_seen,
                       CASE WHEN d.lease_holder LIKE 'manual:%' THEN COALESCE((SELECT ms.operator FROM manual_sessions ms WHERE ms.id = substr(d.lease_holder, 8) AND ms.finished_at IS NULL), 'manual') ELSE d.lease_holder END AS lease_display,
                       (SELECT MAX(t) FROM (
                         SELECT MAX(started_at) t FROM runs WHERE device_udid = d.udid
                         UNION ALL
                         SELECT MAX(started_at) FROM manual_sessions WHERE udid = d.udid
                       )) AS last_used
                FROM devices d WHERE d.kind = 'simulator' ORDER BY d.state = 'Booted' DESC, d.name`)
      .all() as Array<Record<string, unknown>>;
    // pins are per-account (req.user via session hook; anonymous = none)
    const pinnedSet = new Set<string>();
    if (req.user?.id) {
      const pins = db.prepare('SELECT udid FROM device_pins WHERE user_id = ?').all(req.user.id) as Array<{ udid: string }>;
      for (const p of pins) pinnedSet.add(p.udid);
    }
    // host memory: booted rows only — one sweep, matched per udid
    const mem = memoryByUdid(__psSweep.fn);
    const devices = rows.map((r) => ({
      ...r,
      pinned: pinnedSet.has(r.udid as string),
      lastUsed: (r.last_used as number | null) ?? null,
      memoryRss: r.state === 'Booted' ? mem.get(r.udid as string) ?? 0 : null,
      restarting: restartingInFlight.has(r.udid as string),
    }));
    return { devices };
  });

  // ── pins (per-account favorites) ──
  app.put('/api/devices/:udid/pin', async (req, reply) => {
    if (!req.user?.id) return reply.code(401).send({ error: 'sign in to pin devices' });
    const { udid } = req.params as { udid: string };
    db.prepare('INSERT OR IGNORE INTO device_pins(user_id, udid, pinned_at) VALUES (?, ?, ?)').run(req.user.id, udid, Date.now());
    return { ok: true, pinned: true };
  });

  app.delete('/api/devices/:udid/pin', async (req, reply) => {
    if (!req.user?.id) return reply.code(401).send({ error: 'sign in to unpin devices' });
    const { udid } = req.params as { udid: string };
    db.prepare('DELETE FROM device_pins WHERE user_id = ? AND udid = ?').run(req.user.id, udid);
    return { ok: true, pinned: false };
  });

  // Boot/shutdown a simulator through the choke point (alloy_devices action passthrough).
  app.post('/api/devices/:udid/power', async (req, reply) => {
    const { udid } = req.params as { udid: string };
    const b = req.body as { action?: string };
    if (b?.action !== 'boot' && b?.action !== 'shutdown' && b?.action !== 'restart') {
      return reply.code(400).send({ error: 'action (boot|shutdown|restart) required' });
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
    // restart = shutdown + boot server-side (simctl has no restart): one
    // guard check, one pending state on the UI — not two user actions racing.
    const one = (action: 'boot' | 'shutdown') =>
      alloy.dispatch(
        'alloy_devices',
        { action, udid, ...(action === 'boot' ? { headless: true } : {}) },
        alloyDispatchDepsSync(),
      ) as
        | Promise<{ ok: true }>
        | Promise<{ ok: false; error: { message: string } }>;
    const withLeaseRetry = async (action: 'shutdown' | 'boot') => {
      let r = await one(action);
      // DEVICE_IN_USE with no Crucible-side run/session = engine-A's shared
      // 'alloy' session (fixed name, re-opened by every dispatch) is still open.
      // It's ours — release it (closes the session + clears the device claim)
      // and retry once. Genuine third-party ownership still errors out.
      if (!r.ok && action === 'shutdown' && /active session device/i.test(r.error.message)) {
        await alloy.dispatch('alloy_release', { udid }, alloyDispatchDepsSync()).catch(() => undefined);
        r = await one(action);
      }
      return r;
    };
    let r = b.action === 'restart' ? await withLeaseRetry('shutdown') : await withLeaseRetry(b.action as 'boot' | 'shutdown');
    if (b.action === 'restart') restartingInFlight.add(udid);
    try {
    if (r.ok && b.action === 'restart') {
      // Restart races TWO async layers (found live 2026-10-03, twice):
      //  1. simctl shutdown returns BEFORE CoreSimulator flips state — the
      //     mirror still says Booted, engine-A's ensure-boot no-ops.
      //  2. Even booting after the mirror flips can LOSE: a boot issued
      //     while the OS shutdown is still completing "succeeds" and is then
      //     killed by the finishing shutdown (observed: boot result
      //     `booted:true` at +3.4s, device left Shutdown).
      // Fix: wait for the shutdown to LAND (fresh simctl, not the lagging
      // poller mirror), boot, then VERIFY the device actually reached Booted
      // — retry the boot once if the shutdown finished after it.
      const landed = await waitForDeviceState(udid, (s) => s !== 'Booted', 20_000);
      if (!landed) return reply.code(502).send({ error: 'restart failed: device never reached Shutdown (20s)' });
      r = await one('boot');
      if (r.ok) {
        let up = await waitForDeviceState(udid, (s) => s === 'Booted', 45_000);
        if (!up) {
          // the shutdown finished after our boot — one clean retry now that
          // the device is truly down
          r = await one('boot');
          if (r.ok) up = await waitForDeviceState(udid, (s) => s === 'Booted', 45_000);
        }
        if (!up) return reply.code(502).send({ error: 'restart failed: device did not come back up' });
      }
    } else if (r.ok && b.action === 'boot') {
      // boot alone: verify too — an ensure-boot can no-op against a stale
      // Booted observation and report success while the device is down
      const up = await waitForDeviceState(udid, (s) => s === 'Booted', 45_000);
      if (!up) return reply.code(502).send({ error: 'boot failed: device did not reach Booted (45s)' });
    }
    if (!r.ok) { if (b.action === 'restart') restartingInFlight.delete(udid); return reply.code(502).send({ error: `${b.action} failed: ${r.error.message}` }); }
    return { ok: true };
    } finally { if (b.action === 'restart') restartingInFlight.delete(udid); }
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
  // the wrapped device surface is the ONLY engine: gate early,
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
      await ensureSimdeck();
      return { simdeckUrl: `/simdeck/simulators/${encodeURIComponent(udid)}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      req.log.warn({ err: msg }, 'simdeck unavailable');
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
