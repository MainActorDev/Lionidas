/** Monitoring (Guvnor): MetricKit payload feed + on-demand extraction.
 *  Apps never push — this route is the server-internal door for the extraction
 *  pipeline (simctl/devicectl pull → ingest) and the feed the dashboard reads. */
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { requirePinOrAgent } from '../auth/gate.ts';
import { ingestPayload, type IngestEnvelope } from '../diagnostics/ingest.ts';
import { extractFromDevice, listGuvnorDevices } from '../diagnostics/extract.ts';

export function registerMonitoringRoutes(app: FastifyInstance, db: Database.Database): void {
  // ingest — internal/pipeline surface (agent token). 8MB: Fastify default 1MB
  // would 413 on chunky daily-metric payloads.
  app.post('/api/diagnostics/payloads', { preHandler: requirePinOrAgent(), bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    const b = req.body as IngestEnvelope | IngestEnvelope[] | null;
    const envelopes: IngestEnvelope[] = Array.isArray(b) ? b : b ? [b] : [];
    if (envelopes.length === 0) return reply.code(400).send({ error: 'envelope(s) required' });
    if (envelopes.length > 100) return reply.code(400).send({ error: 'max 100 payloads per batch' });
    const results = envelopes.map((e) => ingestPayload(db, e));
    const inserted = results.filter((r) => r.ok && !r.skipped).length;
    const dupes = results.filter((r) => r.skipped === 'duplicate').length;
    const firstErr = results.find((r) => !r.ok);
    if (firstErr) return reply.code(422).send({ error: firstErr.error });
    return reply.send({ ok: true, inserted, dupes, ids: results.map((r) => r.id) });
  });

  // feed — dashboard list view (summary_json only; raw JSON on demand)
  app.get('/api/diagnostics/payloads', async (req) => {
    const q = req.query as { appId?: string; kind?: string; since?: string; limit?: string; includeRaw?: string };
    const limit = Math.min(parseInt(q.limit ?? '100', 10) || 100, 500);
    const conds: string[] = [];
    const args: unknown[] = [];
    if (q.appId) { conds.push('app_id = ?'); args.push(q.appId); }
    if (q.kind === 'metric' || q.kind === 'diagnostic') { conds.push('kind = ?'); args.push(q.kind); }
    if (q.since && !Number.isNaN(Number(q.since))) { conds.push('received_at >= ?'); args.push(Number(q.since)); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const rows = db
      .prepare(`SELECT id, app_id, app_version, device_id, device_model, os_version, kind, received_at, captured_at, source, summary_json
                ${q.includeRaw === '1' ? ', payload_json' : ''}
                FROM mx_payloads ${where} ORDER BY received_at DESC LIMIT ?`)
      .all(...args, limit) as Record<string, unknown>[];
    // summaries as objects for the UI
    for (const r of rows) {
      try { r['summary'] = r['summary_json'] ? JSON.parse(r['summary_json'] as string) : {}; } catch { r['summary'] = {}; }
      delete r['summary_json'];
    }
    const counts = db
      .prepare(`SELECT kind, COUNT(*) as n FROM mx_payloads ${where} GROUP BY kind`)
      .all(...args) as Array<{ kind: string; n: number }>;
    return { payloads: rows, counts };
  });

  // single payload incl. raw JSON (drawer's "show raw")
  app.get('/api/diagnostics/payloads/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = db.prepare('SELECT * FROM mx_payloads WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return reply.code(404).send({ error: 'not found' });
    try { row['summary'] = row['summary_json'] ? JSON.parse(row['summary_json'] as string) : {}; } catch { row['summary'] = {}; }
    return row;
  });

  // devices visible to extraction (sims + physical, with Guvnor payload counts where known)
  app.get('/api/diagnostics/devices', async () => listGuvnorDevices());

  // extraction: pull Guvnor payload files out of a device's app container → ingest
  app.post('/api/diagnostics/extract', { preHandler: requirePinOrAgent() }, async (req, reply) => {
    const b = req.body as { udid?: string; appId?: string } | null;
    if (!b?.udid || !b?.appId) return reply.code(400).send({ error: 'udid and appId required' });
    try {
      const r = await extractFromDevice(b.udid, b.appId);
      const results = r.files.map((f) => ingestPayload(db, f.envelope));
      return {
        ok: true,
        container: r.container,
        files: r.files.map((f, i) => ({ file: f.name, kind: f.envelope.payloadKind, result: results[i] })),
        inserted: results.filter((x) => x.ok && !x.skipped).length,
        dupes: results.filter((x) => x.skipped === 'duplicate').length,
      };
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : 'extraction failed' });
    }
  });
}
