import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrateM1 } from '../src/db/schema.ts';
import { pollDevices, type SimctlBootProbe } from '../src/poll/devices.ts';
import { __setAlloyForTest, type AlloyExports } from '../src/alloy/client.ts';

let db: Database.Database;
let tmp: string;
let probeCalls: number;
let stubProbe: SimctlBootProbe;

const U = 'SIM-GUARD-1';

function fakeAlloy(booted: boolean): AlloyExports {
  return {
    createRuntime: async () => ({ state: {}, deps: null }),
    dispatch: async (tool: string) => {
      if (tool === 'alloy_health') return { ok: true, result: { leases: [] } };
      if (tool === 'alloy_devices') return { ok: true, result: [{ id: U, name: 'Guard Sim', booted, platform: 'ios', kind: 'simulator' }] };
      return { ok: true, result: {} };
    },
  } as unknown as AlloyExports;
}

function mirrorState(): string | null {
  const row = db.prepare('SELECT state FROM devices WHERE udid = ?').get(U) as { state: string | null } | undefined;
  return row?.state ?? null;
}

beforeEach(() => {
  db = new Database(':memory:');
  migrateM1(db);
  tmp = mkdtempSync(join(tmpdir(), 'poller-guard-'));
  probeCalls = 0;
  stubProbe = () => { probeCalls += 1; return new Map([[U, true]]); };
});
afterEach(() => {
  __setAlloyForTest(null);
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('poller Booted→Shutdown ground-truth guard', () => {
  it('engine says shutdown + simctl says Booted → row STAYS Booted (lease still updates)', async () => {
    db.prepare(`INSERT INTO devices(udid, name, state, platform, kind, last_seen) VALUES (?, 'Old', 'Booted', 'ios', 'simulator', 0)`).run(U);
    __setAlloyForTest(fakeAlloy(false));
    await pollDevices(db, { emit: () => undefined } as never, stubProbe);
    expect(mirrorState()).toBe('Booted');
    expect(probeCalls).toBe(1);
    // non-state fields still refresh
    const row = db.prepare('SELECT name, last_seen FROM devices WHERE udid = ?').get(U) as { name: string; last_seen: number };
    expect(row.name).toBe('Guard Sim');
    expect(row.last_seen).toBeGreaterThan(0);
  });

  it('engine says shutdown + simctl says Shutdown → row FLIPS (real power-off)', async () => {
    db.prepare(`INSERT INTO devices(udid, name, state, platform, kind, last_seen) VALUES (?, 'Old', 'Booted', 'ios', 'simulator', 0)`).run(U);
    stubProbe = () => { probeCalls += 1; return new Map([[U, false]]); };
    __setAlloyForTest(fakeAlloy(false));
    await pollDevices(db, { emit: () => undefined } as never, stubProbe);
    expect(mirrorState()).toBe('Shutdown');
  });

  it('engine says booted → no probe at all (spy count 0)', async () => {
    db.prepare(`INSERT INTO devices(udid, name, state, platform, kind, last_seen) VALUES (?, 'Old', 'Shutdown', 'ios', 'simulator', 0)`).run(U);
    __setAlloyForTest(fakeAlloy(true));
    await pollDevices(db, { emit: () => undefined } as never, stubProbe);
    expect(mirrorState()).toBe('Booted');
    expect(probeCalls).toBe(0);
  });

  it('probe throws → fail open (engine wins, row flips)', async () => {
    db.prepare(`INSERT INTO devices(udid, name, state, platform, kind, last_seen) VALUES (?, 'Old', 'Booted', 'ios', 'simulator', 0)`).run(U);
    stubProbe = () => { probeCalls += 1; throw new Error('xcrun unavailable'); };
    __setAlloyForTest(fakeAlloy(false));
    await pollDevices(db, { emit: () => undefined } as never, stubProbe);
    expect(mirrorState()).toBe('Shutdown');
  });

  it('failed dispatch → no state change (regression pin for the devices.ok guard)', async () => {
    db.prepare(`INSERT INTO devices(udid, name, state, platform, kind, last_seen) VALUES (?, 'Old', 'Booted', 'ios', 'simulator', 0)`).run(U);
    __setAlloyForTest({
      createRuntime: async () => ({ state: {}, deps: null }),
      dispatch: async () => ({ ok: false, error: { message: 'daemon contention' } }),
    } as unknown as AlloyExports);
    await pollDevices(db, { emit: () => undefined } as never, stubProbe);
    expect(mirrorState()).toBe('Booted');
    expect(probeCalls).toBe(0);
  });

  it('fresh row (no prior) inserted as Shutdown WITHOUT probing', async () => {
    __setAlloyForTest(fakeAlloy(false));
    await pollDevices(db, { emit: () => undefined } as never, stubProbe);
    expect(mirrorState()).toBe('Shutdown');
    expect(probeCalls).toBe(0);
  });
});
