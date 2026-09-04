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
let screen: 'onboarding' | 'account';
let dispatchLog: string[];
let alertInspectResult: { ok: true; result: { message?: string } } | { ok: false } | null;
let alertFromCall = 0; // 0 = always; N = appears on alloy_alert call >= N (async dialog sim)
let alertCallCount = 0;

/** ONBOARDING: 'Continue' visible. ACCOUNT: 'Privacy Policy' link. Tap on
 *  Continue transitions to account (the when-guarded setup step). */
const SCREENS = {
  onboarding: [
    { index: 0, parentIndex: -1, type: 'Application', label: 'App', rect: { x: 0, y: 0, width: 393, height: 852 }, hittable: false },
    { index: 1, parentIndex: 0, type: 'StaticText', label: 'Promo', rect: { x: 100, y: 380, width: 190, height: 40 }, hittable: true },
    { index: 2, parentIndex: 0, type: 'Button', label: 'Continue', rect: { x: 130, y: 760, width: 130, height: 44 }, hittable: true },
  ],
  account: [
    { index: 0, parentIndex: -1, type: 'Application', label: 'App', rect: { x: 0, y: 0, width: 393, height: 852 }, hittable: false },
    { index: 1, parentIndex: 0, type: 'Button', label: 'Privacy Policy', rect: { x: 20, y: 640, width: 200, height: 44 }, hittable: true },
  ],
} as const;

function fakeAlloy(): AlloyExports {
  return {
    createRuntime: async () => ({ state: {}, deps: null }),
    dispatch: async (tool: string, rawIn: unknown) => {
      dispatchLog.push(tool);
      if (tool === 'alloy_apps') return { ok: true, result: {} };
      if (tool === 'alloy_snapshot') return { ok: true, result: { nodes: SCREENS[screen], root: { rect: { width: 393, height: 852 } } } };
      if (tool === 'alloy_alert') {
        alertCallCount++;
        if (alertInspectResult && (alertFromCall === 0 || alertCallCount >= alertFromCall)) return alertInspectResult;
        // engine contract (probed live): no dialog → ok:false "alert not found"
        return { ok: false, error: { code: 'COMMAND_FAILED', message: 'alloy_alert: alert not found' } };
      }
      if (tool === 'alloy_act') {
        const i = rawIn as { action: string; label?: string };
        // tapping Continue (by target position or recorded point) advances
        const tgt = (i as { target?: { x: number; y: number } }).target;
        if (screen === 'onboarding' && (i.action === 'press') && tgt && tgt.y > 700) screen = 'account';
        return { ok: true, result: {} };
      }
      if (tool === 'alloy_screenshot') return { ok: true, result: { path: '/dev/null' } };
      return { ok: true, result: {} };
    },
  } as unknown as AlloyExports;
}

const bus = { emit: () => undefined } as never;

function seed(id: string, setup: unknown[] | null, steps: unknown[]): void {
  db.prepare(`INSERT INTO templates(id, name, ticket_key, udid, steps_json, setup_json, app_bundle_id, logical_w, logical_h, tags_json, created_by, created_at, updated_at)
              VALUES (?, ?, NULL, 'sim-1', ?, ?, NULL, 393, 852, '[]', 'qa', 0, 0)`)
    .run(id, id, JSON.stringify(steps), setup ? JSON.stringify(setup) : null);
}

async function play(id: string): Promise<string> {
  const r = await runTemplatePlayback({ db, bus, dispatchDeps: null, artifactsDir: tmp, forgeState: { activeRunId: null }, awaitStreamLive: async () => undefined, listApps: async () => [{ bundleId: 'com.x' }] } as never, id, {});
  await r.done;
  return r.runId;
}

function rows(runId: string): Array<{ idx: number; name: string; status: string; reason: string | null; flow: string | null }> {
  return db.prepare('SELECT idx, name, status, reason, flow_name AS flow FROM run_steps WHERE run_id = ? ORDER BY idx').all(runId) as never;
}

