/** POST /api/devices/:udid/stream — the wrapped device surface is the only engine. */
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { migrateM1 } from '../src/db/schema.ts';
import { registerDeviceRoutes } from '../src/routes/devices.ts';
import { __setSimdeckEnsureForTest } from '../src/simdeck/supervisor.ts';

function appWithDevices(udid: string): FastifyInstance {
  const db = new Database(':memory:');
  migrateM1(db);
  db.prepare('INSERT INTO devices(udid, name, state, last_seen) VALUES (?, ?, ?, ?)').run(udid, 'Sim', 'Booted', Date.now());
  const app = Fastify();
  app.decorate('db', db);
  registerDeviceRoutes(app, db);
  return app;
}

describe('POST /api/devices/:udid/stream (simdeck only)', () => {
  afterEach(() => {
    __setSimdeckEnsureForTest(null);
  });

  it('resolves a simdeckUrl when the surface is healthy (booted sim)', async () => {
    __setSimdeckEnsureForTest(() => Promise.resolve(8422));
    const app = appWithDevices('S2');
    const res = await app.inject({ method: 'POST', url: '/api/devices/S2/stream', payload: {} });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { simdeckUrl?: string };
    expect(body.simdeckUrl).toBe('/simdeck/simulators/S2');
    await app.close();
  });

  it('503 (retryable) when the surface never becomes healthy', async () => {
    __setSimdeckEnsureForTest(() => Promise.reject(new Error('simdeck did not become healthy in 15s')));
    const app = appWithDevices('S2');
    const res = await app.inject({ method: 'POST', url: '/api/devices/S2/stream', payload: {} });
    expect(res.statusCode).toBe(503);
    const body = res.json() as { retryable?: boolean; error?: string };
    expect(body.retryable).toBe(true);
    await app.close();
  });

  it('503 (permanent) when the binary is missing', async () => {
    __setSimdeckEnsureForTest(() => Promise.reject(new Error('simdeck binary not found: /x/y (build the sibling project)')));
    const app = appWithDevices('S2');
    const res = await app.inject({ method: 'POST', url: '/api/devices/S2/stream', payload: {} });
    expect(res.statusCode).toBe(503);
    const body = res.json() as { retryable?: boolean };
    expect(body.retryable).toBe(false);
    await app.close();
  });
});
