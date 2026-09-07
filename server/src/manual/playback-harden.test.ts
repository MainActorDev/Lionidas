/** Self-hardening coordinate steps (2026-09-07): a selector-less tap that
 *  passes captures the hit-tested node from the pre-tap snapshot and writes
 *  the selector BACK into the template — cases harden themselves by running.
 *  Bare coordinates stop being the runtime path after one green run. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTemplatePlayback } from './playback.ts';
import { migrateM1 } from '../db/schema.ts';
import { __setAlloyForTest } from '../alloy/client.ts';
import type { AlloyExports } from '../alloy/client.ts';

let db: Database.Database;
let tmp: string;

/** snapshot: root + a labeled button whose rect contains the tap point */
function nodesWithButton(btnLabel: string, bx: number, by: number, bw = 60, bh = 30) {
  return [
    { index: 0, parentIndex: -1, type: 'Application', label: 'App', rect: { x: 0, y: 0, width: 393, height: 852 }, hittable: false, ref: 'root' },
    { index: 1, parentIndex: 0, type: 'Button', label: btnLabel, rect: { x: bx, y: by, width: bw, height: bh }, hittable: true, ref: 'n1' },
  ];
}

function fakeAlloy(): AlloyExports {
  return {
    dispatch: async (tool: string) => {
      if (tool === 'alloy_snapshot') return { ok: true, result: { nodes: nodesWithButton('Sign Up', 100, 200) } };
      if (tool === 'alloy_screenshot') return { ok: true, result: { path: '/dev/null' } };
      return { ok: true, result: {} };
    },
  } as unknown as AlloyExports;
}

const bus = { emit: () => undefined } as never;

function seed(id: string, steps: unknown[]): void {
  db.prepare(`INSERT INTO templates(id, name, udid, steps_json, app_bundle_id, created_by, created_at, updated_at)
              VALUES (?, ?, 'sim', ?, NULL, 'qa', 0, 0)`).run(id, id, JSON.stringify(steps));
}

async function play(id: string): Promise<string> {
  const r = await runTemplatePlayback({ db, bus, dispatchDeps: null, artifactsDir: tmp, forgeState: { activeRunId: null }, awaitStreamLive: async () => undefined, listApps: async () => [] } as never, id, {});
  await r.done;
  return r.runId;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'harden-'));
  db = new Database(':memory:');
  migrateM1(db);
  process.env.CRUCIBLE_SETTLE_MS = '10';
  process.env.CRUCIBLE_SETTLE_POLL_MS = '5';
  process.env.CRUCIBLE_STEP_TIMEOUT_MS = '4000';
  __setAlloyForTest(fakeAlloy());
});
afterEach(() => {
  delete process.env.CRUCIBLE_SETTLE_MS;
  delete process.env.CRUCIBLE_SETTLE_POLL_MS;
  delete process.env.CRUCIBLE_STEP_TIMEOUT_MS;
  __setAlloyForTest(null);
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('self-hardening coordinate steps', () => {
  it('a passing bare-coordinate tap writes the captured selector back into the template', async () => {
    // tap INSIDE the Sign Up button's rect (100,200 60x30) with NO selector
    seed('t_harden', [{ idx: 0, action: 'tap', x: 130, y: 215 }]);
    const runId = await play('t_harden');
    const run = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string };
    expect(run.status).toBe('passed');
    // the template now carries the selector
    const row = db.prepare('SELECT steps_json FROM templates WHERE id = ?').get('t_harden') as { steps_json: string };
    const steps = JSON.parse(row.steps_json) as Array<{ action: string; selector?: { label?: string } }>;
    expect(steps[0]?.selector?.label).toBe('Sign Up');
  });

  it('no hit-test match (point on unlabeled chrome) → template unchanged, run still passes', async () => {
    // tap far from the button — no labeled node contains the point
    seed('t_noharden', [{ idx: 0, action: 'tap', x: 10, y: 700 }]);
    const runId = await play('t_noharden');
    const run = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string };
    expect(run.status).toBe('passed');
    const row = db.prepare('SELECT steps_json FROM templates WHERE id = ?').get('t_noharden') as { steps_json: string };
    const steps = JSON.parse(row.steps_json) as Array<{ selector?: unknown }>;
    expect(steps[0]?.selector).toBeUndefined();
  });

  it('the audit trail records the hardening', async () => {
    seed('t_audit', [{ idx: 0, action: 'tap', x: 130, y: 215 }]);
    const runId = await play('t_audit');
    const st = db.prepare('SELECT evaluated_json FROM run_steps WHERE run_id = ? AND idx = 0').get(runId) as { evaluated_json: string };
    const ev = JSON.parse(st.evaluated_json) as { hardened?: boolean; selector?: { label?: string } };
    expect(ev.hardened).toBe(true);
    expect(ev.selector?.label).toBe('Sign Up');
  });
});
