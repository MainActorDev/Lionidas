import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrateM1 } from '../src/db/schema.ts';
import { runTemplatePlayback, PlaybackError } from '../src/manual/playback.ts';
import { __setAlloyForTest, type AlloyExports } from '../src/alloy/client.ts';

/** T5 (Tier 2.3): playback dispatch for location steps. The location ops
 *  (grant / set / clear) are injected via the locationControl seam — the
 *  real defaults shell simctl + write the device TCC row.
 *  Contract under test:
 *  - grant fires ONCE per run, at run start (before open), only when the
 *    template contains a location step
 *  - each location step sets + records pass with its coordinate
 *  - clear fires at run end ONLY when a location was actually set
 *  - grant failure = fail-fast named error, no run row
 *  - set failure = the step fails, remaining steps skipped
 *  - clear failure never fails the run (hygiene is best-effort) */

let db: Database.Database;
let tmp: string;

function fakeAlloy(): AlloyExports {
  return {
    dispatch: async (tool: string) => {
      if (tool === 'alloy_snapshot') return { ok: true, result: { nodes: [
        { index: 0, parentIndex: -1, type: 'Application', label: 'App', rect: { x: 0, y: 0, width: 393, height: 852 }, hittable: false, ref: 'root' },
        { index: 1, parentIndex: 0, type: 'StaticText', label: 'Home', rect: { x: 0, y: 0, width: 10, height: 10 }, hittable: true, ref: 'n1' },
      ] } };
      return { ok: true, result: {} };
    },
  } as unknown as AlloyExports;
}

const bus = { emit: () => undefined } as never;

function seedTemplate(id: string, steps: unknown[]): void {
  db.prepare(`INSERT INTO templates(id, name, udid, steps_json, app_bundle_id, created_by, created_at, updated_at)
              VALUES (?, ?, 'sim', ?, NULL, 'qa', 0, 0)`)
    .run(id, id, JSON.stringify(steps));
  db.prepare(`INSERT INTO devices(udid, name, state, platform, kind, last_seen) VALUES ('sim', 'Sim', 'Booted', 'ios', 'simulator', 0)
              ON CONFLICT(udid) DO UPDATE SET state = 'Booted'`).run();
}

type Control = {
  grants: Array<[string, string]>;
  sets: Array<[string, number, number]>;
  clears: string[];
  failGrant?: boolean;
  failSet?: boolean;
  failClear?: boolean;
};

function locationControl(c: Control) {
  return {
    grant: async (u: string, b: string) => {
      c.grants.push([u, b]);
      if (c.failGrant) throw new Error('tcc write failed');
      return { granted: true as const, inserted: true };
    },
    set: async (u: string, lat: number, lon: number) => {
      c.sets.push([u, lat, lon]);
      if (c.failSet) throw new Error('simctl location set failed');
      return { set: true as const, coordinate: `${lat.toFixed(6)},${lon.toFixed(6)}` };
    },
    clear: async (u: string) => {
      c.clears.push(u);
      if (c.failClear) throw new Error('simctl location clear failed');
      return { cleared: true as const };
    },
  };
}

function harness(ctrl: Control) {
  return { db, bus, dispatchDeps: null, artifactsDir: tmp, forgeState: { activeRunId: null },
    awaitStreamLive: null, locationControl: locationControl(ctrl) } as never;
}

const LOC = { latitude: -6.1754, longitude: 106.8272 };

