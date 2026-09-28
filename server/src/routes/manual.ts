/** Manual cockpit routes (lease-held, never rolls up). */
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { TypedEventBus, AppEvents } from '../ws/bus.ts';
import { createReadStream, statSync, rm } from 'node:fs';
import { requireRole } from '../auth/roles.ts';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startManualSession, manualTap, manualScroll, manualType, manualSnapshot, manualProbeSelector, manualTree, finishManualSession, setRecording, getRecording, deleteRecordedStep, recordExpectStep, manualGesture, touchSessionActivity, ManualSessionError } from '../manual/session.ts';
import { inspectSample } from '../manual/inspect-route-fns.ts';
import { dumpViewtree, ViewtreeError, acquireViewtreeLock, releaseViewtreeLock } from '../manual/viewtree.ts';
import { fetchProbeViewtree, probeArmed, ProbeError } from '../manual/viewtree-probe.ts';
import { listSimulatorApps } from '../manual/apps.ts';
import { installApp } from '../manual/app-install.ts';
import { findArtifacts, importArtifact, appsStoreDir } from '../manual/artifacts.ts';
import { existsSync } from 'node:fs';
import { runTemplatePlayback, PlaybackError } from '../manual/playback.ts';
import type { ForgeState } from '../forge/proxy.ts';

export interface ManualRouteDeps {
  bus: TypedEventBus<AppEvents>;
  dispatchDeps: unknown;
  artifactsDir: string;
  forgeState: ForgeState;
}

