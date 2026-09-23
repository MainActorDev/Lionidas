import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScreenRunner, stateHolds, selectorMatches, type SnapNode, type ScreenRunnerDeps } from '../src/manual/screen-runner.ts';

/** R2 S5 — screen-state runner guards. All engine/forge seams faked; the
 *  three load-bearing guards (traffic verification, swap-window bound,
 *  black-display) each have PASS and FAIL tests per the plan. */

let tmp: string;
let db: Database.Database;

const BUNDLE = 'com.test.app';

type Dispatch = ScreenRunnerDeps['dispatch'];

function seedScreen(overrides: Record<string, unknown> = {}): void {
  db.prepare('INSERT INTO app_screens(app_bundle_id, screen_id, entry_json, refresh_json, states_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(BUNDLE, 'tracking',
      JSON.stringify(overrides['entry'] ?? { deepLink: 'tracking://x' }),
      JSON.stringify(overrides['refresh'] ?? { gesture: 'pull' }),
      JSON.stringify(overrides['states'] ?? { loaded: { all: [{ labelContains: 'STATUS' }] }, loading: { any: [{ labelContains: 'Memuat' }] } }),
      1);
}

function mkRunner(dispatch: Dispatch, activate: (rows: Array<Record<string, unknown>>) => void = () => undefined, budgets: ScreenRunnerDeps['budgets'] = {}): ScreenRunner {
  return new ScreenRunner({
    db, appBundleId: BUNDLE, runId: 'run_x', udid: 'sim',
    dispatch,
    forgeActivate: activate,
    budgets: { settleMs: 50, worldConfirmMs: 120, worldConfirmPollMs: 20, statePollMs: 10, ...budgets },
  });
}

const snapWith = (nodes: SnapNode[]): Dispatch => async () => ({ ok: true, result: { nodes } });

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 's5-runner-'));
  db = new Database(join(tmp, 't.db'));
  db.exec(`CREATE TABLE app_screens(app_bundle_id TEXT NOT NULL, screen_id TEXT NOT NULL, entry_json TEXT NOT NULL, refresh_json TEXT, states_json TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(app_bundle_id, screen_id))`);
  db.exec(`CREATE TABLE traffic(id TEXT PRIMARY KEY, run_id TEXT, ts INTEGER NOT NULL, mode TEXT NOT NULL, method TEXT NOT NULL, host TEXT, path TEXT NOT NULL, matched_preset_id TEXT, status INTEGER NOT NULL, latency_ms INTEGER NOT NULL, req_sha TEXT, res_sha TEXT)`);
  db.exec(`CREATE TABLE presets(id TEXT PRIMARY KEY, method TEXT, path_pattern TEXT, match TEXT, status INTEGER, headers_json TEXT, body_path TEXT, delay_ms INTEGER, seq_json TEXT, failure TEXT, throttle_kbps INTEGER, created_by TEXT, created_at INTEGER, sha256 TEXT, guards_json TEXT)`);
  db.exec(`CREATE TABLE scenario_overrides(scenario_id TEXT, preset_id TEXT, enabled INTEGER)`);
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('S5 — selector/state semantics', () => {
  const nodes: SnapNode[] = [
    { label: 'STATUS PENGIRIMAN' },
    { label: ' Memuat… ' },
    { identifier: 'ic_back' },
  ];
  it('selectorMatches: exact, contains, identifier, ignoreCase', () => {
    expect(selectorMatches(nodes, { label: 'STATUS PENGIRIMAN' })).toBe(1);
    expect(selectorMatches(nodes, { labelContains: 'PENGIRIMAN' })).toBe(1);
    expect(selectorMatches(nodes, { labelContains: 'pengiriman', ignoreCase: true })).toBe(1);
    expect(selectorMatches(nodes, { labelContains: 'pengiriman' })).toBe(0);
    expect(selectorMatches(nodes, { identifier: 'ic_back' })).toBe(1);
  });
  it('stateHolds: all=AND, any=OR-total', () => {
    expect(stateHolds(nodes, { all: [{ labelContains: 'STATUS' }] })).toBe(true);
    expect(stateHolds(nodes, { all: [{ labelContains: 'STATUS' }, { labelContains: 'nope' }] })).toBe(false);
    expect(stateHolds(nodes, { any: [{ labelContains: 'nope' }, { identifier: 'ic_back' }] })).toBe(true);
    expect(stateHolds(nodes, { all: [{ labelContains: 'STATUS' }], any: [{ labelContains: 'nope' }] })).toBe(false);
  });
});

