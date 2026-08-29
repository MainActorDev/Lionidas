/** Forge modes: live socket tests against a real proxy instance (no device). */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateM1 } from '../src/db/schema.ts';
import { createEventBus, type AppEvents } from '../src/ws/bus.ts';
import { startForgeProxy, createForgeState } from '../src/forge/proxy.ts';
import { resetSeqForTests, type Preset } from '../src/forge/matcher.ts';

const db = new Database(':memory:');
migrateM1(db);
const artifacts = mkdtempSync(join(tmpdir(), 'forge-'));
const bus = createEventBus<AppEvents>();
let hits = 0;
bus.on('forge.traffic.hit', () => hits++);
const state = createForgeState();
let proxy: { port: number; close: () => Promise<void> };
let upstream: { port: number; close: () => Promise<void> };
const upstreamState = createForgeState();

beforeAll(async () => {
  proxy = await startForgeProxy({ db, bus, artifactsDir: artifacts }, state);
  upstream = await startForgeProxy({ db, bus: createEventBus<AppEvents>(), artifactsDir: artifacts }, upstreamState);
});
afterAll(async () => {
  await proxy.close();
  await upstream.close();
  rmSync(artifacts, { recursive: true, force: true });
  resetSeqForTests();
});

const P = (over: Partial<Preset>): Preset => ({
  id: 'p1', method: 'GET', pathPattern: '/api/x', match: 'exact', status: 200, ...over,
});

describe('forge proxy modes', () => {
  it('intercept: matched preset served; unmatched → 501 + logged', async () => {
    state.mode = 'intercept';
    state.presets = [P({ status: 201, delayMs: 0 })];
    const hit = await fetch(`http://127.0.0.1:${proxy.port}/api/x`);
    expect(hit.status).toBe(201);
    const miss = await fetch(`http://127.0.0.1:${proxy.port}/nope`);
    expect(miss.status).toBe(501);
    expect(hits).toBeGreaterThanOrEqual(2);
    const rows = db.prepare('SELECT * FROM traffic WHERE path IN (?,?) ORDER BY ts').all('/api/x', '/nope') as Array<{ path: string; status: number; matched_preset_id: string | null }>;
    expect(rows[0]).toMatchObject({ path: '/api/x', status: 201, matched_preset_id: 'p1' });
    expect(rows[1]).toMatchObject({ path: '/nope', status: 501, matched_preset_id: null });
  });

  it('hybrid: matched served from preset, unmatched forwarded to the (intercept) upstream', async () => {
    upstreamState.mode = 'intercept';
    state.mode = 'hybrid';
    state.presets = [P({ status: 222 })];
    const hit = await fetch(`http://127.0.0.1:${proxy.port}/api/x`);
    expect(hit.status).toBe(222); // overridden
    const fwd = await fetch(`http://127.0.0.1:${proxy.port}/real`, {
      headers: { 'x-forge-upstream': `http://127.0.0.1:${upstream.port}` },
    });
    expect(fwd.status).toBe(501); // upstream (intercept, no presets) replies 501 — proves forwarding
  });

  it('sequence preset: 200 then 500 then last repeats', async () => {
    state.mode = 'intercept';
    state.presets = [P({ seq: [{ status: 200 }, { status: 500 }] })];
    const s1 = await fetch(`http://127.0.0.1:${proxy.port}/api/x`);
    const s2 = await fetch(`http://127.0.0.1:${proxy.port}/api/x`);
    const s3 = await fetch(`http://127.0.0.1:${proxy.port}/api/x`);
    expect([s1.status, s2.status, s3.status]).toEqual([200, 500, 500]);
  });

  it('failure malformed: body is not JSON', async () => {
    state.mode = 'intercept';
    state.presets = [P({ failure: 'malformed', status: 200 })];
    const r = await fetch(`http://127.0.0.1:${proxy.port}/api/x`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('{not-json');
  });

  it('record mode ignores presets (pass-through only)', async () => {
    state.mode = 'record';
    state.presets = [P({ status: 201 })];
    const r = await fetch(`http://127.0.0.1:${proxy.port}/api/x`, {
      headers: { 'x-forge-upstream': 'http://127.0.0.1:1' }, // unroutable → 502 proves no preset served
    });
    expect(r.status).toBe(502);
  });
});
