import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/index.ts';

describe('GET /api/health', () => {
  it('returns ok with version and uptime', async () => {
    const a = await buildApp({ ...process.env, CRUCIBLE_DB_PATH: ':memory:', VITEST: 'true' });
    try {
      const res = await a.app.inject({ method: 'GET', url: '/api/health' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { ok: boolean; version: string; uptimeMs: number };
      expect(body.ok).toBe(true);
      expect(typeof body.version).toBe('string');
      expect(body.uptimeMs).toBeGreaterThanOrEqual(0);
    } finally {
      await a.close();
    }
  });
});