describe('S5 — GUARD 1: refresh verifies traffic (pass AND fail)', () => {
  it('FAIL: no new request for this run → WORLD_NOT_CONFIRMED', async () => {
    seedScreen();
    const r = mkRunner(snapWith([]));
    const out = await r.refresh('tracking');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe('WORLD_NOT_CONFIRMED');
  });

  it('PASS: request lands mid-budget → confirmed with count', async () => {
    seedScreen();
    // traffic row appears 60ms in (within the 120ms budget)
    setTimeout(() => db.prepare('INSERT INTO traffic(id, run_id, ts, mode, method, path, matched_preset_id, status, latency_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('t1', 'run_x', Date.now(), 'hybrid', 'GET', '/x', 'p1', 200, 5), 60);
    const r = mkRunner(snapWith([]));
    const out = await r.refresh('tracking');
    expect(out.ok).toBe(true);
    expect(out.note).toContain('1 request');
  });

  it('other-run traffic does NOT confirm (run attribution is the epoch)', async () => {
    seedScreen();
    setTimeout(() => db.prepare('INSERT INTO traffic(id, run_id, ts, mode, method, path, matched_preset_id, status, latency_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('t2', 'run_OTHER', Date.now(), 'hybrid', 'GET', '/x', 'p1', 200, 5), 40);
    const r = mkRunner(snapWith([]));
    const out = await r.refresh('tracking');
    expect(out.ok).toBe(false);
  });
});

describe('S5 — GUARD 2: swap-window bound', () => {
  it('swaps beyond max → SWAP_LIMIT names the bound', async () => {
    seedScreen();
    const r = mkRunner(snapWith([]), () => undefined, { maxSwaps: 2 });
    expect((await r.world('a', [])).ok).toBe(true);
    expect((await r.world('b', [])).ok).toBe(true);
    const third = await r.world('c', []);
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.code).toBe('SWAP_LIMIT');
  });

  it('world activates the union of scenario presets (DISTINCT)', async () => {
    seedScreen();
    db.prepare(`INSERT INTO presets(id, method, path_pattern, match, status, created_by, created_at, sha256) VALUES ('pA','GET','/a','exact',200,'t',1,'x')`).run();
    db.prepare(`INSERT INTO presets(id, method, path_pattern, match, status, created_by, created_at, sha256) VALUES ('pB','GET','/b','exact',200,'t',1,'x')`).run();
    db.prepare(`INSERT INTO presets(id, method, path_pattern, match, status, created_by, created_at, sha256) VALUES ('pSH','GET','/s','exact',200,'t',1,'x')`).run();
    db.prepare(`INSERT INTO scenario_overrides(scenario_id, preset_id, enabled) VALUES ('s1','pA',1)`).run();
    db.prepare(`INSERT INTO scenario_overrides(scenario_id, preset_id, enabled) VALUES ('s1','pSH',1)`).run();
    db.prepare(`INSERT INTO scenario_overrides(scenario_id, preset_id, enabled) VALUES ('s2','pB',1)`).run();
    db.prepare(`INSERT INTO scenario_overrides(scenario_id, preset_id, enabled) VALUES ('s2','pSH',1)`).run();
    const activated: Array<Record<string, unknown>> = [];
    const r = mkRunner(snapWith([]), (rows) => activated.push(...rows));
    const out = await r.world('mixed', ['s1', 's2']);
    expect(out.ok).toBe(true);
    expect(activated.map((x) => x['id']).sort()).toEqual(['pA', 'pB', 'pSH']); // shared once
  });
});

describe('S5 — GUARD 3: black-display check', () => {
  it('state matches but screenshot tiny/black → DISPLAY_DEAD', async () => {
    seedScreen();
    const { writeFileSync } = await import('node:fs');
    const blackPng = join(tmp, 'black.png');
    writeFileSync(blackPng, Buffer.alloc(2048)); // < 4KB at "phone" size = solid frame
    let calls = 0;
    const dispatch: Dispatch = async (tool) => {
      calls++;
      if (tool === 'alloy_snapshot') return { ok: true, result: { nodes: [{ label: 'STATUS PENGIRIMAN' }] } };
      return { ok: true, result: { path: blackPng } }; // screenshot
    };
    const r = mkRunner(dispatch);
    const out = await r.expectScreen('tracking', 'loaded', false);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe('DISPLAY_DEAD');
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('state matches, healthy screenshot → pass', async () => {
    seedScreen();
    const { writeFileSync } = await import('node:fs');
    const fatPng = join(tmp, 'fat.png');
    writeFileSync(fatPng, Buffer.alloc(60_000, 7)); // big = content
    const dispatch: Dispatch = async (tool) =>
      tool === 'alloy_snapshot'
        ? { ok: true, result: { nodes: [{ label: 'STATUS PENGIRIMAN' }] } }
        : { ok: true, result: { path: fatPng } };
    const r = mkRunner(dispatch);
    const out = await r.expectScreen('tracking', 'loaded', false);
    expect(out.ok).toBe(true);
  });

  it('negated form: state present → fails; state absent → passes', async () => {
    seedScreen();
    const present = snapWith([{ label: 'Memuat…' }]);
    const absent = snapWith([{ label: 'STATUS PENGIRIMAN' }]);
    const r1 = mkRunner(present);
    expect((await r1.expectScreen('tracking', 'loading', true)).ok).toBe(false); // want absent, it's held
    const r2 = mkRunner(absent);
    expect((await r2.expectScreen('tracking', 'loading', true)).ok).toBe(true); // want absent, it's absent
  });
});

describe('S5 — arrive', () => {
  it('deepLink entry fails honestly when simctl openurl errors (no sim in CI)', async () => {
    seedScreen();
    const dispatch: Dispatch = async () => ({ ok: true, result: { nodes: [{ label: 'STATUS PENGIRIMAN' }] } });
    const r = mkRunner(dispatch);
    const out = await r.arrive('tracking');
    // the real openSimulatorUrl shells out; with no booted sim it rejects → SCREEN_ENTRY_FAILED
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe('SCREEN_ENTRY_FAILED');
    if (!out.ok) expect(out.note).toContain('deep link failed');
  });

  it('unknown screen → UNKNOWN_SCREEN (registry can change mid-flight)', async () => {
    seedScreen();
    const r = mkRunner(snapWith([]));
    const out = await r.arrive('ghost');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe('UNKNOWN_SCREEN');
  });
});
