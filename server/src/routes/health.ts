import type { FastifyInstance } from 'fastify';

export const VERSION = '0.1.0';
const startedAt = Date.now();

export function registerHealthRoute(app: FastifyInstance): void {
  app.get('/api/health', async () => ({
    ok: true,
    version: VERSION,
    uptimeMs: Date.now() - startedAt,
  }));
}