beforeEach(() => {
  __setAlloyForTest(fakeAlloy());
  db = new Database(':memory:');
  migrateM1(db);
  tmp = mkdtempSync(join(tmpdir(), 'loc-'));
});
afterEach(() => {
  __setAlloyForTest(null);
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('playback location dispatch', () => {
  it('location step: grant once at start, set with coords, clear at end', async () => {
    seedTemplate('tpl_loc', [
      { idx: 0, action: 'location', location: LOC },
      { idx: 1, action: 'tap', x: 10, y: 10 },
    ]);
    const c: Control = { grants: [], sets: [], clears: [] };
    const r = await runTemplatePlayback(harness(c), 'tpl_loc', {});
    await r.done;

    expect(c.grants).toEqual([['sim', 'com.apple.Preferences']]); // default app, once
    expect(c.sets).toEqual([['sim', -6.1754, 106.8272]]);
    expect(c.clears).toEqual(['sim']);

    const run = db.prepare('SELECT status FROM runs WHERE id = ?').get(r.runId) as { status: string };
    expect(run.status).toBe('passed');
    const step = db.prepare('SELECT name, status, evaluated_json FROM run_steps WHERE run_id = ? AND idx = 0').get(r.runId) as { name: string; status: string; evaluated_json: string };
    expect(step.status).toBe('pass');
    expect(step.name).toContain('-6.1754');
    const ev = JSON.parse(step.evaluated_json) as { action: string; coordinate: string };
    expect(ev.action).toBe('location');
    expect(ev.coordinate).toBe('-6.175400,106.827200');
  });

  it('no location steps → NO grant, NO clear (pure-tap template never spawns them)', async () => {
    seedTemplate('tpl_plain', [{ idx: 0, action: 'tap', x: 10, y: 10 }]);
    const c: Control = { grants: [], sets: [], clears: [] };
    const r = await runTemplatePlayback(harness(c), 'tpl_plain', {});
    await r.done;
    expect(c.grants).toEqual([]);
    expect(c.sets).toEqual([]);
    expect(c.clears).toEqual([]);
    const run = db.prepare('SELECT status FROM runs WHERE id = ?').get(r.runId) as { status: string };
    expect(run.status).toBe('passed');
  });

  it('two location steps → grant still once, set twice, clear once', async () => {
    seedTemplate('tpl_two', [
      { idx: 0, action: 'location', location: LOC },
      { idx: 1, action: 'location', location: { latitude: 37.7749, longitude: -122.4194 } },
    ]);
    const c: Control = { grants: [], sets: [], clears: [] };
    const r = await runTemplatePlayback(harness(c), 'tpl_two', {});
    await r.done;
    expect(c.grants).toHaveLength(1);
    expect(c.sets).toHaveLength(2);
    expect(c.clears).toHaveLength(1);
  });

  it('grant failure → fail-fast named error, NO run row', async () => {
    seedTemplate('tpl_loc', [{ idx: 0, action: 'location', location: LOC }]);
    const c: Control = { grants: [], sets: [], clears: [], failGrant: true };
    let err: unknown;
    await runTemplatePlayback(harness(c), 'tpl_loc', {}).catch((e) => { err = e; });
    expect(err).toBeInstanceOf(PlaybackError);
    expect((err as PlaybackError).code).toBe('LOCATION_GRANT_FAILED');
    expect(db.prepare('SELECT COUNT(*) c FROM runs').get()).toEqual({ c: 0 });
  });

  it('set failure → the STEP fails, remaining steps skipped, run failed', async () => {
    seedTemplate('tpl_loc', [
      { idx: 0, action: 'location', location: LOC },
      { idx: 1, action: 'tap', x: 10, y: 10 },
    ]);
    const c: Control = { grants: [], sets: [], clears: [], failSet: true };
    const r = await runTemplatePlayback(harness(c), 'tpl_loc', {});
    await r.done;
    const run = db.prepare('SELECT status FROM runs WHERE id = ?').get(r.runId) as { status: string };
    expect(run.status).toBe('failed');
    const s0 = db.prepare('SELECT status, reason FROM run_steps WHERE run_id = ? AND idx = 0').get(r.runId) as { status: string; reason: string };
    expect(s0.status).toBe('fail');
    expect(s0.reason).toContain('simctl location set failed');
    const s1 = db.prepare('SELECT status, reason FROM run_steps WHERE run_id = ? AND idx = 1').get(r.runId) as { status: string; reason: string };
    expect(s1.status).toBe('skip');
    expect(s1.reason).toBe('not reached');
  });

  it('clear failure → run still completes passed (hygiene best-effort)', async () => {
    seedTemplate('tpl_loc', [{ idx: 0, action: 'location', location: LOC }]);
    const c: Control = { grants: [], sets: [], clears: [], failClear: true };
    const r = await runTemplatePlayback(harness(c), 'tpl_loc', {});
    await r.done;
    const run = db.prepare('SELECT status FROM runs WHERE id = ?').get(r.runId) as { status: string };
    expect(run.status).toBe('passed');
    expect(c.clears).toEqual(['sim']); // attempted
  });
});
