/** Manual cockpit routes (lease-held, never rolls up). */
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { TypedEventBus, AppEvents } from '../ws/bus.ts';
import { createReadStream, statSync } from 'node:fs';
import { startManualSession, manualTap, manualScroll, manualType, manualSnapshot, finishManualSession, setRecording, getRecording, deleteRecordedStep, ManualSessionError } from '../manual/session.ts';
import { listSimulatorApps } from '../manual/apps.ts';
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
      return reply.send(createReadStream(q.path));
    } catch {
      return reply.code(404).send({ error: 'frame not found' });
    }
  });

  app.post('/api/manual/start', async (req, reply) => {
    const b = req.body as { udid?: string; operator?: string; appBundleId?: string };
    if (!b.udid || !b.operator) return reply.code(400).send({ error: 'udid and operator required' });
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
      const s = await startManualSession({ db, bus: deps.bus, dispatchDeps: deps.dispatchDeps }, b.udid, b.operator, appBundleId);
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
    if (typeof b.x !== 'number' || typeof b.y !== 'number' || typeof b.text !== 'string') return reply.code(400).send({ error: 'x,y,text required' });
    try {
      await manualType({ db, bus: deps.bus, dispatchDeps: deps.dispatchDeps }, id, b.x, b.y, b.text);
      return { ok: true };
    } catch (err) {
      if (err instanceof ManualSessionError) return reply.code(410).send({ error: err.message, code: err.code });
      throw err;
    }
  });

  // ── recorder ──
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
    const b = req.body as { udid?: string; triggeredBy?: string; scenarioId?: string; env?: Record<string, string> } | null;
    try {
      const { runId } = await runTemplatePlayback(
        { db, bus: deps.bus, dispatchDeps: deps.dispatchDeps, artifactsDir: deps.artifactsDir, forgeState: deps.forgeState },
        id,
        { ...(b?.udid !== undefined ? { udid: b.udid } : {}), ...(b?.triggeredBy !== undefined ? { triggeredBy: b.triggeredBy } : {}), ...(b?.scenarioId !== undefined ? { scenarioId: b.scenarioId } : {}), ...(b?.env !== undefined ? { env: b.env } : {}) },
      );
      return { runId };
    } catch (err) {
      if (err instanceof PlaybackError && err.code === 'DEVICE_BUSY') return reply.code(409).send({ error: err.message, code: err.code });
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
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

  // ── batch regression run (A2): play every template matching the filter,
  // sequentially — one device at a time, wedged run can't wedge the batch ──
  app.post('/api/templates/play-all', async (req, reply) => {
    const b = (req.body ?? {}) as { tags?: string; app?: string; udid?: string; triggeredBy?: string; scenarioId?: string; env?: Record<string, string> };
    const { selectTemplates } = await import('./templates.ts');
    const rows = db.prepare('SELECT * FROM templates ORDER BY updated_at DESC').all() as Array<{ id: string; app_bundle_id: string | null; tags_json: string | null }>;
    const sel = selectTemplates(rows as never, { tags: b.tags, app: b.app });
    if (sel.length === 0) return reply.code(400).send({ error: 'no templates match' });
    const runIds: string[] = [];
    for (const t of sel) {
      let started: { runId: string; done: Promise<void> };
      try {
        started = await runTemplatePlayback(
          { db, bus: deps.bus, dispatchDeps: deps.dispatchDeps, artifactsDir: deps.artifactsDir, forgeState: deps.forgeState },
          t.id,
          { ...(b.udid !== undefined ? { udid: b.udid } : {}), ...(b.triggeredBy !== undefined ? { triggeredBy: b.triggeredBy } : {}), ...(b.scenarioId !== undefined ? { scenarioId: b.scenarioId } : {}), ...(b.env !== undefined ? { env: b.env } : {}) },
        );
      } catch (err) {
        // B5: device freed mid-batch (manual session started, or a prior run
        // wedged past the 5-min cap) — abort the REST of the batch, report what ran
        if (err instanceof PlaybackError && err.code === 'DEVICE_BUSY') {
          return reply.code(409).send({ error: `batch aborted at template ${t.id}: device busy`, code: 'DEVICE_BUSY', runIds });
        }
        throw err;
      }
      const { runId, done } = started;
      runIds.push(runId);
      // cap: a hung dispatch leaves the run running forever (B2, deferred) —
      // this race keeps the BATCH moving; the wedged run itself stays wedged
      await Promise.race([done, new Promise<void>((res) => setTimeout(res, 5 * 60_000))]);
    }
    return { runIds, count: sel.length };
  });
}
