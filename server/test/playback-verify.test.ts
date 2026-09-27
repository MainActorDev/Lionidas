import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrateM1 } from '../src/db/schema.ts';
import { runTemplatePlayback } from '../src/manual/playback.ts';
import { __setAlloyForTest, type AlloyExports } from '../src/alloy/client.ts';

let db: Database.Database;
let tmp: string;
let snapshotNodes: Array<{ index: number; parentIndex: number; type: string; label?: string; identifier?: string; rect: { x: number; y: number; width: number; height: number }; hittable: boolean; ref?: string }>;
let dispatchLog: string[];

/** Screen A: account list (has the privacy row) → tap → Screen B: privacy doc. */
const SCREEN_A = [
  { index: 0, parentIndex: -1, type: 'Application', label: 'App', rect: { x: 0, y: 0, width: 393, height: 852 }, hittable: false },
  { index: 1, parentIndex: 0, type: 'Button', label: 'Privacy Policy', rect: { x: 20, y: 640, width: 200, height: 44 }, hittable: true },
];
const SCREEN_B = [
  { index: 0, parentIndex: -1, type: 'Application', label: 'App', rect: { x: 0, y: 0, width: 393, height: 852 }, hittable: false },
  { index: 1, parentIndex: 0, type: 'StaticText', label: 'II. DATA COLLECTION', rect: { x: 36, y: 378, width: 358, height: 17 }, hittable: false },
];

function fakeAlloy(): AlloyExports {
  return {
    createRuntime: async () => ({ state: {}, deps: null }),
    dispatch: async (tool: string, rawIn: unknown) => {
      dispatchLog.push(tool);
      if (tool === 'alloy_apps') return { ok: true, result: {} };
      if (tool === 'alloy_snapshot') return { ok: true, result: { nodes: snapshotNodes, root: { rect: { width: 393, height: 852 } } } };
      if (tool === 'alloy_act') {
        const i = rawIn as { action: string };
        if (i.action === 'press' && snapshotNodes === SCREEN_A) snapshotNodes = SCREEN_B; // the tap navigates
        return { ok: true, result: {} };
      }
      if (tool === 'alloy_screenshot') return { ok: true, result: { path: '/dev/null' } };
      return { ok: true, result: {} };
    },
  } as unknown as AlloyExports;
}

const bus = { emit: () => undefined } as never;

function seed(id: string, steps: unknown[], logicalW = 393, logicalH = 852): void {
  db.prepare(`INSERT INTO templates(id, name, ticket_key, udid, steps_json, app_bundle_id, logical_w, logical_h, tags_json, created_by, created_at, updated_at)
              VALUES (?, ?, NULL, 'sim-1', ?, NULL, ?, ?, '[]', 'qa', 0, 0)`).run(id, id, JSON.stringify(steps), logicalW, logicalH);
}

async function play(id: string): Promise<string> {
  const r = await runTemplatePlayback({ db, bus, dispatchDeps: null, artifactsDir: tmp, forgeState: { activeRunId: null }, awaitStreamLive: async () => undefined, listApps: async () => [{ bundleId: 'com.x' }] } as never, id, {});
  await r.done;
  return r.runId;
}

function steps(runId: string): Array<{ idx: number; name: string; status: string; reason: string | null; evaluated_json: string | null }> {
  return db.prepare('SELECT idx, name, status, reason, evaluated_json FROM run_steps WHERE run_id = ? ORDER BY idx').all(runId) as never;
}

