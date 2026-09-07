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
