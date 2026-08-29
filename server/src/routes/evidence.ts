import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { createReadStream, statSync } from 'node:fs';
import type { ReadableOptions } from 'node:stream';

export function registerEvidenceRoute(app: FastifyInstance, db: Database.Database): void {
  app.get('/api/evidence/:id/file', async (req, reply) => {
    const { id } = req.params as { id: string };
    const ev = db.prepare('SELECT path, type, bytes FROM evidence WHERE id = ?').get(id) as
      | { path: string; type: string; bytes: number }
      | undefined;
    if (!ev) return reply.code(404).send({ error: 'evidence not found' });

    const range = req.headers.range;
    try {
      if (range) {
        const m = /bytes=(\d+)-(\d*)/.exec(range);
        if (m) {
          const start = Number.parseInt(m[1]!, 10);
          const end = m[2] ? Number.parseInt(m[2], 10) : Math.min(start + 1024 * 1024, ev.bytes - 1);
          reply.code(206);
          reply.header('content-range', `bytes ${start}-${end}/${ev.bytes}`);
          reply.header('accept-ranges', 'bytes');
          reply.header('content-length', String(end - start + 1));
          reply.header('content-type', ev.type === 'video' ? 'video/mp4' : 'application/octet-stream');
          const stream = createReadStream(ev.path, { start, end } as ReadableOptions);
          return reply.send(stream);
        }
      }
      const st = statSync(ev.path);
      reply.header('content-length', String(st.size));
      reply.header('accept-ranges', 'bytes');
      reply.header('content-type', ev.type === 'video' ? 'video/mp4' : 'application/octet-stream');
      return reply.send(createReadStream(ev.path));
    } catch {
      return reply.code(410).send({ error: 'evidence file missing on disk' });
    }
  });
}
