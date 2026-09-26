import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTemplatePlayback } from '../src/manual/playback.ts';
import { __setAlloyForTest } from '../src/alloy/client.ts';
import type { AlloyExports } from '../src/alloy/client.ts';
import type { SnapNode } from '../src/manual/selector.ts';

let db: Database.Database;
let tmp: string;
let snapshotNodes: SnapNode[];
let snapshotAttempts: number;
/** when >0: snapshots return root-only until attempts >= N (simulates launch settle) */
let settleAfterAttempts: number;
let lastActInput: { target?: { x: number; y: number } } | null = null;

const ROOT: SnapNode = {
  index: 0, parentIndex: -1, type: 'Application', label: 'App',
  rect: { x: 0, y: 0, width: 428, height: 926 }, hittable: false,
};
/** the tnc-class fixture: a footer CONTAINER (page-dots) whose rect covers the
 *  recorded point while its CENTER sits on a different control, plus the two
 *  inline links — geometry mirrors the live login screen where the
 *  wrong-document bug was found (T&C ~(236,824) vs Privacy Policy ~(262,837)). */
const FOOTER_NODES: SnapNode[] = [
  ROOT,
  { // container selector the recorder captured — center (215,840) lands on PP
    index: 1, parentIndex: 0, type: 'Other', label: 'Horizontal scroll bar, 1 page',
    rect: { x: 100, y: 810, width: 230, height: 60 }, hittable: true,
  },
  { index: 2, parentIndex: 0, type: 'Link', label: 'Terms & Conditions',
    rect: { x: 200, y: 812, width: 80, height: 26 }, hittable: true },
  { index: 3, parentIndex: 0, type: 'Link', label: 'Privacy Policy',
    rect: { x: 245, y: 836, width: 70, height: 26 }, hittable: true },
];

function fakeAlloy(): AlloyExports {
  return {
    dispatch: async (tool: string, input: unknown) => {
      if (tool === 'alloy_apps') return { ok: true, result: {} };
      if (tool === 'alloy_snapshot') {
        snapshotAttempts++;
        const nodes = settleAfterAttempts > 0 && snapshotAttempts < settleAfterAttempts
          ? [ROOT]
          : snapshotNodes;
        return { ok: true, result: { nodes, root: { rect: { width: 428, height: 926 } } } };
      }
      if (tool === 'alloy_act') {
        lastActInput = input as { target?: { x: number; y: number } };
        return { ok: true, result: {} };
      }
      if (tool === 'alloy_screenshot') return { ok: true, result: { path: '/dev/null' } };
      return { ok: true, result: {} };
    },
  } as unknown as AlloyExports;
}

const bus = { emit: () => undefined } as never;

function seedTemplate(id: string, steps: unknown[], dims?: { w: number; h: number }): void {
  db.prepare(`INSERT INTO templates(id, name, ticket_key, udid, steps_json, app_bundle_id, logical_w, logical_h, tags_json, created_by, created_at, updated_at)
              VALUES (?, ?, NULL, 'sim-1', ?, NULL, ?, ?, '[]', 'qa', 0, 0)`)
    .run(id, id, JSON.stringify(steps), dims?.w ?? 428, dims?.h ?? 926);
}

async function play(id: string): Promise<string> {
  const r = await runTemplatePlayback({ db, bus, dispatchDeps: null, artifactsDir: tmp, forgeState: { activeRunId: null }, awaitStreamLive: async () => undefined } as never, id, {});
  await r.done;
  return r.runId;
}

function runRows(runId: string): Array<{ idx: number; status: string; reason: string | null; evaluated_json: string | null }> {
  return db.prepare('SELECT idx, status, reason, evaluated_json FROM run_steps WHERE run_id = ? ORDER BY idx').all(runId) as never;
}
function ev(steps: ReturnType<typeof runRows>): { resolvedBy?: string } {
  return JSON.parse(steps[0]!.evaluated_json ?? '{}') as { resolvedBy?: string };
}

