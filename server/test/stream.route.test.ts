import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { migrateM1 } from '../src/db/schema.ts';
import { registerDeviceRoutes } from '../src/routes/devices.ts';
import { __setScreenstreamEnsureForTest, screenstreamUrl } from '../src/stream/screenstream.ts';

let db: Database.Database;
let app: FastifyInstance;

beforeEach(async () => {
  db = new Database(':memory:');
  migrateM1(db);
  app = Fastify();
  registerDeviceRoutes(app, db);
  await app.ready();
});

describe('POST /api/devices/:udid/stream (S1 — crucible-screenstream only)', () => {
  it('device not in mirror → 409', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/devices/NOPE/stream' });
    expect(res.statusCode).toBe(409);
  });

  it('device not booted → 409', async () => {
    db.prepare(`INSERT INTO devices(udid,name,state,last_seen) VALUES ('S1','sim','Shutdown',?)`).run(Date.now());
    const res = await app.inject({ method: 'POST', url: '/api/devices/S1/stream' });
    expect(res.statusCode).toBe(409);
  });

  it('physical device → 422 SIM_ONLY (no framebuffer source)', async () => {
    db.prepare(`INSERT INTO devices(udid,name,state,platform,kind,last_seen) VALUES ('S1P','phone','Booted','ios','physical',?)`).run(Date.now());
    const res = await app.inject({ method: 'POST', url: '/api/devices/S1P/stream' });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code?: string }).code).toBe('SIM_ONLY');
  });

  it('booted sim + engine healthy → engine WS URL, avcc format', async () => {
    db.prepare(`INSERT INTO devices(udid,name,state,platform,kind,last_seen) VALUES ('S2','sim','Booted','ios','simulator',?)`).run(Date.now());
    __setScreenstreamEnsureForTest(async () => 8440);
    try {
      const res = await app.inject({ method: 'POST', url: '/api/devices/S2/stream' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { streamUrl: string; format: string };
      expect(body.streamUrl).toBe(screenstreamUrl('S2'));
      expect(body.format).toBe('avcc');
    } finally {
      __setScreenstreamEnsureForTest(null);
    }
  });

  it('engine spawn failure → 503 retryable (no fallback)', async () => {
    db.prepare(`INSERT INTO devices(udid,name,state,platform,kind,last_seen) VALUES ('S3','sim','Booted','ios','simulator',?)`).run(Date.now());
    __setScreenstreamEnsureForTest(() => Promise.reject(new Error('crucible-screenstream did not become healthy in 15s')));
    try {
      const res = await app.inject({ method: 'POST', url: '/api/devices/S3/stream' });
      expect(res.statusCode).toBe(503);
      const body = res.json() as { error?: string; retryable?: boolean };
      expect(body.error).toContain('stream unavailable');
      expect(body.retryable).toBe(true); // health timeout is transient by construction
    } finally {
      __setScreenstreamEnsureForTest(null);
    }
  });

  it('binary missing → 503 NOT retryable (permanent class)', async () => {
    db.prepare(`INSERT INTO devices(udid,name,state,platform,kind,last_seen) VALUES ('S4','sim','Booted','ios','simulator',?)`).run(Date.now());
    __setScreenstreamEnsureForTest(() => Promise.reject(new Error('crucible-screenstream binary not found: /x/y (build it: cd native/screenstream && swift build -c release)')));
    try {
      const res = await app.inject({ method: 'POST', url: '/api/devices/S4/stream' });
      expect(res.statusCode).toBe(503);
      expect((res.json() as { retryable?: boolean }).retryable).toBe(false);
    } finally {
      __setScreenstreamEnsureForTest(null);
    }
  });
});