beforeEach(() => {
  db = new Database(':memory:');
  migrateM1(db);
  tmp = mkdtempSync(join(tmpdir(), 'tap-verify-'));
  dispatchLog = [];
  snapshotNodes = SCREEN_A;
  __setAlloyForTest(fakeAlloy());
});
afterEach(() => {
  __setAlloyForTest(null);
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('Task 2 — post-tap screen-change verification', () => {
  it('tap that navigates (sig changes) → clean pass, screenChanged: true', async () => {
    seed('tpl_v1', [{ idx: 0, action: 'tap', x: 100, y: 660, selector: { label: 'Privacy Policy' } }]);
    const runId = await play('tpl_v1');
    const rows = steps(runId);
    expect(rows[0]!.status).toBe('pass');
    expect(rows[0]!.reason).toBeNull();
    const ev = JSON.parse(rows[0]!.evaluated_json!) as { screenChanged?: boolean };
    expect(ev.screenChanged).toBe(true);
  });

  it('tap that does nothing (sig unchanged) → WARN-pass with reason + screenChanged: false', async () => {
    // override: press does NOT navigate (stay on SCREEN_A)
    __setAlloyForTest({
      createRuntime: async () => ({ state: {}, deps: null }),
      dispatch: async (tool: string) => {
        if (tool === 'alloy_apps') return { ok: true, result: {} };
        if (tool === 'alloy_snapshot') return { ok: true, result: { nodes: snapshotNodes, root: { rect: { width: 393, height: 852 } } } };
        if (tool === 'alloy_screenshot') return { ok: true, result: { path: '/dev/null' } };
        return { ok: true, result: {} };
      },
    } as unknown as AlloyExports);
    seed('tpl_v2', [{ idx: 0, action: 'tap', x: 100, y: 660, selector: { label: 'Privacy Policy' } }]);
    const runId = await play('tpl_v2');
    const rows = steps(runId);
    expect(rows[0]!.status).toBe('pass'); // WARN-pass (v1 decision)
    expect(rows[0]!.reason).toContain('no screen change');
    const ev = JSON.parse(rows[0]!.evaluated_json!) as { screenChanged?: boolean };
    expect(ev.screenChanged).toBe(false);
  });
});

describe('Task 3 — cross-geometry selector-less taps fail honestly', () => {
  it('scaled device + selector-less tap → fail with the authoring reason', async () => {
    seed('tpl_v3', [{ idx: 0, action: 'tap', x: 147, y: 649 }], 428, 926); // recorded on 14 Plus
    // target device is 393×852 (fake root) → scale ≠ 1
    const runId = await play('tpl_v3');
    const rows = steps(runId);
    expect(rows[0]!.status).toBe('fail');
    expect(rows[0]!.reason).toContain('cross-device coordinate tap without a selector');
  });

  it('scaled + optional → skip with that reason', async () => {
    seed('tpl_v4', [{ idx: 0, action: 'tap', x: 147, y: 649, optional: true }], 428, 926);
    const runId = await play('tpl_v4');
    const rows = steps(runId);
    expect(rows[0]!.status).toBe('skip');
    expect(rows[0]!.reason).toContain('cross-device');
  });

  it('same device (scale=1) + selector-less → pass (regression)', async () => {
    seed('tpl_v5', [{ idx: 0, action: 'tap', x: 100, y: 660 }], 393, 852);
    const runId = await play('tpl_v5');
    const rows = steps(runId);
    expect(rows[0]!.status).toBe('pass');
  });
});

describe('Task 4 — recentre audit + tightened slack', () => {
  it('recentred steps record recentred: true + distance in evaluated_json', async () => {
    // selector resolves FAR from the scaled point → recentre path (Button, recentre-safe)
    __setAlloyForTest({
      createRuntime: async () => ({ state: {}, deps: null }),
      dispatch: async (tool: string) => {
        if (tool === 'alloy_apps') return { ok: true, result: {} };
        if (tool === 'alloy_snapshot') return { ok: true, result: { nodes: SCREEN_A, root: { rect: { width: 393, height: 852 } } } };
        if (tool === 'alloy_act') return { ok: true, result: {} };
        if (tool === 'alloy_screenshot') return { ok: true, result: { path: '/dev/null' } };
        return { ok: true, result: {} };
      },
    } as unknown as AlloyExports);
    // point+selector → projected-point (the recentre ladder is retired by
    // the sub-second taps plan: the recorded point IS the aim; a stale aim
    // is caught by the next verifying step). Pin the new audit shape.
    seed('tpl_v6', [{ idx: 0, action: 'tap', x: 10, y: 10, selector: { label: 'Privacy Policy' } }], 428, 926);
    const runId = await play('tpl_v6');
    const rows = steps(runId);
    expect(rows[0]!.status).toBe('pass');
    const ev = JSON.parse(rows[0]!.evaluated_json!) as { resolvedBy?: string; recentred?: boolean; distance?: number };
    expect(ev.resolvedBy).toBe('projected-point');
    expect(ev.recentred).toBeUndefined(); // audit retired with the ladder
    expect(ev.distance).toBeUndefined();
  });
});