beforeEach(() => {
  process.env.CRUCIBLE_SETTLE_BUDGET_MS = '300';
  process.env.CRUCIBLE_SETTLE_POLL_MS = '50';
  process.env.CRUCIBLE_EXPECT_SETTLE_MS = '300';
  process.env.CRUCIBLE_EXPECT_POLL_MS = '50';
  process.env.CRUCIBLE_UI_STABLE_MS = '100';
  db = new Database(':memory:');
  migrateM1(db);
  tmp = mkdtempSync(join(tmpdir(), 'setup-'));
  dispatchLog = [];
  screen = 'onboarding';
  alertInspectResult = null;
  alertFromCall = 0;
  alertCallCount = 0;
  __setAlloyForTest(fakeAlloy());
});
afterEach(() => {
  delete process.env.CRUCIBLE_SETTLE_BUDGET_MS;
  delete process.env.CRUCIBLE_SETTLE_POLL_MS;
  delete process.env.CRUCIBLE_EXPECT_SETTLE_MS;
  delete process.env.CRUCIBLE_EXPECT_POLL_MS;
  delete process.env.CRUCIBLE_UI_STABLE_MS;
  __setAlloyForTest(null);
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('Task 2 — setup phase + when-guard execution', () => {
  it('when-shown → setup step runs (dismisses onboarding), main steps follow', async () => {
    seed('tpl_s1',
      [{ idx: 0, action: 'tap', x: 196, y: 780, selector: { label: 'Continue' }, when: 'Continue' }],
      [{ idx: 0, action: 'expect', selector: { label: 'Privacy Policy' } }]);
    const runId = await play('tpl_s1');
    const rs = rows(runId);
    expect(rs[0]!.flow).toBe('setup');
    expect(rs[0]!.status).toBe('pass');
    expect(rs[1]!.status).toBe('pass'); // expect resolves on account screen
    expect(db.prepare('SELECT status FROM runs WHERE id = ?').get(runId)).toMatchObject({ status: 'passed' });
  });

  it('when-not-shown → setup step is a no-op skip (already onboarded)', async () => {
    screen = 'account'; // onboarding already done
    seed('tpl_s2',
      [{ idx: 0, action: 'tap', x: 196, y: 780, selector: { label: 'Continue' }, when: 'Continue' }],
      [{ idx: 0, action: 'expect', selector: { label: 'Privacy Policy' } }]);
    const runId = await play('tpl_s2');
    const rs = rows(runId);
    expect(rs[0]!.status).toBe('skip');
    expect(rs[0]!.reason).toContain('when not shown');
    expect(rs[1]!.status).toBe('pass');
  });

  it('setup step failure fails the run', async () => {
    seed('tpl_s3',
      [{ idx: 0, action: 'expect', selector: { label: 'Never Present' } }],
      [{ idx: 0, action: 'expect', selector: { label: 'Privacy Policy' } }]);
    const runId = await play('tpl_s3');
    expect(db.prepare('SELECT status FROM runs WHERE id = ?').get(runId)).toMatchObject({ status: 'failed' });
    expect(rows(runId)[0]!.status).toBe('fail');
  });

  it('no setup column → behaves exactly as today (regression)', async () => {
    screen = 'account';
    seed('tpl_s4', null, [{ idx: 0, action: 'expect', selector: { label: 'Privacy Policy' } }]);
    const runId = await play('tpl_s4');
    const rs = rows(runId);
    expect(rs).toHaveLength(1);
    expect(rs[0]!.status).toBe('pass');
  });
});

describe('Task 3 — system-dialog interceptor', () => {
  it('run-start inspect sees a dialog → fail before any step, named', async () => {
    alertInspectResult = { ok: true, result: { message: 'Allow "Lion Parcel" to use your location?' } };
    seed('tpl_s5', null, [{ idx: 0, action: 'expect', selector: { label: 'Privacy Policy' } }]);
    const runId = await play('tpl_s5');
    const rs = rows(runId);
    expect(db.prepare('SELECT status FROM runs WHERE id = ?').get(runId)).toMatchObject({ status: 'failed' });
    const note = (db.prepare('SELECT note FROM runs WHERE id = ?').get(runId) as { note: string }).note;
    expect(note).toContain('blocked by system dialog');
    expect(note).toContain('location');
    expect(rs[0]!.status).toBe('skip');
    expect(rs[0]!.reason).toContain('blocked by system dialog');
  });

  it('inspect errors → fail-open (run proceeds under existing rules)', async () => {
    alertInspectResult = { ok: false };
    screen = 'account';
    seed('tpl_s6', null, [{ idx: 0, action: 'expect', selector: { label: 'Privacy Policy' } }]);
    const runId = await play('tpl_s6');
    expect(db.prepare('SELECT status FROM runs WHERE id = ?').get(runId)).toMatchObject({ status: 'passed' });
  });
});

describe('Task 3b — mid-run dialog correlation (trigger #2)', () => {
  it('async dialog (post run-start) + no-change tap → named fail at that step', async () => {
    screen = 'onboarding'; // never advances → taps are no-change
    seed('tpl_s7',
      [{ idx: 0, action: 'tap', x: 150, y: 390, selector: { label: 'Promo' } }, { idx: 1, action: 'tap', x: 160, y: 400, selector: { label: 'Promo' } }],
      [{ idx: 0, action: 'expect', selector: { label: 'Privacy Policy' } }]);
    // dialog materializes after the run-start inspect (call 1)
    alertInspectResult = { ok: true, result: { message: 'Allow "Lion Parcel" to use your location?' } };
    alertFromCall = 2;
    const r = await runTemplatePlayback({ db, bus, dispatchDeps: null, artifactsDir: tmp, forgeState: { activeRunId: null }, awaitStreamLive: async () => undefined, listApps: async () => [{ bundleId: 'com.x' }] } as never, 'tpl_s7', {});
    await r.done;
    const rs = rows(r.runId);
    expect(db.prepare('SELECT status FROM runs WHERE id = ?').get(r.runId)).toMatchObject({ status: 'failed' });
    const note = (db.prepare('SELECT note FROM runs WHERE id = ?').get(r.runId) as { note: string }).note;
    expect(note).toContain('blocked by system dialog');
    expect(note).toContain('location');
    expect(rs[0]!.status).toBe('fail');
    expect(rs[0]!.reason).toContain('blocked by system dialog');
    expect(rs[1]!.status).toBe('skip');
  });
});
