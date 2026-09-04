/** Manual cockpit routes (lease-held, never rolls up). */
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { TypedEventBus, AppEvents } from '../ws/bus.ts';
import { createReadStream, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { startManualSession, manualTap, manualScroll, manualType, manualSnapshot, manualProbeSelector, finishManualSession, setRecording, getRecording, deleteRecordedStep, recordExpectStep, ManualSessionError } from '../manual/session.ts';
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

  app.post('/api/manual/:id/record/expect', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as { selector?: { identifier?: string; label?: string; type?: string } } | null;
    if (!b?.selector || (!b.selector.label && !b.selector.identifier)) return reply.code(400).send({ error: 'selector with label or identifier required' });
    try {
      return recordExpectStep({ db, bus: deps.bus, dispatchDeps: deps.dispatchDeps }, id, b.selector);
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
    const b = req.body as { udid?: string; triggeredBy?: string; scenarioId?: string; env?: Record<string, string> } | null;
    try {
      const { runId, udid } = await runTemplatePlayback(
        { db, bus: deps.bus, dispatchDeps: deps.dispatchDeps, artifactsDir: deps.artifactsDir, forgeState: deps.forgeState },
        id,
        { ...(b?.udid !== undefined ? { udid: b.udid } : {}), ...(b?.triggeredBy !== undefined ? { triggeredBy: b.triggeredBy } : {}), ...(b?.scenarioId !== undefined ? { scenarioId: b.scenarioId } : {}), ...(b?.env !== undefined ? { env: b.env } : {}) },
      );
      return { runId, udid };
    } catch (err) {
      if (err instanceof PlaybackError && err.code === 'DEVICE_BUSY') return reply.code(409).send({ error: err.message, code: err.code });
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

  // ── batch regression run (A2): play every template matching the filter,
  // sequentially — one device at a time. Shared by play-all AND plans (one
  // engine, no parallel mechanism). ──
  async function runBatch(b: { tags?: string; app?: string; udid?: string; triggeredBy?: string; scenarioId?: string; env?: Record<string, string> }):
    Promise<{ ok: true; runIds: string[]; count: number } | { ok: false; code: 400 | 409; error: string; runIds: string[]; appBundleId?: string; booted?: Array<{ udid: string; name: string | null }>; lastArtifact?: { path: string; version: string | null; recordedAt: number } | null }> {
    const { selectTemplates } = await import('./templates.ts');
    const rows = db.prepare('SELECT * FROM templates ORDER BY updated_at DESC').all() as Array<{ id: string; app_bundle_id: string | null; tags_json: string | null }>;
    const sel = selectTemplates(rows as never, { tags: b.tags, app: b.app });
    if (sel.length === 0) return { ok: false, code: 400, error: 'no templates match', runIds: [] };
    const runIds: string[] = [];
    for (const t of sel) {
      let started: { runId: string; udid: string; done: Promise<void> };
      try {
        started = await runTemplatePlayback(
          { db, bus: deps.bus, dispatchDeps: deps.dispatchDeps, artifactsDir: deps.artifactsDir, forgeState: deps.forgeState },
          t.id,
          { ...(b.udid !== undefined ? { udid: b.udid } : {}), ...(b.triggeredBy !== undefined ? { triggeredBy: b.triggeredBy } : {}), ...(b.scenarioId !== undefined ? { scenarioId: b.scenarioId } : {}), ...(b.env !== undefined ? { env: b.env } : {}) },
        );
      } catch (err) {
        // B5: device freed mid-batch — abort the REST, report what ran
        if (err instanceof PlaybackError && err.code === 'DEVICE_BUSY') {
          return { ok: false, code: 409, error: `batch aborted at template ${t.id}: device busy`, runIds };
        }
        if (err instanceof PlaybackError && err.code === 'APP_NOT_INSTALLED') {
          const out: { ok: false; code: 409; error: string; runIds: string[]; appBundleId?: string; lastArtifact?: { path: string; version: string | null; recordedAt: number } | null } =
            { ok: false, code: 409, error: `batch aborted at template ${t.id}: ${err.message}`, runIds };
          if (err.payload?.appBundleId !== undefined) out.appBundleId = err.payload.appBundleId;
          if (err.payload?.lastArtifact !== undefined) out.lastArtifact = err.payload.lastArtifact;
          return out;
        }
        if (err instanceof PlaybackError && err.code === 'DEVICE_AMBIGUOUS') {
          return { ok: false, code: 409, error: `batch aborted at template ${t.id}: ${err.message}`, runIds, booted: err.payload?.booted ?? [] };
        }
        throw err;
      }
      const { runId, done } = started;
      runIds.push(runId);
      // B2 watchdog now bounds each run; the batch cap remains a belt-and-braces
      await Promise.race([done, new Promise<void>((res) => setTimeout(res, 5 * 60_000))]);
    }
    return { ok: true, runIds, count: sel.length };
  }

  app.post('/api/templates/play-all', async (req, reply) => {
    const b = (req.body ?? {}) as { tags?: string; app?: string; udid?: string; triggeredBy?: string; scenarioId?: string; env?: Record<string, string> };
    const r = await runBatch(b);
    if (!r.ok) return reply.code(r.code).send({ error: r.error, code: r.code === 409 ? 'DEVICE_BUSY' : undefined, runIds: r.runIds });
    return { runIds: r.runIds, count: r.count };
  });

  // ── plans (B4): remembered suite invocations — tag filter + device + app +
  // scenario + env, replayed through runBatch. CRUD lives with templates —
  // a plan IS a saved templates-page state, not a separate world. ──
  const planRow = (r: { id: string; name: string; tags_json: string; udid: string | null; app_bundle_id: string | null; scenario_id: string | null; env_json: string; created_by: string; created_at: number; updated_at: number }) => ({
    id: r.id, name: r.name, tags: JSON.parse(r.tags_json) as string[], udid: r.udid, appBundleId: r.app_bundle_id, scenarioId: r.scenario_id, env: JSON.parse(r.env_json) as Record<string, string>, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
  });
  const normalizeTags = (raw: unknown): string[] => [...new Set((Array.isArray(raw) ? raw : []).map((t) => String(t).trim()).filter(Boolean))].slice(0, 8);

  app.get('/api/plans', async () => {
    const rows = db.prepare('SELECT * FROM plans ORDER BY updated_at DESC').all() as never[];
    return { plans: rows.map(planRow) };
  });

  app.post('/api/plans', async (req, reply) => {
    const b = (req.body ?? {}) as { name?: string; tags?: string[]; udid?: string; appBundleId?: string; scenarioId?: string; env?: Record<string, string>; createdBy?: string };
    if (!b.name?.trim()) return reply.code(400).send({ error: 'name required' });
    const id = `plan_${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    try {
      db.prepare(`INSERT INTO plans(id, name, tags_json, udid, app_bundle_id, scenario_id, env_json, created_by, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, b.name.trim(), JSON.stringify(normalizeTags(b.tags)), b.udid ?? null, b.appBundleId ?? null, b.scenarioId ?? null, JSON.stringify(b.env ?? {}), b.createdBy ?? 'qa', now, now);
    } catch { return reply.code(409).send({ error: 'plan name already exists' }); }
    return planRow(db.prepare('SELECT * FROM plans WHERE id = ?').get(id) as never);
  });

  app.patch('/api/plans/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { name?: string; tags?: string[]; udid?: string | null; appBundleId?: string | null; scenarioId?: string | null; env?: Record<string, string> };
    const row = db.prepare('SELECT * FROM plans WHERE id = ?').get(id) as { id: string } | undefined;
    if (!row) return reply.code(404).send({ error: 'not found' });
    if (b.name !== undefined && !b.name.trim()) return reply.code(400).send({ error: 'name cannot be empty' });
    const prev = db.prepare('SELECT * FROM plans WHERE id = ?').get(id) as { name: string; tags_json: string; udid: string | null; app_bundle_id: string | null; scenario_id: string | null; env_json: string };
    db.prepare(`UPDATE plans SET name = ?, tags_json = ?, udid = ?, app_bundle_id = ?, scenario_id = ?, env_json = ?, updated_at = ? WHERE id = ?`)
      .run(
        b.name !== undefined ? b.name.trim() : prev.name,
        b.tags !== undefined ? JSON.stringify(normalizeTags(b.tags)) : prev.tags_json,
        b.udid !== undefined ? b.udid : prev.udid,
        b.appBundleId !== undefined ? b.appBundleId : prev.app_bundle_id,
        b.scenarioId !== undefined ? b.scenarioId : prev.scenario_id,
        b.env !== undefined ? JSON.stringify(b.env) : prev.env_json,
        Date.now(), id,
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
    const row = db.prepare('SELECT * FROM plans WHERE id = ?').get(id) as { tags_json: string; udid: string | null; app_bundle_id: string | null; scenario_id: string | null; env_json: string } | undefined;
    if (!row) return reply.code(404).send({ error: 'not found' });
    const p = planRow({ ...row, id, name: '', created_by: 'qa', created_at: 0, updated_at: 0 });
    const r = await runBatch({
      tags: (p.tags as string[]).join(','),
      ...(p.appBundleId !== null ? { app: p.appBundleId } : {}),
      ...(p.udid !== null ? { udid: p.udid } : {}),
      ...(p.scenarioId !== null ? { scenarioId: p.scenarioId } : {}),
      env: p.env,
      triggeredBy: `plan:${p.name || id}`,
    });
    if (!r.ok) return reply.code(r.code).send({ error: r.error, code: r.code === 409 ? 'DEVICE_BUSY' : undefined, runIds: r.runIds });
    return { runIds: r.runIds, count: r.count };
  });
}
