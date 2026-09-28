import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { migrateM1 } from '../src/db/schema.ts';
import { registerForgeRoutes } from '../src/forge/routes.ts';
import { NETWORK_PROFILES, NETWORK_PROFILE_IDS, isNetworkProfile } from '../../shared/src/network-profiles.ts';
import { baguetteNetwork, resolveBaguettePath, type BaguetteRunner } from '../src/forge/baguette-network.ts';

/** Plan 20260928T153608Z rev 2 — network conditioner: preset vocab pinned,
 *  shim argv contracts, exit-code-is-contract semantics, route surface. */

let db: Database.Database;
let app: FastifyInstance;

beforeEach(async () => {
  db = new Database(':memory:');
  migrateM1(db);
  app = Fastify();
  app.addHook('onRequest', async (req) => { (req as unknown as { user: unknown }).user = { name: 'qa', role: 'operator' }; });
  registerForgeRoutes(app, db, {} as never);
  await app.ready();
});
afterEach(async () => { await app.close(); db.close(); });

describe('network profile vocabulary', () => {
  it('pins the seven Baguette presets verbatim (figures from Baguette\'s NetworkProfileTests doc table)', () => {
    expect(NETWORK_PROFILES.map((p) => [p.id, p.bandwidthKbps, p.latencyMs, p.lossPct])).toEqual([
      ['wifi', 40_000, 2, 0],
      ['dsl', 2_000, 10, 0],
      ['lte', 50_000, 130, 0],
      ['3g', 780, 200, 0],
      ['edge', 240, 800, 0],
      ['very-bad-network', 1_000, 1_000, 10],
      ['100-loss', null, null, 100],
    ]);
    expect(NETWORK_PROFILE_IDS).toHaveLength(7);
    expect(isNetworkProfile('3g')).toBe(true);
    expect(isNetworkProfile('turbo')).toBe(false);
  });
});

describe('baguette shim', () => {
  it('set/clear/status argv contracts (fake runner asserts exact args)', async () => {
    const calls: Array<{ bin: string; args: string[] }> = [];
    const runner: BaguetteRunner = async (bin, args) => { calls.push({ bin, args }); return { stdout: '', stderr: '' }; };
    await baguetteNetwork('U-1', { kind: 'set', profile: '3g' }, runner);
    await baguetteNetwork('U-1', { kind: 'clear' }, runner);
    await baguetteNetwork('U-1', { kind: 'status' }, runner);
    expect(calls.map((c) => c.args)).toEqual([
      ['network', 'set', '--udid', 'U-1', '--profile', '3g'],
      ['network', 'clear', '--udid', 'U-1'],
      ['network', 'status', '--udid', 'U-1'],
    ]);
    expect(calls.every((c) => c.bin === resolveBaguettePath() || c.bin.length > 0)).toBe(true);
  });

  it('unknown profile is refused BEFORE any process spawn', async () => {
    let spawned = false;
    const runner: BaguetteRunner = async () => { spawned = true; return { stdout: '', stderr: '' }; };
    const r = await baguetteNetwork('U-1', { kind: 'set', profile: 'nope' }, runner);
    expect(r).toMatchObject({ ok: false, reason: 'bad-profile' });
    expect(spawned).toBe(false);
  });

  it('status parses the two documented prose shapes; unknown prose degrades to raw, never an error (F4)', async () => {
    const off: BaguetteRunner = async () => ({ stdout: '[baguette] iPhone 14 Plus: no network conditioning applied.', stderr: '' });
    expect(await baguetteNetwork('U', { kind: 'status' }, off)).toMatchObject({ ok: true, conditioned: 'no' });
    const on: BaguetteRunner = async () => ({ stdout: '[baguette] iPhone 14 Plus network: 200 ms latency, 780 kbps', stderr: '' });
    expect(await baguetteNetwork('U', { kind: 'status' }, on)).toMatchObject({ ok: true, conditioned: 'yes', raw: '200 ms latency, 780 kbps' });
    const weird: BaguetteRunner = async () => ({ stdout: 'something changed in a future baguette', stderr: '' });
    expect(await baguetteNetwork('U', { kind: 'status' }, weird)).toMatchObject({ ok: true, conditioned: 'unknown', raw: 'something changed in a future baguette' });
  });

  it('cli failure maps to a typed result, not a throw', async () => {
    const boom: BaguetteRunner = async () => { throw new Error('exit 1'); };
    expect(await baguetteNetwork('U', { kind: 'set', profile: '3g' }, boom)).toMatchObject({ ok: false, reason: 'cli-error' });
  });
});

describe('condition routes', () => {
  it('GET status returns available:false when the binary is absent (UI grays out, no error)', async () => {
    const { __setBaguettePathForTest } = await import('../src/forge/baguette-network.ts');
    __setBaguettePathForTest(null);
    try {
      const r = await app.inject({ method: 'GET', url: '/api/forge/network-condition?udid=U-1' });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ available: false });
    } finally {
      __setBaguettePathForTest(undefined);
    }
  });

  it('POST clear with absent binary → 409 with the fix, never a crash', async () => {
    const { __setBaguettePathForTest } = await import('../src/forge/baguette-network.ts');
    __setBaguettePathForTest(null);
    try {
      const r = await app.inject({ method: 'POST', url: '/api/forge/network-condition', payload: { udid: 'U-1', profile: null } });
      expect(r.statusCode).toBe(409);
      expect((r.json() as { error: string }).error).toContain('BAGUETTE_PATH');
    } finally {
      __setBaguettePathForTest(undefined);
    }
  });

  it('POST rejects unknown profiles with 400 (checked against the shared vocab)', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/forge/network-condition', payload: { udid: 'U-1', profile: 'flying-carrier' } });
    expect(r.statusCode).toBe(400);
  });
});
