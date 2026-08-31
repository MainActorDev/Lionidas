/** QA test templates: recorded manual flows stored as replayable configs.
 *  CRUD + save-from-session (copies recording steps out of a manual session).
 *  Templates are plain data — playback (2d) interprets steps_json against a device. */
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

interface TemplateRow {
  id: string;
  name: string;
  description: string | null;
  ticket_key: string | null;
  udid: string;
  logical_w: number | null;
  logical_h: number | null;
  steps_json: string;
  default_preset_id: string | null;
  app_bundle_id: string | null;
  app_name: string | null;
  app_version: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}

function rowToTemplate(r: TemplateRow): Record<string, unknown> {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    ticketKey: r.ticket_key,
    udid: r.udid,
    logicalW: r.logical_w,
    logicalH: r.logical_h,
    steps: JSON.parse(r.steps_json) as unknown[],
    defaultPresetId: r.default_preset_id,
    appBundleId: r.app_bundle_id,
    appName: r.app_name,
    appVersion: r.app_version,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function registerTemplateRoutes(app: FastifyInstance, db: Database.Database): void {
  app.get('/api/templates', async (req) => {
    const q = req.query as { ticket?: string };
    const rows = q.ticket
      ? (db.prepare('SELECT * FROM templates WHERE ticket_key = ? ORDER BY updated_at DESC').all(q.ticket) as TemplateRow[])
      : (db.prepare('SELECT * FROM templates ORDER BY updated_at DESC').all() as TemplateRow[]);
    return { templates: rows.map(rowToTemplate) };
  });

  app.get('/api/templates/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as TemplateRow | undefined;
    if (!row) return reply.code(404).send({ error: 'not found' });
    return rowToTemplate(row);
  });

  /** Save current recording as a template (sidebar "save as template"). */
  app.post('/api/templates/from-session/:sessionId', async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    const b = req.body as { name?: string; description?: string; ticketKey?: string; createdBy?: string };
    if (!b.name || !b.name.trim()) return reply.code(400).send({ error: 'name required' });
    const sess = db
      .prepare('SELECT s.recording_json, s.udid, s.logical_w, s.logical_h, s.operator FROM manual_sessions s WHERE s.id = ?')
      .get(sessionId) as { recording_json: string | null; udid: string; logical_w: number | null; logical_h: number | null; operator: string } | undefined;
    if (!sess) return reply.code(404).send({ error: 'session not found' });
    let steps: unknown[] = [];
    if (sess.recording_json) {
      try { steps = (JSON.parse(sess.recording_json) as { steps?: unknown[] }).steps ?? []; } catch { /* empty */ }
    }
    if (steps.length === 0) return reply.code(400).send({ error: 'no recorded steps in session' });
    // app binding: the recorded app is captured at save time — foreground
    // non-Apple UIKit app on the session's device (fallback: explicit body)
    let appBundleId = (b as { appBundleId?: string }).appBundleId ?? null;
    let appName: string | null = null;
    let appVersion: string | null = null;
    if (!appBundleId) {
      try {
        const { foregroundApp } = await import('../manual/apps.ts');
        const fg = await foregroundApp(sess.udid);
        if (fg) { appBundleId = fg.bundleId; appName = fg.name; appVersion = fg.version; }
      } catch { /* app binding best-effort — template still saves */ }
    } else {
      try {
        const { listSimulatorApps } = await import('../manual/apps.ts');
        const found = (await listSimulatorApps(sess.udid)).find((a) => a.bundleId === appBundleId);
        if (found) { appName = found.name; appVersion = found.version; }
      } catch { /* enrich best-effort */ }
    }
    const id = `tpl_${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    db.prepare(
      `INSERT INTO templates(id, name, description, ticket_key, udid, logical_w, logical_h, steps_json, app_bundle_id, app_name, app_version, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, b.name.trim(), b.description ?? null, b.ticketKey ?? null, sess.udid, sess.logical_w, sess.logical_h, JSON.stringify(steps), appBundleId, appName, appVersion, b.createdBy ?? sess.operator, now, now);
    const row = db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as TemplateRow;
    return rowToTemplate(row);
  });

  app.post('/api/templates', async (req, reply) => {
    const b = req.body as Partial<TemplateRow> & { steps?: unknown[] };
    if (!b.name || !b.name.trim()) return reply.code(400).send({ error: 'name required' });
    const id = `tpl_${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    db.prepare(
      `INSERT INTO templates(id, name, description, ticket_key, udid, logical_w, logical_h, steps_json, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, b.name.trim(), b.description ?? null, b.ticket_key ?? null, b.udid ?? '', b.logical_w ?? null, b.logical_h ?? null, JSON.stringify(b.steps ?? []), b.created_by ?? 'qa', now, now);
    return rowToTemplate(db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as TemplateRow);
  });

  app.patch('/api/templates/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as { name?: string; description?: string | null; ticketKey?: string | null; defaultPresetId?: string | null; steps?: unknown[] };
    const row = db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as TemplateRow | undefined;
    if (!row) return reply.code(404).send({ error: 'not found' });
    if (b.name !== undefined && !b.name.trim()) return reply.code(400).send({ error: 'name cannot be empty' });
    db.prepare(
      `UPDATE templates SET
         name = ?, description = ?, ticket_key = ?, default_preset_id = ?, steps_json = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      b.name !== undefined ? b.name.trim() : row.name,
      b.description !== undefined ? b.description : row.description,
      b.ticketKey !== undefined ? b.ticketKey : row.ticket_key,
      b.defaultPresetId !== undefined ? b.defaultPresetId : row.default_preset_id,
      b.steps !== undefined ? JSON.stringify(b.steps) : row.steps_json,
      Date.now(),
      id,
    );
    return rowToTemplate(db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as TemplateRow);
  });

  app.delete('/api/templates/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = db.prepare('DELETE FROM templates WHERE id = ?').run(id);
    if (r.changes === 0) return reply.code(404).send({ error: 'not found' });
    return { ok: true };
  });
}
