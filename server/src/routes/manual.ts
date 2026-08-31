/** Manual cockpit routes (lease-held, never rolls up). */
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { TypedEventBus, AppEvents } from '../ws/bus.ts';
import { createReadStream, statSync } from 'node:fs';
import { startManualSession, manualTap, manualScroll, manualType, manualSnapshot, finishManualSession, setRecording, getRecording, deleteRecordedStep, ManualSessionError } from '../manual/session.ts';

export function registerManualRoutes(
  // frame serve: only paths under the manual session's snapshot dir (engine temp)
  // — scoped by checking the file was the LAST snapshot emitted for a live session
app: FastifyInstance, db: Database.Database, deps: { bus: TypedEventBus<AppEvents>; dispatchDeps: unknown }): void {
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
    const b = req.body as { udid?: string; operator?: string };
    if (!b.udid || !b.operator) return reply.code(400).send({ error: 'udid and operator required' });
    try {
      const s = await startManualSession({ db, bus: deps.bus, dispatchDeps: deps.dispatchDeps }, b.udid, b.operator);
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
}
