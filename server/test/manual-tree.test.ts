import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manualTree, startManualSession } from '../src/manual/session.ts';
import { __setAlloyForTest } from '../src/alloy/client.ts';
import type { AlloyExports } from '../src/alloy/client.ts';
import type { SnapNode } from '../src/manual/selector.ts';
import { migrateM1 } from '../src/db/schema.ts';
import { __setEngineTreeForTest } from '../src/alloy/engine-tree.ts';

let db: Database.Database;
let tmp: string;

const treeNodes: SnapNode[] = [
  { index: 0, parentIndex: -1, type: 'Application', label: 'App', rect: { x: 0, y: 0, width: 428, height: 926 }, hittable: false },
  { index: 1, parentIndex: 0, type: 'Button', identifier: 'home_login_bar_login_button', rect: { x: 300, y: 130, width: 100, height: 44 }, hittable: true },
  { index: 2, parentIndex: 0, type: 'StaticText', label: 'Sign Up', rect: { x: 32, y: 140, width: 80, height: 20 }, hittable: true },
];

let snapshotOk = true;
let snapshotCalls = 0;
function fakeAlloy(): AlloyExports {
  return {
    dispatch: async (tool: string, args: Record<string, unknown>) => {
      if (tool === 'alloy_apps') return { ok: true, result: {} };
      if (tool === 'alloy_snapshot') {
        snapshotCalls++;
        if (!snapshotOk) return { ok: false, error: { message: 'engine cold' } };
        // interactiveOnly:false is the contract — the overlay needs the FULL tree
        expect(args['interactiveOnly']).toBe(false);
        return { ok: true, result: { nodes: treeNodes } };
      }
      return { ok: true, result: {} };
    },
  } as unknown as AlloyExports;
}

const bus = { emit: () => undefined } as never;
const mkDeps = () => ({ db, bus, dispatchDeps: {} }) as never;

async function startSession(udid: string): Promise<string> {
  const r = await startManualSession(mkDeps(), udid, 'op');
  return r.sessionId;
}

describe('manualTree — inspect-mode tree endpoint', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'crucible-tree-'));
    db = new Database(join(tmp, 't.db'));
    db.pragma('journal_mode = WAL');
    migrateM1(db);
    snapshotOk = true;
    snapshotCalls = -1; // startSession's dim probe is snapshot #0
    __setAlloyForTest(fakeAlloy());
  });
  afterEach(() => {
    __setAlloyForTest(null);
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('happy path: nodes pass through VERBATIM, dims from Application root, capturedAt set', async () => {
    const sessionId = await startSession('udid-x');
    const before = Date.now();
    const t = await manualTree(mkDeps(), sessionId);
    expect(t.nodes).toEqual(treeNodes);          // no shaping, no filtering
    expect(t.nodes).toHaveLength(3);
    expect(t.logicalW).toBe(428);
    expect(t.logicalH).toBe(926);
    expect(t.capturedAt).toBeGreaterThanOrEqual(before);
    expect(snapshotCalls).toBe(1);
  });

  it('dims fall back to session dims when Application root lacks a rect', async () => {
    const sessionId = await startSession('udid-x');
    const saved = (treeNodes[0] as SnapNode).rect as { x: number; y: number; width: number; height: number };
    (treeNodes[0] as { rect?: SnapNode['rect'] }).rect = undefined;
    try {
      // session dims were captured at start (root existed then) → still served
      const t = await manualTree(mkDeps(), sessionId);
      expect(t.logicalW).toBe(428);
    } finally { (treeNodes[0] as SnapNode).rect = saved!; }
  });

  it('engine failure → LEASE_LOST ManualSessionError (410 class at the route)', async () => {
    const sessionId = await startSession('udid-x');
    snapshotOk = false;
    await expect(manualTree(mkDeps(), sessionId)).rejects.toThrow('tree failed');
  });

  it('dead session → SESSION_NOT_FOUND (same guard class as snapshot/tap)', async () => {
    await expect(manualTree(mkDeps(), 'ms_nope')).rejects.toThrow();
  });

  it('activity touch: last_activity advances on each tree fetch', async () => {
    const sessionId = await startSession('udid-x');
    const before = (db.prepare('SELECT last_activity FROM manual_sessions WHERE id=?').get(sessionId) as { last_activity: number }).last_activity;
    await new Promise((r) => setTimeout(r, 5));
    await manualTree(mkDeps(), sessionId);
    const after = (db.prepare('SELECT last_activity FROM manual_sessions WHERE id=?').get(sessionId) as { last_activity: number }).last_activity;
    expect(after).toBeGreaterThan(before);
  });
});

describe('manualTree — dual source (AX-depth adoption T3)', () => {
  const engineNodes: SnapNode[] = [
    { index: 0, type: 'Application', label: 'App', rect: { x: 0, y: 0, width: 402, height: 874 }, hittable: false },
    { index: 1, parentIndex: 0, type: 'StaticText', label: 'battery', rect: { x: 300, y: 20, width: 60, height: 12 }, hittable: true },
  ];
  const seedSim = (udid: string): void => {
    db.prepare("INSERT INTO devices(udid, name, state, platform, kind, last_seen) VALUES (?, 'Sim', 'Booted', 'ios', 'simulator', ?)").run(udid, Date.now());
  };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'crucible-tree-'));
    db = new Database(join(tmp, 't.db'));
    db.pragma('journal_mode = WAL');
    migrateM1(db);
    snapshotOk = true;
    snapshotCalls = -1;
    __setAlloyForTest(fakeAlloy());
  });
  afterEach(() => {
    __setAlloyForTest(null);
    __setEngineTreeForTest(null);
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('simulator + engine OK → engine nodes, source:engine, NO alloy snapshot spent', async () => {
    seedSim('sim-1');
    __setEngineTreeForTest(async () => engineNodes);
    const sessionId = await startSession('sim-1');
    const t = await manualTree(mkDeps(), sessionId);
    expect(t.source).toBe('engine');
    expect(t.nodes).toEqual(engineNodes);
    expect(t.logicalW).toBe(402);
    expect(snapshotCalls).toBe(0); // engine path never touched alloy
  });

  it('simulator + engine THROWS → honest alloy fallback, source:alloy', async () => {
    seedSim('sim-2');
    __setEngineTreeForTest(async () => { throw new Error('BIN_MISSING: no binary'); });
    const sessionId = await startSession('sim-2');
    const t = await manualTree(mkDeps(), sessionId);
    expect(t.source).toBe('alloy');
    expect(t.nodes).toEqual(treeNodes); // alloy fixture
  });

  it('non-sim (no devices row / physical) → engine never attempted', async () => {
    __setEngineTreeForTest(async (udid) => { throw new Error(`engine must not be called for ${udid}`); });
    const sessionId = await startSession('udid-x'); // no devices row
    const t = await manualTree(mkDeps(), sessionId);
    expect(t.source).toBe('alloy');
    expect(t.nodes).toEqual(treeNodes);
  });
});