beforeEach(() => {
  process.env.CRUCIBLE_EXPECT_SETTLE_MS = '10';
  process.env.CRUCIBLE_EXPECT_SETTLE_POLL_MS = '5';
  process.env.CRUCIBLE_STEP_SETTLE_MS = '60';
  process.env.CRUCIBLE_STEP_SETTLE_POLL_MS = '5';
  tmp = mkdtempSync(join(tmpdir(), 'tapres-'));
  db = new Database(':memory:');
  const { migrateM1 } = require('../src/db/schema.ts') as typeof import('../src/db/schema.ts');
  migrateM1(db);
  lastActInput = null;
  snapshotAttempts = 0;
  settleAfterAttempts = 0;
  snapshotNodes = FOOTER_NODES;
  __setAlloyForTest(fakeAlloy());
});
afterEach(() => {
  delete process.env.CRUCIBLE_EXPECT_SETTLE_MS;
  delete process.env.CRUCIBLE_EXPECT_SETTLE_POLL_MS;
  delete process.env.CRUCIBLE_STEP_SETTLE_MS;
  delete process.env.CRUCIBLE_STEP_SETTLE_POLL_MS;
  __setAlloyForTest(null);
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('tap resolution: selector confirms, never recentres (A6b)', () => {
  it('recorded point inside container rect → taps the RECORDED point, not the container center', async () => {
    // selector = page-dots container (center (215,840) = Privacy Policy);
    // recorded (236,824) = Terms & Conditions, INSIDE the container rect
    seedTemplate('t1', [{ idx: 0, action: 'tap', x: 236, y: 824, selector: { label: 'Horizontal scroll bar, 1 page', type: 'Other' } }]);
    const runId = await play('t1');
    const steps = runRows(runId);
    expect(steps[0]!.status).toBe('pass');
    expect(ev(steps).resolvedBy).toBe('selector');
    expect(lastActInput?.target).toEqual({ x: 236, y: 824 }); // NOT (215,840)
  });

  it('recorded point FAR from matched rect (element moved) → selector center (recentred)', async () => {
    // recorded (30,60) — nowhere near the T&C link at (200..280, 812..838)
    seedTemplate('t2', [{ idx: 0, action: 'tap', x: 30, y: 60, selector: { label: 'Terms & Conditions', type: 'Link' } }]);
    const runId = await play('t2');
    const steps = runRows(runId);
    expect(steps[0]!.status).toBe('pass');
    expect(ev(steps).resolvedBy).toBe('selector-recentred');
    expect(lastActInput?.target).toEqual({ x: 240, y: 825 }); // T&C center
  });

  it('selector never resolves (gone) → coordinate fallback, tap still dispatched', async () => {
    seedTemplate('t3', [{ idx: 0, action: 'tap', x: 236, y: 824, selector: { label: 'No Such Element', type: 'Link' } }]);
    const runId = await play('t3');
    const steps = runRows(runId);
    expect(steps[0]!.status).toBe('pass');
    expect(ev(steps).resolvedBy).toBe('coordinate-fallback');
    expect(lastActInput?.target).toEqual({ x: 236, y: 824 });
  });

  it('selector-only step (no recorded coords) → selector center, labeled selector', async () => {
    // contract change 2026-09-26: selector-only steps take the resolved hit
    // center directly — no recentre ladder (the old fall-through mislabeled
    // them 'selector-recentred' with distance-vs-origin garbage in the audit)
    seedTemplate('t4', [{ idx: 0, action: 'tap', selector: { label: 'Terms & Conditions', type: 'Link' } }]);
    const runId = await play('t4');
    const steps = runRows(runId);
    expect(steps[0]!.status).toBe('pass');
    expect(ev(steps).resolvedBy).toBe('selector');
    expect(lastActInput?.target).toEqual({ x: 240, y: 825 });
  });

  it('launch-settle: selector appears only after N snapshots → waits, then taps recorded point', async () => {
    settleAfterAttempts = 3; // root-only for 2 polls, then the full tree
    seedTemplate('t5', [{ idx: 0, action: 'tap', x: 236, y: 824, selector: { label: 'Terms & Conditions', type: 'Link' } }]);
    const runId = await play('t5');
    const steps = runRows(runId);
    expect(steps[0]!.status).toBe('pass');
    expect(ev(steps).resolvedBy).toBe('selector');
    expect(lastActInput?.target).toEqual({ x: 236, y: 824 });
    expect(snapshotAttempts).toBeGreaterThanOrEqual(4); // settle gate + step poll actually polled
  });

  it('cross-device: far scaled point + RECENTRE-UNSAFE container (scroll bar) → scaled coordinate fallback, never the wrapper center', async () => {
    // recorded on 428×926, played on the same fake 428×926 target but with a
    // template DIMS mismatch forcing scale: seed with 856×1852 (2×) so the
    // target/recorded ratio = 0.5 → recorded (236,824) scales to (118,412).
    // The old expectation here (recentre onto the scroll-bar container center)
    // encoded the DEFECT run_f5bdb387 exposed: wrapper centers are OTHER
    // controls. Recentre-unsafe → scaled coordinate fallback instead.
    seedTemplate('t6', [{ idx: 0, action: 'tap', x: 236, y: 824, selector: { label: 'Horizontal scroll bar, 1 page', type: 'Other' } }], { w: 856, h: 1852 });
    const runId = await play('t6');
    const steps = runRows(runId);
    expect(steps[0]!.status).toBe('pass');
    expect(ev(steps).resolvedBy).toBe('coordinate-fallback');
    expect(lastActInput?.target).toEqual({ x: 118, y: 412 }); // scaled recorded point, NOT the container center
  });
});