export function registerManualRoutes(
  // frame serve: only paths under the manual session's snapshot dir (engine temp)
  // — scoped by checking the file was the LAST snapshot emitted for a live session
  app: FastifyInstance, db: Database.Database, deps: ManualRouteDeps): void {
  app.get('/api/manual-frame', async (req, reply) => {
    const q = req.query as { path?: string };
    if (!q.path) return reply.code(400).send({ error: 'path required' });
    // allow only paths recorded by a live session's latest snapshot (no arbitrary file reads)
    const ok = db
      .prepare('SELECT 1 FROM manual_sessions WHERE finished_at IS NULL LIMIT 1')
      .get();
    if (!ok) return reply.code(409).send({ error: 'no live manual session' });
    try {
      const st = statSync(q.path);
      reply.header('content-type', 'image/png');
      reply.header('content-length', String(st.size));
      const stream = createReadStream(q.path);
      // fast-path screenshots land in engine temp dirs (temp screenshot prefix)
      // that NOTHING owns after serving — the client-visible contract makes the
      // reader the owner. Delete after the last byte so the dirs don't pile up
      // (175+ leaked from a single day of driving). Scoped to the temp prefix;
      // artifact-managed paths (evidence, thumbs) never match.
      const tempShotDir = dirname(q.path);
      // engine names these dirs "<engine>-device-screenshot-<id>"; match by the
      // fixed suffix shape instead of naming the engine (hygiene scan).
      if (q.path.includes(tmpdir()) && /^[a-z]+-device-screenshot-[A-Za-z0-9]+$/i.test(tempShotDir)) {
        stream.on('close', () => { rm(tempShotDir, { recursive: true, force: true }, () => undefined); });
      }
      return reply.send(stream);
    } catch {
      return reply.code(404).send({ error: 'frame not found' });
    }
  });

  app.post('/api/manual/start', async (req, reply) => {
    const b = req.body as { udid?: string; operator?: string; appBundleId?: string };
    const operator = req.user?.name ?? b?.operator; // authenticated identity wins; bots keep their name
    if (!b.udid || !operator) return reply.code(400).send({ error: 'udid required (sign in for operator identity)' });
    try {
      // Pre-select the app to open a session on: explicit param > running-app
      // guess (non-Apple, non-xctrunner) > Settings fallback. Opening the app
      // that's ALREADY foreground avoids hijacking the user's screen — a wrong
      // guess only foregrounds a running app; save-time binding uses the
      // snapshot root regardless.
      let appBundleId = b.appBundleId;
      if (!appBundleId) {
        try {
          const apps = await listSimulatorApps(b.udid);
          const guess = apps.find((a) => a.running && !a.bundleId.startsWith('com.apple.') && !a.bundleId.endsWith('.xctrunner'));
          appBundleId = guess?.bundleId;
        } catch { /* guess best-effort — fallback applies */ }
      }
      const s = await startManualSession({ db, bus: deps.bus, dispatchDeps: deps.dispatchDeps }, b.udid, operator, appBundleId);
      return s;
    } catch (err) {
      if (err instanceof ManualSessionError) return reply.code(err.code === 'QUEUE_ACTIVE' ? 409 : 410).send({ error: err.message, code: err.code });
      throw err;
    }
  });

  app.post('/api/manual/:id/tap', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as { x?: number; y?: number };
    if (typeof b.x !== 'number' || typeof b.y !== 'number') return reply.code(400).send({ error: 'x,y required' });
    try {
      await manualTap({ db, bus: deps.bus, dispatchDeps: deps.dispatchDeps }, id, b.x, b.y);
      return { ok: true };
    } catch (err) {
      if (err instanceof ManualSessionError) return reply.code(410).send({ error: err.message, code: err.code });
      throw err;
    }
  });

  app.post('/api/manual/:id/touch1', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as { phase?: string; x?: number; y?: number; edge?: string };
    if (!b.phase || !['down', 'move', 'up'].includes(b.phase)) return reply.code(400).send({ error: 'phase (down|move|up) required' });
    if (typeof b.x !== 'number' || typeof b.y !== 'number') return reply.code(400).send({ error: 'x,y required' });
    try {
      await manualGesture({ db, bus: deps.bus, dispatchDeps: deps.dispatchDeps }, id, { kind: 'touch1', phase: b.phase, x: b.x, y: b.y, ...(b.edge ? { edge: b.edge } : {}) });
      return { ok: true };
    } catch (err) {
      if (err instanceof ManualSessionError) return reply.code(410).send({ error: err.message, code: err.code });
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(503).send({ error: `input unavailable: ${msg}`, retryable: msg === 'INPUT_TIMEOUT' });
    }
  });

  app.post('/api/manual/:id/touch2', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as { phase?: string; x1?: number; y1?: number; x2?: number; y2?: number };
    if (!b.phase || !['down', 'move', 'up'].includes(b.phase)) return reply.code(400).send({ error: 'phase (down|move|up) required' });
    for (const k of ['x1', 'y1', 'x2', 'y2'] as const) {
      if (typeof b[k] !== 'number') return reply.code(400).send({ error: `${k} required` });
    }
    try {
      await manualGesture({ db, bus: deps.bus, dispatchDeps: deps.dispatchDeps }, id, { kind: 'touch2', phase: b.phase, x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 });
      return { ok: true };
    } catch (err) {
      if (err instanceof ManualSessionError) return reply.code(410).send({ error: err.message, code: err.code });
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(503).send({ error: `input unavailable: ${msg}`, retryable: msg === 'INPUT_TIMEOUT' });
    }
  });

  app.post('/api/manual/:id/swipe', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as { startX?: number; startY?: number; endX?: number; endY?: number; duration?: number };
    for (const [k, v] of Object.entries(b)) if (k !== 'duration' && typeof v !== 'number') return reply.code(400).send({ error: `${k} required (number)` });
    try {
      await manualGesture({ db, bus: deps.bus, dispatchDeps: deps.dispatchDeps }, id, { kind: 'swipe', startX: b.startX, startY: b.startY, endX: b.endX, endY: b.endY, duration: b.duration ?? 0.25 });
      return { ok: true };
    } catch (err) {
      if (err instanceof ManualSessionError) return reply.code(410).send({ error: err.message, code: err.code });
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(503).send({ error: `input unavailable: ${msg}`, retryable: msg === 'INPUT_TIMEOUT' });
    }
  });

  app.post('/api/manual/:id/key', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as { code?: string; modifiers?: string[]; duration?: number };
    if (!b.code) return reply.code(400).send({ error: 'code required' });
    try {
      await manualGesture({ db, bus: deps.bus, dispatchDeps: deps.dispatchDeps }, id, { kind: 'key', code: b.code, modifiers: b.modifiers ?? [], duration: b.duration ?? 0.1 });
      return { ok: true };
    } catch (err) {
      if (err instanceof ManualSessionError) return reply.code(410).send({ error: err.message, code: err.code });
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: `input rejected: ${msg}` });   // parse errors are 400-class (bad key/text)
    }
  });

  app.post('/api/manual/:id/button', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as { button?: string; duration?: number };
    if (!b.button) return reply.code(400).send({ error: 'button required' });
    if (b.button === 'siri') return reply.code(400).send({ error: 'siri rejected: crashes backboardd on every known path' });
    try {
      await manualGesture({ db, bus: deps.bus, dispatchDeps: deps.dispatchDeps }, id, { kind: 'press', button: b.button, duration: b.duration ?? 0 });
      return { ok: true };
    } catch (err) {
      if (err instanceof ManualSessionError) return reply.code(410).send({ error: err.message, code: err.code });
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(400).send({ error: `input rejected: ${msg}` });
    }
  });

  app.post('/api/manual/:id/scroll-delta', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as { deltaX?: number; deltaY?: number };
    if (typeof b.deltaX !== 'number' && typeof b.deltaY !== 'number') return reply.code(400).send({ error: 'deltaX or deltaY required' });
    try {
      await manualGesture({ db, bus: deps.bus, dispatchDeps: deps.dispatchDeps }, id, { kind: 'scroll', deltaX: b.deltaX ?? 0, deltaY: b.deltaY ?? 0 });
      return { ok: true };
    } catch (err) {
      if (err instanceof ManualSessionError) return reply.code(410).send({ error: err.message, code: err.code });
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(503).send({ error: `input unavailable: ${msg}`, retryable: msg === 'INPUT_TIMEOUT' });
    }
  });

  app.post('/api/manual/:id/scroll', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as { direction?: string };
    if (!b.direction || !['up', 'down', 'left', 'right'].includes(b.direction)) return reply.code(400).send({ error: 'direction (up|down|left|right) required' });
    try {
      await manualScroll({ db, bus: deps.bus, dispatchDeps: deps.dispatchDeps }, id, b.direction as 'up' | 'down' | 'left' | 'right');
      return { ok: true };
    } catch (err) {
      if (err instanceof ManualSessionError) return reply.code(410).send({ error: err.message, code: err.code });
      throw err;
    }
  });

  app.post('/api/manual/:id/type', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as { x?: number; y?: number; text?: string };
    // text is required; x,y optional — engine typing goes to the focused
    // field, coordinates only feed the alloy fill fallback
    if (typeof b.text !== 'string' || b.text.length === 0) return reply.code(400).send({ error: 'text required' });
    try {
      await manualType({ db, bus: deps.bus, dispatchDeps: deps.dispatchDeps }, id, b.x ?? null, b.y ?? null, b.text);
      return { ok: true };
    } catch (err) {
      if (err instanceof ManualSessionError) return reply.code(410).send({ error: err.message, code: err.code });
      throw err;
    }
  });

  // ── recorder ──
  app.post('/api/manual/:id/probe-selector', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as { selector?: { identifier?: string; label?: string; type?: string } } | null;
    if (!b?.selector) return reply.code(400).send({ error: 'selector required' });
    try {
      return await manualProbeSelector({ db, bus: deps.bus, dispatchDeps: deps.dispatchDeps }, id, b.selector);
    } catch (err) {
      if (err instanceof ManualSessionError) return reply.code(410).send({ error: err.message, code: err.code });
      throw err;
    }
  });

  // Inspect mode: full AX tree for the overlay (boxes + drawer). Dumb pipe —
  // nodes verbatim; interpretation lives in @crucible/shared/ax-tree.
  app.post('/api/manual/:id/heartbeat', async (req, _reply) => {
    // direct-WS input bypasses the HTTP routes that refresh last_activity —
    // the wall pings this while driving so the 5-min idle watchdog doesn't
    // reap a session mid-use (input then dies with 'not granted' while the
    // stream keeps playing — the 'silent unresponsive' bug).
    const { id } = req.params as { id: string };
    touchSessionActivity({ db, bus: deps.bus, dispatchDeps: deps.dispatchDeps }, id);
    return { ok: true };
  });

  app.post('/api/manual/:id/viewtree', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { source?: string };
    // ⛔ never during playback: the lldb dump SIGSTOPs the app (~7s) — that
    // poisons settle polls and watchdogs. Same 409 class as install/power.
    // The PROBE never pauses the app, but its walk hops the main thread
    // mid-run — same guard applies to BOTH sources, cheap consistency.
    // Manual-kind runs are EXCLUDED — a manual session's own parent row is
    // kind='manual' status='running' by design (startManualSession); only
    // AUTOMATED runs block, matching session-start semantics.
    const s = db.prepare('SELECT udid, app_bundle_id FROM manual_sessions WHERE id = ? AND finished_at IS NULL').get(id) as { udid: string; app_bundle_id: string | null } | undefined;
    if (!s) return reply.code(410).send({ error: 'session not found', code: 'SESSION_NOT_FOUND' });
    const busy = db.prepare(`SELECT 1 FROM runs WHERE device_udid = ? AND status IN ('queued','running') AND kind != 'manual' LIMIT 1`).get(s.udid);
    if (busy) return reply.code(409).send({ error: 'a run holds this device — viewtree pauses the app and would poison it', code: 'DEVICE_BUSY' });
    const dev = db.prepare('SELECT platform, kind FROM devices WHERE udid = ?').get(s.udid) as { platform: string | null; kind: string | null } | undefined;
    if (dev?.platform !== 'ios' || dev?.kind !== 'simulator') return reply.code(422).send({ error: 'viewtree is simulator-only (lldb attach)', code: 'NOT_SIM' });
    if (body.source === 'probe') {
      // Opt-in in-process source (P3). The session must have armed the
      // probe at start (env-gated) — refuse honestly with the hint rather
      // than timing out on a non-injected app.
      if (!probeArmed(s.udid)) {
        return reply.code(409).send({
          error: 'probe not armed for this device — start the session with CRUCIBLE_VIEWTREE_PROBE=1 (and relaunch the app after arming)',
          code: 'PROBE_NOT_ARMED',
        });
      }
      if (!acquireViewtreeLock(s.udid)) {
        return reply.code(409).send({ error: 'a viewtree dump is already in flight for this device', code: 'DEVICE_BUSY' });
      }
      try {
        const r = await fetchProbeViewtree(s.udid, s.app_bundle_id);
        // Honesty contract: the app was never paused and never attached —
        // no pausedMs, no pid. `injected` badges the mechanism instead.
        return { nodes: r.nodes, source: 'probe' as const, waitMs: r.waitMs, injected: true };
      } catch (err) {
        if (err instanceof ProbeError) {
          const code = err.code === 'NO_RESPONSE' || err.code === 'NO_KEY_WINDOW' ? 422 : 502;
          return reply.code(code).send({ error: err.message, code: err.code });
        }
        throw err;
      } finally {
        releaseViewtreeLock(s.udid);
      }
    }
    try {
      const r = await dumpViewtree(s.udid, s.app_bundle_id);
      return { nodes: r.nodes, pausedMs: r.pausedMs, pid: r.pid };
    } catch (err) {
      if (err instanceof ViewtreeError) {
        const code = err.code === 'DEVICE_BUSY' ? 409 : err.code === 'NO_APP' ? 422 : 502;
        return reply.code(code).send({ error: err.message, code: err.code });
      }
      throw err;
    }
  });

  /** Registry-UI stage 3 — probe: live AX tree for the screens page.
   *  Creates (or reuses) a manual session on the given booted udid and
   *  returns the element tree. Standalone route so the screens page doesn't
   *  need the full manual-session lifecycle; the session id returns for
   *  follow-up probes (tree refresh). Degrades 400/410 like the family. */
  app.post('/api/probe/:udid/tree', async (req, reply) => {
    const { udid } = req.params as { udid: string };
    const b = req.body as { sessionId?: string; bundle?: string } | null;
    const operator = req.user?.name;
    if (!operator) return reply.code(400).send({ error: 'sign in required' });
    const dev = db.prepare('SELECT udid FROM devices WHERE udid = ? AND state = ?').get(udid, 'Booted');
    if (!dev) return reply.code(409).send({ error: `device ${udid.slice(0, 8)} is not booted — boot it on the devices page first`, code: 'DEVICE_NOT_BOOTED' });
    try {
      let sessionId = b?.sessionId;
      if (sessionId) {
        const alive = db.prepare('SELECT id FROM manual_sessions WHERE id = ? AND finished_at IS NULL').get(sessionId);
        if (!alive) sessionId = undefined; // expired — start fresh (review F5 degrade)
      }
      if (!sessionId) {
        // probing is registry-scoped: the caller names the app; the session
        // binds to it (no Settings fallback — a Settings tree is useless for
        // defining app screen states). startManualSession foregrounds it.
        const s = await startManualSession({ db, bus: deps.bus, dispatchDeps: deps.dispatchDeps }, udid, req.user?.name ?? 'probe', b?.bundle ?? 'com.apple.Preferences');
        sessionId = s.sessionId;
      }
      const tree = await manualTree({ db, bus: deps.bus, dispatchDeps: deps.dispatchDeps }, sessionId);
      return { sessionId, nodes: tree.nodes, logicalW: tree.logicalW, logicalH: tree.logicalH, capturedAt: tree.capturedAt };
    } catch (err) {
      if (err instanceof ManualSessionError) return reply.code(410).send({ error: err.message, code: err.code });
      throw err;
    }
  });

  app.post('/api/manual/:id/tree', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await manualTree({ db, bus: deps.bus, dispatchDeps: deps.dispatchDeps }, id);
    } catch (err) {
      if (err instanceof ManualSessionError) return reply.code(410).send({ error: err.message, code: err.code });
      throw err;
    }
  });

  app.post('/api/manual/:id/inspect-sample', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as {
      rect?: { x: number; y: number; width: number; height: number };
      logicalW?: number;
      nodeType?: string | null;
    };
    try {
      return await inspectSample(
        { db, bus: deps.bus, dispatchDeps: deps.dispatchDeps },
        id,
        body.rect as { x: number; y: number; width: number; height: number },
        body.logicalW as number,
        body.nodeType ?? null,
      );
    } catch (err) {
      if (err instanceof ManualSessionError) {
        const code = err.code === 'BAD_RECT' ? 400 : 410;
        return reply.code(code).send({ error: err.message, code: err.code });
      }
      throw err;
    }
  });

  app.post('/api/manual/:id/record/expect', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as { selector?: { identifier?: string; label?: string; type?: string }; at?: { x?: unknown; y?: unknown } } | null;
    if (!b?.selector || (!b.selector.label && !b.selector.identifier)) return reply.code(400).send({ error: 'selector with label or identifier required' });
    const at = b.at && typeof b.at.x === 'number' && typeof b.at.y === 'number' ? { x: b.at.x, y: b.at.y } : undefined;
    try {
      return recordExpectStep({ db, bus: deps.bus, dispatchDeps: deps.dispatchDeps }, id, b.selector, at);
    } catch (err) {
      if (err instanceof ManualSessionError) return reply.code(410).send({ error: err.message, code: err.code });
      throw err;
    }
  });

  app.post('/api/manual/:id/record', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as { on?: boolean };
    if (typeof b.on !== 'boolean') return reply.code(400).send({ error: 'on (boolean) required' });
    try {
      return setRecording({ db, bus: deps.bus, dispatchDeps: deps.dispatchDeps }, id, b.on);
    } catch (err) {
      if (err instanceof ManualSessionError) return reply.code(410).send({ error: err.message, code: err.code });
      throw err;
    }
  });

  app.get('/api/manual/:id/record', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return getRecording({ db, bus: deps.bus, dispatchDeps: deps.dispatchDeps }, id);
    } catch (err) {
      if (err instanceof ManualSessionError) return reply.code(410).send({ error: err.message, code: err.code });
      throw err;
    }
  });

  app.post('/api/manual/:id/record/steps/:idx/delete', async (req, reply) => {
    const { id, idx } = req.params as { id: string; idx: string };
    const n = Number(idx);
    if (!Number.isInteger(n)) return reply.code(400).send({ error: 'idx required' });
    try {
      return deleteRecordedStep({ db, bus: deps.bus, dispatchDeps: deps.dispatchDeps }, id, n);
    } catch (err) {
      if (err instanceof ManualSessionError) return reply.code(410).send({ error: err.message, code: err.code });
      throw err;
    }
  });

  // step thumbnails: same scoping as manual-frame (live session required)
  app.get('/api/manual-thumb', async (req, reply) => {
    const q = req.query as { path?: string };
    if (!q.path) return reply.code(400).send({ error: 'path required' });
    const ok = db.prepare('SELECT 1 FROM manual_sessions WHERE finished_at IS NULL LIMIT 1').get();
    if (!ok) return reply.code(409).send({ error: 'no live manual session' });
    try {
      const st = statSync(q.path);
      reply.header('content-type', 'image/png');
      reply.header('content-length', String(st.size));
      return reply.send(createReadStream(q.path));
    } catch {
      return reply.code(404).send({ error: 'thumb not found' });
    }
  });

  // ── template playback ──
  app.post('/api/templates/:id/play', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as { udid?: string; triggeredBy?: string; scenarioId?: string; env?: Record<string, string>; variant?: string } | null;
    try {
      // Phase C: variants expand HERE (single-play entry point). A variants
      // case runs ONCE PER VARIANT, sequentially (declaration order — proxy
      // state is device-global). `variant: 'id'` runs exactly one.
      const row = db.prepare('SELECT variants_json, steps_json FROM templates WHERE id = ?').get(id) as { variants_json: string | null; steps_json: string | null } | undefined;
      // R2: a case with world: steps swaps scenarios mid-run itself — lane
      // fan-out would re-run every world N times (proven: the drill case
      // played all 3 lanes × 2 internal swaps). Worlds-cases run ONCE on
      // play-all, entering via their first declared world.
      const stepsHaveSwap = (() => {
        try { return row?.steps_json ? (JSON.parse(row.steps_json) as Array<{ action?: string }>).some((s) => s.action === 'swap' || s.action === 'world') : false; } catch { return false; }
      })();
      let variants: Array<{ id: string; network?: string; networkScenario?: string; env?: Record<string, string> }> = [];
      if (row?.variants_json) {
        try { variants = JSON.parse(row.variants_json) as typeof variants; } catch { variants = []; /* malformed — honest degrade */ }
      }
      const baseOpts = { ...(b?.udid !== undefined ? { udid: b.udid } : {}), ...(req.user?.name !== undefined ? { triggeredBy: req.user.name } : (b?.triggeredBy !== undefined ? { triggeredBy: b.triggeredBy } : {})), ...(b?.scenarioId !== undefined ? { scenarioId: b.scenarioId } : {}), ...(b?.env !== undefined ? { env: b.env } : {}) };
      // VITEST builds skip the stream gate (no device stream exists in unit
      // tests; the gate would burn its full 30s budget per run). Prod keeps it.
      const pbDeps = { db, bus: deps.bus, dispatchDeps: deps.dispatchDeps, artifactsDir: deps.artifactsDir, forgeState: deps.forgeState, ...(process.env['VITEST'] ? { awaitStreamLive: null } : {}) };
      if (b?.variant !== undefined) {
        const one = variants.find((v) => v.id === b.variant);
        if (!one) {
          return reply.code(422).send({ error: `case has no variant "${b.variant}"${variants.length ? ` (has: ${variants.map((v) => v.id).join(', ')})` : ' (case has no variants)'}` });
        }
        const { runId, udid } = await runTemplatePlayback(pbDeps, id, { ...baseOpts, variant: one });
        return { runId, udid, variants: [{ id: one.id, runId }] };
      }
      if (variants.length > 0 && !stepsHaveSwap) {
        // Sequential CONTRACT preserved: each lane runs to completion before
        // the next starts — proxy state is device-global and the B5 device-
        // busy guard would 409 a back-to-back start anyway. But the RESPONSE
        // no longer awaits the whole play: it used to hang for minutes (one
        // full play per lane), and the watch dock only opens after the
        // response — so variant plays "ran in the background". Start lane 1,
        // chain the rest detached, return the planned lane order; the dock
        // follows lanes via run.started events.
        // Overview slice: a multi-variant play IS an execution set — mint one
        // batchId shared by every lane (single `variant: 'id'` above stays a
        // TRUE solo play: NULL batch, not a set).
        const batchId = `batch_${randomUUID().slice(0, 8)}`;
        const runIds: string[] = [];
        const perVariant: Array<{ id: string; runId: string | null }> =
          variants.map((v) => ({ id: v.id, runId: null }));
        const laneStatus = (rid: string): string | null =>
          (db.prepare('SELECT status FROM runs WHERE id = ?').get(rid) as { status: string } | undefined)?.status ?? null;
        // start ≠ done: resolve when the run row exists (watch dock opens
        // NOW), done settles when the lane finishes (chain sequencing)
        const startLane = async (v: { id: string; network?: string; networkScenario?: string; env?: Record<string, string> }): Promise<{ runId: string; done: Promise<unknown> }> => {
          const { runId, udid, done } = await runTemplatePlayback(pbDeps, id, { ...baseOpts, variant: v, batchId });
          runIds.push(runId);
          perVariant.find((p) => p.id === v.id)!.runId = runId;
          if (!firstUdid) firstUdid = udid;
          done.catch(() => { /* per-lane failures land on the run row */ });
          return { runId, done };
        };
        let firstUdid = '';
        const first = await startLane(variants[0]!);
        // abort cascade: an aborted lane means the user stopped the PLAY —
        // remaining lanes must not start. Chain errors (e.g. DEVICE_BUSY on
        // a later lane) stop the chain the same way; they must not reject an
        // already-answered request.
        void (async () => {
          await first.done.catch(() => { /* lane 1 verdict lands on its run row */ });
          if (laneStatus(first.runId) === 'aborted') return;
          for (let i = 1; i < variants.length; i++) {
            const lane = await startLane(variants[i]!).catch(() => null);
            if (lane === null) return;
            await lane.done.catch(() => { /* verdict lands on the run row */ });
            if (laneStatus(lane.runId) === 'aborted') return;
          }
        })();
        // runIds/perVariant carry only STARTED lanes at response time — ids
        // arrive as lanes start; laneCount is the full plan
        return { runId: first.runId, runIds, udid: firstUdid, laneCount: variants.length, batchId, variants: perVariant };
      }
      // worlds-case play-all: single run, entry world = first declared
      const entryVariant = stepsHaveSwap ? variants[0] : undefined;
      const { runId, udid } = await runTemplatePlayback(pbDeps, id, entryVariant ? { ...baseOpts, variant: entryVariant } : baseOpts);
      return { runId, udid, ...(stepsHaveSwap ? { swaps: true } : {}) };
    } catch (err) {
      if (err instanceof PlaybackError && err.code === 'DEVICE_BUSY') return reply.code(409).send({ error: err.message, code: err.code });
      if (err instanceof PlaybackError && err.code === 'SCENARIO_INACTIVE') return reply.code(409).send({ error: err.message, code: err.code, hint: 'start the forge proxy and sim routing (forge page), then replay' });
      if (err instanceof PlaybackError && err.code === 'APP_NOT_INSTALLED') {
        return reply.code(409).send({ error: err.message, code: err.code, appBundleId: err.payload?.appBundleId, udid: err.payload?.udid, lastArtifact: err.payload?.lastArtifact ?? null });
      }
      if (err instanceof PlaybackError && err.code === 'DEVICE_AMBIGUOUS') {
        return reply.code(409).send({ error: err.message, code: err.code, booted: err.payload?.booted ?? [] });
      }
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── explicit install (app-catalog feature, 2026-09-04): direct simctl
  //  install from a chosen artifact; non-store paths are first IMPORTED into
  //  the Crucible store (APFS clone) so the catalog never references repo/
  //  DerivedData paths. One install per device; never while a run holds it. ──
  app.post('/api/devices/:udid/install', async (req, reply) => {
    const { udid } = req.params as { udid: string };
    const b = (req.body ?? {}) as { appPath?: string };
    if (!b.appPath) return reply.code(422).send({ error: 'appPath required' });
    if (!existsSync(b.appPath)) return reply.code(400).send({ error: `artifact not found: ${b.appPath}` });
    const st = db.prepare('SELECT state FROM devices WHERE udid = ?').get(udid) as { state: string | null } | undefined;
    if (!st || st.state !== 'Booted') return reply.code(409).send({ error: 'device not booted', code: 'DEVICE_NOT_BOOTED' });
    const busy = db.prepare(`SELECT 1 FROM runs WHERE device_udid = ? AND status IN ('queued','running') LIMIT 1`).get(udid)
      ?? db.prepare('SELECT 1 FROM manual_sessions WHERE udid = ? AND finished_at IS NULL LIMIT 1').get(udid);
    if (busy) return reply.code(409).send({ error: 'a run or manual session is active on this device — wait or abort it', code: 'DEVICE_BUSY' });
    let storePath: string;
    try {
      storePath = b.appPath.startsWith(appsStoreDir()) ? b.appPath : importArtifact(b.appPath);
    } catch (err) {
      return reply.code(502).send({ error: `import failed: ${err instanceof Error ? err.message : String(err)}`, code: 'ARTIFACT_UNREADABLE' });
    }
    const r = await installApp({ db }, { udid, appPath: storePath });
    if (!r.ok) {
      const code = r.code === 'INSTALL_IN_FLIGHT' ? 409 : 502;
      return reply.code(code).send({ error: r.error, code: r.code });
    }
    return { ok: true, version: r.version, durationMs: r.durationMs };
  });

  // discovery for the artifact picker: build dirs + DerivedData + our store,
  // freshest first, source-labeled (repo/cache dirs are PICK sources only)
  app.get('/api/devices/:udid/artifacts', async () => {
    return { artifacts: findArtifacts() };
  });

  // ── app catalog: identity + icon for the device's installed apps ──
  app.get('/api/devices/:udid/apps', async (req, reply) => {
    const { udid } = req.params as { udid: string };
    try {
      const apps = await listSimulatorApps(udid);
      return { apps };
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'simctl failed' });
    }
  });

  // icon: served straight from the app bundle on disk (path resolved through
  // the catalog — request only names the device + bundle id)
  app.get('/api/devices/:udid/apps/:bundleId/icon', async (req, reply) => {
    const { udid, bundleId } = req.params as { udid: string; bundleId: string };
    try {
      const apps = await listSimulatorApps(udid);
      const app = apps.find((a) => a.bundleId === decodeURIComponent(bundleId));
      if (!app?.iconPath) return reply.code(404).send({ error: 'no icon' });
      return reply.header('content-type', 'image/png').send(createReadStream(app.iconPath));
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'icon read failed' });
    }
  });

  app.post('/api/manual/:id/snapshot', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const r = await manualSnapshot({ db, bus: deps.bus, dispatchDeps: deps.dispatchDeps }, id);
      return r;
    } catch (err) {
      if (err instanceof ManualSessionError) return reply.code(410).send({ error: err.message, code: err.code });
      throw err;
    }
  });

  app.post('/api/manual/:id/finish', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { note?: string };
    try {
      await finishManualSession({ db, bus: deps.bus, dispatchDeps: deps.dispatchDeps }, id, b.note);
      return { ok: true };
    } catch (err) {
      if (err instanceof ManualSessionError) return reply.code(410).send({ error: err.message, code: err.code });
      throw err;
    }
  });

  // ── batch regression run: device-lane parallel (2026-09-06 plan) — one
  // lane per booted sim, lane serial (B5 intact), lanes concurrent. One
  // booted device ≡ the old sequential engine (same per-case semantics).
  // Shared by play-all AND plans (one engine). ──
  // authenticated identity wins for attribution; body triggeredBy only for
  // bots/agents whose user IS the machine. Mirrors the manual-session rule.
  async function runBatch(b: { tags?: string; app?: string; udid?: string; triggeredBy?: string; scenarioId?: string; env?: Record<string, string>; cases?: Array<{ templateId: string; variantIds?: string[] | null }>; suiteId?: string; planId?: string }, reqUser?: { name: string } | null):
    Promise<{ ok: true; runIds: string[]; count: number; batchId?: string; lanes?: Array<{ device: { udid: string; name: string | null }; runIds: string[]; skipped: string[]; haltedAt?: string; haltedReason?: string }> } | { ok: false; code: 400 | 409; error: string; runIds: string[]; appBundleId?: string; booted?: Array<{ udid: string; name: string | null }>; lastArtifact?: { path: string; version: string | null; recordedAt: number } | null }> {
    const { selectTemplates } = await import('./templates.ts');
    const { planLanes } = await import('../manual/batch/plan.ts');
    const { runParallelBatch, ParallelScenarioError } = await import('../manual/batch/pool.ts');
    // Phase D T3: explicit case list (suites) bypasses tag selection — the
    // caller already resolved membership. Ghost templateId (stale cached
    // client list; DB membership FK-cascades) → honest 400, never a 500.
    let sel: Array<{ id: string }>;
    if (b.cases !== undefined) {
      const ghosts = b.cases.map((c) => c.templateId).filter((tid) => db.prepare('SELECT 1 FROM templates WHERE id = ?').get(tid) == null);
      if (ghosts.length > 0) return { ok: false, code: 400, error: `unknown template: ${ghosts.join(', ')}`, runIds: [] };
      sel = b.cases.map((c) => ({ id: c.templateId }));
    } else {
      const rows = db.prepare('SELECT * FROM templates ORDER BY updated_at DESC').all() as Array<{ id: string; app_bundle_id: string | null; tags_json: string | null; status: string | null }>;
      sel = selectTemplates(rows as never, { tags: b.tags, app: b.app, excludeDeprecated: true });
    }
    if (sel.length === 0) return { ok: false, code: 400, error: 'no templates match', runIds: [] };

    // device lanes: explicit udid pins one device (today's behavior);
    // otherwise every booted sim from the mirror becomes a lane
    let devices: Array<{ udid: string; name: string | null }>;
    if (b.udid !== undefined) {
      devices = [{ udid: b.udid, name: b.udid }];
    } else {
      devices = (db.prepare(`SELECT udid, name FROM devices WHERE state = 'Booted' AND kind = 'simulator' ORDER BY udid`).all() as Array<{ udid: string; name: string | null }>);
      if (devices.length === 0) devices = [{ udid: '', name: null }]; // resolveUdid's recorded/ambiguity path
    }

    // cost hint: total duration of each template's LATEST finished run
    const costFor = (templateId: string): number | null => {
      const last = db.prepare(`SELECT id FROM runs WHERE template_id = ? AND finished_at IS NOT NULL ORDER BY started_at DESC LIMIT 1`).get(templateId) as { id: string } | undefined;
      if (!last) return null;
      const r = db.prepare(`SELECT COALESCE(SUM(duration_ms), 0) AS ms FROM run_steps WHERE run_id = ?`).get(last.id) as { ms: number };
      return r.ms > 0 ? r.ms : null;
    };

    // Phase C: variant expansion — a variants case becomes one lane entry
    // per variant (the variantless/plain execution never mingles with them).
    // Malformed variants_json degrades to plain (honest, vocabulary rule).
    const variantsOf = (templateId: string): Array<{ id: string; network?: string; networkScenario?: string; env?: Record<string, string> }> => {
      const row = db.prepare('SELECT variants_json FROM templates WHERE id = ?').get(templateId) as { variants_json: string | null } | undefined;
      if (!row?.variants_json) return [];
      try { return JSON.parse(row.variants_json) as Array<{ id: string; network?: string; networkScenario?: string; env?: Record<string, string> }>; } catch { return []; }
    };
    // Phase C: variant expansion — a variants case becomes one lane entry
    // per variant (the variantless/plain execution never mingles with them).
    // Malformed variants_json degrades to plain (honest, vocabulary rule).
    // Phase D T3: a suite member's pinned subset plays ONLY those variants;
    // NULL = the case's default (all variants / plain).
    const pinned = new Map((b.cases ?? []).map((c) => [c.templateId, c.variantIds ?? null] as const));
    const batchCases = sel.flatMap((t) => {
      const all = variantsOf(t.id);
      const vs = pinned.get(t.id) != null ? all.filter((v) => (pinned.get(t.id) as string[]).includes(v.id)) : all;
      const cost = costFor(t.id) ?? null;
      if (vs.length === 0) return [{ templateId: t.id, costMs: cost }];
      // cost ×N estimate until per-variant history exists (deterministic,
      // monotone — no invented averaging)
      return vs.map((v) => ({ templateId: t.id, variantId: v.id, costMs: cost !== null ? cost * vs.length : null }));
    });

    const maxLanes = Number(process.env['CRUCIBLE_BATCH_MAX_LANES'] ?? '0') || undefined;
    const lanes = planLanes({
      cases: batchCases,
      devices,
      ...(maxLanes !== undefined ? { maxLanes } : {}),
    });
    const multiLane = lanes.filter((l) => l.cases.length > 0).length > 1;

    const by = reqUser?.name ?? b.triggeredBy; // session user > explicit body > legacy 'qa' fallback
    const batchOpts: Record<string, unknown> = {
      ...(by !== undefined ? { triggeredBy: by } : {}),
      ...(b.scenarioId !== undefined ? { scenarioId: b.scenarioId } : {}),
      ...(b.env !== undefined ? { env: b.env } : {}),
      ...(b.suiteId !== undefined ? { suiteId: b.suiteId } : {}),
      ...(b.planId !== undefined ? { planId: b.planId } : {}),
      ...(multiLane ? { forgeAttribution: false } : {}), // proxy can't tell sims apart
    };

    let result;
    try {
      result = await runParallelBatch(
        { db, bus: deps.bus, forgeState: deps.forgeState } as never,
        {
          lanes,
          opts: batchOpts,
          runOne: async (templateId, udid, o, variantId) => {
            const variant = variantId !== undefined ? variantsOf(templateId).find((v) => v.id === variantId) ?? null : null;
            return runTemplatePlayback(
              { db, bus: deps.bus, dispatchDeps: deps.dispatchDeps, artifactsDir: deps.artifactsDir, forgeState: deps.forgeState, ...(process.env['VITEST'] ? { awaitStreamLive: null } : {}) },
              templateId,
              { ...(o as Record<string, unknown>), ...(variant ? { variant } : {}) },
            );
          },
        },
      );
    } catch (err) {
      if (err instanceof ParallelScenarioError) {
        return { ok: false, code: 409, error: `${err.message} — run with a single device or drop the scenario`, runIds: [] };
      }
      throw err;
    }

    // single-device lanes keep today's honest error payloads: a halted lane
    // on a one-lane batch = the old batch-abort
    if (lanes.filter((l) => l.cases.length > 0).length === 1 && result.lanes.some((l) => l.haltedAt)) {
      const halted = result.lanes.find((l) => l.haltedAt)!;
      return {
        ok: false, code: 409,
        error: `batch aborted at template ${halted.haltedAt}: ${halted.haltedReason ?? 'device unavailable'}`,
        runIds: result.runIds.filter((id) => !id.startsWith('failed:')),
      };
    }
    return { ok: true, runIds: result.runIds.filter((id) => !id.startsWith('failed:')), count: sel.length, batchId: result.batchId, lanes: result.lanes };
  }

  // batch abort: stop dispatching pending lane cases (in-flight runs use the
  // run-abort between-steps semantics — the pool never kills one)
  app.post('/api/batches/:id/abort', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { abortBatch } = await import('../manual/batch/pool.ts');
    if (!abortBatch(id)) return reply.code(404).send({ error: 'unknown or settled batch' });
    return { ok: true };
  });

  // folder-level run (plan 20260928T023000Z F1): resolve the subtree, drop
  // deprecated, hand runBatch its existing `cases` contract — zero changes
  // to the batch machinery itself.
  app.post('/api/folders/:id/run', { preHandler: requireRole('operator') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(id) as { id: string; app_bundle_id: string; name: string } | undefined;
    if (!folder) return reply.code(404).send({ error: 'folder not found' });
    const sub = (() => { const out: string[] = []; const q = [id]; while (q.length) { const c = q.shift()!; if (out.includes(c)) continue; out.push(c); q.push(...(db.prepare('SELECT id FROM folders WHERE parent_id = ?').all(c) as Array<{ id: string }>).map((k) => k.id)); } return out; })();
    const ph = sub.map(() => '?').join(',');
    const rows = db.prepare(`SELECT id, status, app_bundle_id FROM templates WHERE folder_id IN (${ph})`).all(...sub) as Array<{ id: string; status: string | null; app_bundle_id: string | null }>;
    const runnable = rows.filter((t) => (t.status ?? 'active') !== 'deprecated');
    if (runnable.length === 0) return reply.code(400).send({ error: `folder "${folder.name}" holds no runnable cases (deprecated excluded)` });
    const r = await runBatch({ app: folder.app_bundle_id, cases: runnable.map((t) => ({ templateId: t.id })), triggeredBy: `folder:${folder.name}` }, req.user);
    if (!r.ok) return reply.code(r.code).send({ error: r.error, code: r.code === 409 ? 'DEVICE_BUSY' : undefined, runIds: r.runIds });
    return { runIds: r.runIds, count: r.count, batchId: r.batchId };
  });

  app.post('/api/templates/play-all', async (req, reply) => {
    const b = (req.body ?? {}) as { tags?: string; app?: string; udid?: string; triggeredBy?: string; scenarioId?: string; env?: Record<string, string> };
    const r = await runBatch(b, req.user);
    if (!r.ok) return reply.code(r.code).send({ error: r.error, code: r.code === 409 ? 'DEVICE_BUSY' : undefined, runIds: r.runIds });
    return { runIds: r.runIds, count: r.count, batchId: r.batchId };
  });

  // ── plans (B4): remembered suite invocations — tag filter + device + app +
  //  scenario + env, replayed through runBatch. CRUD lives with templates —
  //  a plan IS a saved templates-page state, not a separate world.
  //  Phase D T5: a plan may instead reference a SUITE as its case source
  //  (exactly-one-of tags|suite — empty tags + suiteId, never both). ──
  const planRow = (r: { id: string; name: string; tags_json: string; udid: string | null; app_bundle_id: string | null; scenario_id: string | null; env_json: string; created_by: string; created_at: number; updated_at: number; suite_id: string | null }) => ({
    id: r.id, name: r.name, tags: JSON.parse(r.tags_json) as string[], udid: r.udid, appBundleId: r.app_bundle_id, scenarioId: r.scenario_id, env: JSON.parse(r.env_json) as Record<string, string>, suiteId: r.suite_id, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
  });
  const normalizeTags = (raw: unknown): string[] => [...new Set((Array.isArray(raw) ? raw : []).map((t) => String(t).trim()).filter(Boolean))].slice(0, 8);
  // exactly-one-of: a suite-sourced plan carries NO tags; a tag plan carries
  // no suite. Returns the (tags, suiteId) pair to persist or an error.
  const resolveSource = (tags: unknown, suiteId: unknown): { tags: string[]; suiteId: string | null } | { error: string } => {
    const t = normalizeTags(tags);
    const s = typeof suiteId === 'string' && suiteId ? suiteId : null;
    if (s !== null && t.length > 0) return { error: 'plan source is exactly-one-of tags|suite — set only one' };
    return { tags: t, suiteId: s };
  };

  app.get('/api/plans', async () => {
    const rows = db.prepare('SELECT * FROM plans ORDER BY updated_at DESC').all() as never[];
    return { plans: rows.map(planRow) };
  });

  app.post('/api/plans', async (req, reply) => {
    const b = (req.body ?? {}) as { name?: string; tags?: string[]; udid?: string; appBundleId?: string; scenarioId?: string; env?: Record<string, string>; createdBy?: string; suiteId?: string | null };
    if (!b.name?.trim()) return reply.code(400).send({ error: 'name required' });
    const src = resolveSource(b.tags, b.suiteId);
    if ('error' in src) return reply.code(400).send({ error: src.error });
    if (src.suiteId !== null && db.prepare('SELECT 1 FROM suites WHERE id = ?').get(src.suiteId) == null) return reply.code(400).send({ error: `unknown suite: ${src.suiteId}` });
    const id = `plan_${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    try {
      db.prepare(`INSERT INTO plans(id, name, tags_json, udid, app_bundle_id, scenario_id, env_json, created_by, created_at, updated_at, suite_id)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, b.name.trim(), JSON.stringify(src.tags), b.udid ?? null, b.appBundleId ?? null, b.scenarioId ?? null, JSON.stringify(b.env ?? {}), b.createdBy ?? 'qa', now, now, src.suiteId);
    } catch { return reply.code(409).send({ error: 'plan name already exists' }); }
    return planRow(db.prepare('SELECT * FROM plans WHERE id = ?').get(id) as never);
  });

  app.patch('/api/plans/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { name?: string; tags?: string[]; udid?: string | null; appBundleId?: string | null; scenarioId?: string | null; env?: Record<string, string>; suiteId?: string | null };
    const row = db.prepare('SELECT * FROM plans WHERE id = ?').get(id) as { id: string } | undefined;
    if (!row) return reply.code(404).send({ error: 'not found' });
    if (b.name !== undefined && !b.name.trim()) return reply.code(400).send({ error: 'name cannot be empty' });
    const prev = db.prepare('SELECT * FROM plans WHERE id = ?').get(id) as { name: string; tags_json: string; udid: string | null; app_bundle_id: string | null; scenario_id: string | null; env_json: string; suite_id: string | null };
    // T5: source flips between tags and suite via exactly-one-of. When only
    // one side is sent, the OTHER falls back to the row's current value —
    // but a suite-sourced row's tags are [] so the pair stays exclusive.
    const nextTags = b.tags !== undefined ? b.tags : JSON.parse(prev.tags_json) as string[];
    const nextSuite = b.suiteId !== undefined ? b.suiteId : prev.suite_id;
    const src = resolveSource(nextTags, nextSuite);
    if ('error' in src) return reply.code(400).send({ error: src.error });
    if (src.suiteId !== null && db.prepare('SELECT 1 FROM suites WHERE id = ?').get(src.suiteId) == null) return reply.code(400).send({ error: `unknown suite: ${src.suiteId}` });
    db.prepare(`UPDATE plans SET name = ?, tags_json = ?, udid = ?, app_bundle_id = ?, scenario_id = ?, env_json = ?, updated_at = ?, suite_id = ? WHERE id = ?`)
      .run(
        b.name !== undefined ? b.name.trim() : prev.name,
        JSON.stringify(src.tags),
        b.udid !== undefined ? b.udid : prev.udid,
        b.appBundleId !== undefined ? b.appBundleId : prev.app_bundle_id,
        b.scenarioId !== undefined ? b.scenarioId : prev.scenario_id,
        b.env !== undefined ? JSON.stringify(b.env) : prev.env_json,
        Date.now(), id, src.suiteId,
      );
    return planRow(db.prepare('SELECT * FROM plans WHERE id = ?').get(id) as never);
  });

  app.delete('/api/plans/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = db.prepare('DELETE FROM plans WHERE id = ?').run(id);
    if (r.changes === 0) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });

  app.post('/api/plans/:id/run', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.prepare('SELECT * FROM plans WHERE id = ?').get(id) as { tags_json: string; udid: string | null; app_bundle_id: string | null; scenario_id: string | null; env_json: string; suite_id: string | null } | undefined;
    if (!row) return reply.code(404).send({ error: 'not found' });
    const p = planRow({ ...row, id, name: '', created_by: 'qa', created_at: 0, updated_at: 0 });
    // T5: suite-sourced plan → members resolved LIVE at run time (no stale
    // snapshot); tag plan → tags as today. suiteId stamps the runs (T4).
    const memberRows = p.suiteId !== null
      ? db.prepare('SELECT * FROM suite_members WHERE suite_id = ? ORDER BY position').all(p.suiteId) as Array<{ template_id: string; variant_ids_json: string | null }>
      : [];
    const r = await runBatch({
      ...(p.suiteId !== null
        ? { cases: memberRows.map((m) => ({ templateId: m.template_id, variantIds: m.variant_ids_json ? (JSON.parse(m.variant_ids_json) as string[]) : null })), suiteId: p.suiteId, triggeredBy: `suite-plan:${p.name || id}` }
        : { tags: (p.tags as string[]).join(','), triggeredBy: `plan:${p.name || id}` }),
      ...(p.appBundleId !== null ? { app: p.appBundleId } : {}),
      ...(p.udid !== null ? { udid: p.udid } : {}),
      ...(p.scenarioId !== null ? { scenarioId: p.scenarioId } : {}),
      env: p.env,
      planId: id, // F4: plan-scope env_vars resolve for every case in this play
    }, req.user); // session user wins for run attribution
    if (!r.ok) return reply.code(r.code).send({ error: r.error, code: r.code === 409 ? 'DEVICE_BUSY' : undefined, runIds: r.runIds });
    return { runIds: r.runIds, count: r.count };
  });

  // ── Phase D T3: suite play — membership read live at play time, handed
  //  to runBatch as an explicit case list (bypasses tag selection). Pinned
  //  variantIds play ONLY those variants; NULL = case default. T4: suiteId
  //  stamps every spawned run. Same engine as play-all/plans.
  //  Bundle drift: a member whose template's bundle was later edited away
  //  from the suite's scope is SKIPPED with a named reason (no silent
  //  deletion, no blocked run) — surfaced in the response so the board can
  //  flag it. ──
  app.post('/api/suites/:id/play', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.prepare('SELECT * FROM suites WHERE id = ?').get(id) as { id: string; name: string; app_bundle_id: string | null } | undefined;
    if (!row) return reply.code(404).send({ error: 'not found' });
    const members = (db.prepare('SELECT * FROM suite_members WHERE suite_id = ? ORDER BY position').all(id) as Array<{ template_id: string; variant_ids_json: string | null }>)
      .map((m) => ({ templateId: m.template_id, variantIds: m.variant_ids_json ? (JSON.parse(m.variant_ids_json) as string[]) : null }));
    if (members.length === 0) return reply.code(400).send({ error: 'suite has no members' });
    // drift filter: template bundles that no longer match the suite scope
    // (Phase E) + deprecated members — skipped with a named reason, never a
    // silent deletion. Same honest-response shape as bundle drift.
    const bundleOf = db.prepare('SELECT app_bundle_id AS b, status AS st FROM templates WHERE id = ?');
    const variantsOfTpl = db.prepare('SELECT variants_json FROM templates WHERE id = ?');
    const drifted: string[] = [];
    const deprecatedSkipped: string[] = [];
    const ghostPins: Array<{ templateId: string; dead: string[] }> = [];
    const inScope = members.filter((m) => {
      const t = (bundleOf.get(m.templateId) as { b: string | null; st: string | null } | undefined);
      if (t?.st === 'deprecated') { deprecatedSkipped.push(m.templateId); return false; }
      const b = t?.b ?? null;
      const ok = row.app_bundle_id === null || b === row.app_bundle_id;
      if (!ok) drifted.push(m.templateId);
      if (ok && m.variantIds != null) {
        // dead-variant pin: pinned ids missing from the case's CURRENT vocab.
        // All-dead → skip the member (never silently play a plain run);
        // partial → play survivors, name the dead in the response.
        const vocab = (() => { try { return JSON.parse((variantsOfTpl.get(m.templateId) as { variants_json: string | null } | undefined)?.variants_json ?? 'null') as Array<{ id: string }> | null; } catch { return null; } })();
        const dead = m.variantIds.filter((v) => !(vocab ?? []).some((x) => x.id === v));
        if (dead.length > 0) {
          const alive = m.variantIds.filter((v) => !dead.includes(v));
          if (alive.length === 0) { ghostPins.push({ templateId: m.templateId, dead }); return false; }
          m.variantIds = alive;
          ghostPins.push({ templateId: m.templateId, dead });
        }
      }
      return ok;
    });
    if (ghostPins.length > 0) req.log.warn(`suite play ghost variant pins: ${JSON.stringify(ghostPins)}`);
    const allSkipped = inScope.length === 0;
    if (allSkipped) {
      // three honest dead-ends, each with its own code+message (phase E added
      // the deprecated case — the old two-way ternary would have LIED here)
      const drift = drifted.length > 0
        ? `every member drifted out of ${row.app_bundle_id ?? 'suite scope'}: ${drifted.join(', ')}`
        : deprecatedSkipped.length > 0
          ? `every member is deprecated: ${deprecatedSkipped.join(', ')}`
          : `every member has only dead variant pins: ${ghostPins.map((g) => `${g.templateId}(${g.dead.join(',')})`).join('; ')}`;
      const code = drifted.length > 0 ? 'BUNDLE_DRIFT' : deprecatedSkipped.length > 0 ? 'DEPRECATED' : 'DEAD_VARIANTS';
      return reply.code(409).send({ error: drift, code, skipped: [...drifted, ...deprecatedSkipped, ...ghostPins.map((g) => g.templateId)] });
    }
    const b = (req.body ?? {}) as { udid?: string; triggeredBy?: string };
    const r = await runBatch({
      cases: inScope,
      ...(b.udid !== undefined ? { udid: b.udid } : {}),
      triggeredBy: `suite:${row.name}`,
      suiteId: row.id,
    }, req.user);
    if (!r.ok) return reply.code(r.code).send({ error: r.error, code: r.code === 409 ? 'DEVICE_BUSY' : undefined, runIds: r.runIds });
    return { runIds: r.runIds, count: r.count, batchId: r.batchId, ...(drifted.length > 0 ? { skippedDrifted: drifted } : {}), ...(deprecatedSkipped.length > 0 ? { skippedDeprecated: deprecatedSkipped } : {}), ...(ghostPins.length > 0 ? { skippedDeadVariants: ghostPins } : {}) };
  });
}
