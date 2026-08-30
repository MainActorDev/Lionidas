import { describe, expect, it, beforeEach } from 'vitest';
import { buildApp } from '../src/index.ts';

let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  app = await buildApp({ ...process.env, CRUCIBLE_DB_PATH: ':memory:', VITEST: 'true' });
});

describe('POST /api/devices/:udid/stream (S1)', () => {
  it('device not in mirror → 409', async () => {
    const res = await app.app.inject({ method: 'POST', url: '/api/devices/NOPE/stream' });
    expect(res.statusCode).toBe(409);
  });
  it('device not booted → 409', async () => {
    app.db.raw.prepare(`INSERT INTO devices(udid,name,state,last_seen) VALUES ('S1','sim','Shutdown',?)`).run(Date.now());
    const res = await app.app.inject({ method: 'POST', url: '/api/devices/S1/stream' });
    expect(res.statusCode).toBe(409);
  });
  it('booted + alloy_stream succeeds → streamUrl passthrough', async () => {
    app.db.raw.prepare(`INSERT INTO devices(udid,name,state,platform,kind,last_seen) VALUES ('S2','sim','Booted','ios','simulator',?)`).run(Date.now());
    const { crucibleAlloy } = await import('../src/alloy/client.ts');
    const alloy = crucibleAlloy() as unknown as Record<string, (...a: unknown[]) => unknown>;
    (alloy['clearRegistryForTests'] as () => void)();
    const rt = (await (await import('../src/alloy/runtime.ts')).initAlloyRuntime()) as unknown as Record<string, unknown>;
    (alloy['registerPhase0Tools'] as (d: unknown) => void)({ state: rt['state'] });
    (alloy['replaceToolHandlerForTests'] as (t2: string, h: () => unknown) => void)('alloy_stream', async () => ({ streamUrl: 'http://127.0.0.1:9999/stream.mjpeg', platform: 'ios' }));
    const res = await app.app.inject({ method: 'POST', url: '/api/devices/S2/stream' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { streamUrl: string; platform: string };
    expect(body.streamUrl).toBe('http://127.0.0.1:9999/stream.mjpeg');
    expect(body.platform).toBe('ios');
  });
  it('engine error → 503 with reason (degraded, not crash)', async () => {
    app.db.raw.prepare(`INSERT INTO devices(udid,name,state,platform,kind,last_seen) VALUES ('S3','sim','Booted','ios','simulator',?)`).run(Date.now());
    const { crucibleAlloy } = await import('../src/alloy/client.ts');
    const alloy = crucibleAlloy() as unknown as Record<string, (...a: unknown[]) => unknown>;
    (alloy['clearRegistryForTests'] as () => void)();
    const rt = (await (await import('../src/alloy/runtime.ts')).initAlloyRuntime()) as unknown as Record<string, unknown>;
    (alloy['registerPhase0Tools'] as (d: unknown) => void)({ state: rt['state'] });
    (alloy['replaceToolHandlerForTests'] as (t2: string, h: () => unknown) => void)('alloy_stream', async () => {
      const e = new Error('no simulator-server') as Error & { code: string };
      e.code = 'COMMAND_FAILED';
      throw e;
    });
    const res = await app.app.inject({ method: 'POST', url: '/api/devices/S3/stream' });
    expect(res.statusCode).toBe(503);
    const body = res.json() as { error?: string; code?: string };
    expect(body.error).toContain('stream unavailable');
  });
});

describe('alloy routing (S1 contract)', () => {
  it('alloy_stream is per-call (watch never holds)', async () => {
    const { crucibleAlloy } = await import('../src/alloy/client.ts');
    const alloy = crucibleAlloy() as unknown as { routingTable: Array<{ tool: string; lease: string }> };
    const { routingTable } = alloy;
    const row = routingTable.find((r) => r.tool === 'alloy_stream');
    expect(row?.lease).toBe('per-call');
    expect(row).toBeDefined();
  });
});
