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
let dispatchLog: string[];
let snapshotNodes: SnapNode[];

const nodes = (labels: string[], opts: { hittable?: boolean; type?: string } = {}): SnapNode[] =>
  labels.map((label, i) => ({
    index: i, parentIndex: -1,
    type: opts.type ?? 'StaticText', label,
    rect: { x: 0, y: i * 10, width: 100, height: 10 },
    hittable: opts.hittable ?? true, ref: `n${i}`,
  }));

let allowAct = false;
function fakeAlloy(): AlloyExports {
  return {
    dispatch: async (tool: string) => {
      dispatchLog.push(tool);
      if (tool === 'alloy_apps') return { ok: true, result: {} };
      if (tool === 'alloy_snapshot') return { ok: true, result: { nodes: snapshotNodes, root: { rect: { width: 428, height: 926 } } } };
      if (tool === 'alloy_act') {
        if (!allowAct) throw new Error('expect must NEVER dispatch alloy_act');
        return { ok: true, result: {} };
      }
      if (tool === 'alloy_screenshot') return { ok: true, result: { path: '/dev/null' } };
      return { ok: true, result: {} };
    },
  } as unknown as AlloyExports;
}

const bus = { emit: () => undefined } as never;

function seedTemplate(id: string, steps: unknown[]): void {
  db.prepare(`INSERT INTO templates(id, name, ticket_key, udid, steps_json, app_bundle_id, logical_w, logical_h, tags_json, created_by, created_at, updated_at)
              VALUES (?, ?, NULL, 'sim-1', ?, NULL, 428, 926, '[]', 'qa', 0, 0)`).run(id, id, JSON.stringify(steps));
}

async function play(id: string): Promise<{ runId: string; done: Promise<void> }> {
  const r = await runTemplatePlayback({ db, bus, dispatchDeps: null, artifactsDir: tmp, forgeState: { activeRunId: null } } as never, id, {});
  await r.done;
  return r;
}

function runRows(runId: string): Array<{ idx: number; status: string; reason: string | null; evaluated_json: string | null; flow_name: string; name: string }> {
  return db.prepare('SELECT idx, status, reason, evaluated_json, flow_name, name FROM run_steps WHERE run_id = ? ORDER BY idx').all(runId) as never;
}

beforeEach(() => {
  // static fake hierarchies settle instantly — shrink the expect settle window
  process.env.CRUCIBLE_EXPECT_SETTLE_MS = '10';
  process.env.CRUCIBLE_EXPECT_POLL_MS = '5';
  tmp = mkdtempSync(join(tmpdir(), 'a7-'));
  db = new Database(':memory:');
  const { migrateM1 } = require('../src/db/schema.ts') as typeof import('../src/db/schema.ts');
  migrateM1(db);
  dispatchLog = [];
  allowAct = false;
  snapshotNodes = nodes(['Home', 'Login']);
  __setAlloyForTest(fakeAlloy());
});
afterEach(() => {
  delete process.env.CRUCIBLE_EXPECT_SETTLE_MS;
  delete process.env.CRUCIBLE_EXPECT_POLL_MS;
  __setAlloyForTest(null);
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('expect steps (A7)', () => {
  it('unique label match → pass, matched recorded', async () => {
    seedTemplate('t1', [{ idx: 0, action: 'expect', selector: { label: 'Login', type: 'StaticText' } }]);
    const { runId } = await play('t1');
    const steps = runRows(runId);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.status).toBe('pass');
    const ev = JSON.parse(steps[0]!.evaluated_json ?? '{}') as { expect?: { label?: string }; matched?: number };
    expect(ev.expect?.label).toBe('Login');
    expect(ev.matched).toBe(1);
    expect(dispatchLog).not.toContain('alloy_act');
  });

  it('absent label → hard fail with named selector, run failed', async () => {
    snapshotNodes = nodes(['Home']);
    seedTemplate('t2', [{ idx: 0, action: 'expect', selector: { label: 'Login' } }]);
    const { runId } = await play('t2');
    const steps = runRows(runId);
    expect(steps[0]!.status).toBe('fail');
    expect(steps[0]!.reason).toContain('not found');
    expect(steps[0]!.reason).toContain('Login');
    const run = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string };
    expect(run.status).toBe('failed');
  });

  it('ambiguous (2 matches) → hard fail "ambiguous"', async () => {
    snapshotNodes = nodes(['Login', 'Login']);
    seedTemplate('t3', [{ idx: 0, action: 'expect', selector: { label: 'Login' } }]);
    const { runId } = await play('t3');
    const steps = runRows(runId);
    expect(steps[0]!.status).toBe('fail');
    expect(steps[0]!.reason).toContain('ambiguous');
    expect(steps[0]!.reason).toContain('2');
  });

  it('optional expect miss → skip, run stays green', async () => {
    snapshotNodes = nodes(['Home']);
    seedTemplate('t4', [{ idx: 0, action: 'expect', selector: { label: 'Login' }, optional: true }]);
    const { runId } = await play('t4');
    const steps = runRows(runId);
    expect(steps[0]!.status).toBe('skip');
    expect(steps[0]!.reason).toContain('optional');
    const run = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string };
    expect(run.status).toBe('passed');
  });

  it('counts NON-HITTABLE text (predicate, not tap pool)', async () => {
    snapshotNodes = nodes(['Welcome'], { hittable: false });
    seedTemplate('t5', [{ idx: 0, action: 'expect', selector: { label: 'Welcome' } }]);
    const { runId } = await play('t5');
    expect(runRows(runId)[0]!.status).toBe('pass');
  });

  it('expect after action: fails red blocks later steps; in subflow keeps flow provenance', async () => {
    allowAct = true; // this test's scroll step must dispatch
    snapshotNodes = nodes(['Home']);
    seedTemplate('child', [{ idx: 0, action: 'expect', selector: { label: 'Vanished' } }]);
    seedTemplate('parent', [
      { idx: 0, action: 'scroll', direction: 'down' },
      { idx: 1, action: 'runFlow', templateId: 'child' },
    ]);
    const { runId } = await play('parent');
    const steps = runRows(runId);
    // scroll pass (dispatched via alloy_act — allowed here), then child expect fails under child flow name
    expect(steps[0]!.status).toBe('pass');
    expect(steps[1]!.flow_name ?? steps[1]!.name).toBeTruthy();
    const expectRow = steps.find((s) => s.reason?.includes('not found'));
    expect(expectRow).toBeTruthy();
    expect(expectRow!.status).toBe('fail');
    expect(dispatchLog).toContain('alloy_act'); // the scroll dispatched
  });
});
