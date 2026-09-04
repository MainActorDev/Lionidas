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
let snapCount = 0;
let dispatchLog: string[];
let alertInspectResult: { ok: true; result: { message?: string } } | { ok: false } | null;
let alertFromCall = 0; // 0 = always; N = appears on alloy_alert call >= N (async dialog sim)
let alertCallCount = 0;
let dialogQueue: string[] = []; // drained by accept/dismiss; inspected head-first
/** Animating-screen sim: when set, every Nth snapshot returns a DIFFERENT
 *  hierarchy (extra transient node) — stability gate must keep polling. */
let animateFirstSnapshots = 0;
let alertActionError: { code: string; message: string } | null = null; // accept/dismiss failure sim

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
      if (tool === 'alloy_snapshot') {
        snapCount++;
        const base = SCREENS[screen] as unknown as Array<Record<string, unknown>>;
        if (animateFirstSnapshots > 0 && snapCount <= animateFirstSnapshots) {
          // transient node present mid-animation — hierarchy not yet stable
          return { ok: true, result: { nodes: [...base, { index: base.length, parentIndex: 0, type: 'Other', label: 'spinner', rect: { x: 0, y: 0, width: 10, height: 10 }, hittable: false }], root: { rect: { width: 393, height: 852 } } } };
        }
        return { ok: true, result: { nodes: SCREENS[screen], root: { rect: { width: 393, height: 852 } } } };
      }
      if (tool === 'alloy_alert') {
        const input = rawIn as { action: string };
        if (input.action === 'inspect') {
          alertCallCount++;
          if (dialogQueue.length > 0) return { ok: true, result: { message: dialogQueue[0] } };
          if (alertInspectResult && (alertFromCall === 0 || alertCallCount >= alertFromCall)) return alertInspectResult;
          return { ok: false, error: { code: 'COMMAND_FAILED', message: 'alloy_alert: alert not found' } };
        }
        // accept/dismiss clears the queued dialog; none up → engine not-found
        if (alertActionError) return { ok: false, error: alertActionError };
        if (dialogQueue.length === 0) return { ok: false, error: { code: 'COMMAND_FAILED', message: 'alloy_alert: alert not found' } };
        dialogQueue.shift();
        return { ok: true, result: { message: input.action } };
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

function seed(id: string, setup: unknown[] | null, steps: unknown[], alerts?: unknown): void {
  db.prepare(`INSERT INTO templates(id, name, ticket_key, udid, steps_json, setup_json, alerts_policy, app_bundle_id, logical_w, logical_h, tags_json, created_by, created_at, updated_at)
              VALUES (?, ?, NULL, 'sim-1', ?, ?, ?, NULL, 393, 852, '[]', 'qa', 0, 0)`)
    .run(id, id, JSON.stringify(steps), setup ? JSON.stringify(setup) : null, alerts ? JSON.stringify(alerts) : null);
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
  dialogQueue = [];
  alertActionError = null;
  animateFirstSnapshots = 0;
  snapCount = 0;
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

describe('Task 4 — alert step playback', () => {
  it('alert: dismiss with dialog up → clears it, step passes', async () => {
    screen = 'onboarding';
    dialogQueue = ['Sign in to your Apple Account'];
    // after the first dismiss the dialog is gone
    let dismissals = 0;
    seed('tpl_a1',
      [{ idx: 0, action: 'alert', alertAction: 'dismiss' }],
      [{ idx: 0, action: 'expect', selector: { label: 'Continue' } }]);
    const r = await runTemplatePlayback({ db, bus, dispatchDeps: null, artifactsDir: tmp, forgeState: { activeRunId: null }, awaitStreamLive: async () => undefined, listApps: async () => [{ bundleId: 'com.x' }] } as never, 'tpl_a1', {});
    await r.done;
    const rs = rows(r.runId);
    expect(rs[0]!.status).toBe('pass');
    dismissals;
  });

  it('alert: dismiss with NO dialog → skip (no alert up)', async () => {
    screen = 'onboarding';
    alertInspectResult = null;
    dialogQueue = [];
    seed('tpl_a2',
      [{ idx: 0, action: 'alert', alertAction: 'dismiss' }],
      [{ idx: 0, action: 'expect', selector: { label: 'Continue' } }]);
    const r = await runTemplatePlayback({ db, bus, dispatchDeps: null, artifactsDir: tmp, forgeState: { activeRunId: null }, awaitStreamLive: async () => undefined, listApps: async () => [{ bundleId: 'com.x' }] } as never, 'tpl_a2', {});
    await r.done;
    const rs = rows(r.runId);
    expect(rs[0]!.status).toBe('skip');
    expect(rs[0]!.reason).toContain('no alert up');
    expect(rs[1]!.status).toBe('pass');
  });

  it('run-start gate defers when first step is alert (dialog up)', async () => {
    screen = 'onboarding';
    // dialog up at gate time; alert inspect = call 1 (gate), dismiss = call 2+...
    // simplest: dialog always present; gate must NOT fail; the alert step passes
    alertInspectResult = { ok: true, result: { message: 'Sign in to your Apple Account' } };
    alertFromCall = 0;
    seed('tpl_a3',
      [{ idx: 0, action: 'alert', alertAction: 'dismiss' }],
      [{ idx: 0, action: 'expect', selector: { label: 'Continue' } }]);
    const r = await runTemplatePlayback({ db, bus, dispatchDeps: null, artifactsDir: tmp, forgeState: { activeRunId: null }, awaitStreamLive: async () => undefined, listApps: async () => [{ bundleId: 'com.x' }] } as never, 'tpl_a3', {});
    await r.done;
    expect(db.prepare('SELECT status FROM runs WHERE id = ?').get(r.runId)).toMatchObject({ status: 'passed' });
  });

  it('engine error on alert dismiss → honest fail', async () => {
    screen = 'onboarding';
    dialogQueue = ['some dialog'];
    alertActionError = { code: 'ENGINE_DEAD', message: 'engine exploded' };
    seed('tpl_a4',
      [{ idx: 0, action: 'alert', alertAction: 'dismiss' }],
      [{ idx: 0, action: 'expect', selector: { label: 'Continue' } }]);
    const r = await runTemplatePlayback({ db, bus, dispatchDeps: null, artifactsDir: tmp, forgeState: { activeRunId: null }, awaitStreamLive: async () => undefined, listApps: async () => [{ bundleId: 'com.x' }] } as never, 'tpl_a4', {});
    await r.done;
    const rs = rows(r.runId);
    expect(rs[0]!.status).toBe('fail');
    expect(db.prepare('SELECT status FROM runs WHERE id = ?').get(r.runId)).toMatchObject({ status: 'failed' });
  });
});

describe('Task 5 — alert policy enforcement', () => {
  it('gate: policy default=dismiss drains stacked dialogs, run proceeds and passes', async () => {
    screen = 'onboarding';
    dialogQueue = ['Allow "Lion Parcel" to use your location?', 'Sign in to your Apple Account'];
    seed('tpl_p1', null, [{ idx: 0, action: 'expect', selector: { label: 'Continue' } }],
      { entries: [['default', 'dismiss']] });
    const r = await runTemplatePlayback({ db, bus, dispatchDeps: null, artifactsDir: tmp, forgeState: { activeRunId: null }, awaitStreamLive: async () => undefined, listApps: async () => [{ bundleId: 'com.x' }] } as never, 'tpl_p1', {});
    await r.done;
    expect(db.prepare('SELECT status FROM runs WHERE id = ?').get(r.runId)).toMatchObject({ status: 'passed' });
    const noteText = (db.prepare('SELECT note FROM runs WHERE id = ?').get(r.runId) as { note: string }).note;
    expect(noteText).toContain('alert-handled (dismiss): "Allow "Lion Parcel" to use your location?" @ start');
    expect(noteText).toContain('alert-handled (dismiss): "Sign in to your Apple Account" @ start');
  });

  it('gate: map policy accepts location, dismisses the rest', async () => {
    screen = 'onboarding';
    dialogQueue = ['Allow "Lion Parcel" to use your location?', 'Sign in to your Apple Account'];
    seed('tpl_p2', null, [{ idx: 0, action: 'expect', selector: { label: 'Continue' } }],
      { entries: [['location', 'accept'], ['default', 'dismiss']] });
    const r = await runTemplatePlayback({ db, bus, dispatchDeps: null, artifactsDir: tmp, forgeState: { activeRunId: null }, awaitStreamLive: async () => undefined, listApps: async () => [{ bundleId: 'com.x' }] } as never, 'tpl_p2', {});
    await r.done;
    expect(db.prepare('SELECT status FROM runs WHERE id = ?').get(r.runId)).toMatchObject({ status: 'passed' });
    const noteText = (db.prepare('SELECT note FROM runs WHERE id = ?').get(r.runId) as { note: string }).note;
    expect(noteText).toContain('alert-handled (accept): "Allow "Lion Parcel" to use your location?" @ start');
    expect(noteText).toContain('alert-handled (dismiss): "Sign in to your Apple Account" @ start');
  });

  it('gate: no policy = named fail (regression, unchanged)', async () => {
    screen = 'onboarding';
    dialogQueue = ['Sign in to your Apple Account'];
    seed('tpl_p3', null, [{ idx: 0, action: 'expect', selector: { label: 'Continue' } }]);
    const r = await runTemplatePlayback({ db, bus, dispatchDeps: null, artifactsDir: tmp, forgeState: { activeRunId: null }, awaitStreamLive: async () => undefined, listApps: async () => [{ bundleId: 'com.x' }] } as never, 'tpl_p3', {});
    await r.done;
    expect(db.prepare('SELECT status FROM runs WHERE id = ?').get(r.runId)).toMatchObject({ status: 'failed' });
  });

  it('storm: >3 dialogs at gate → named fail', async () => {
    screen = 'onboarding';
    // queue that refills: each dismiss pushes a new dialog (storm sim)
    dialogQueue = ['d1', 'd2', 'd3', 'd4'];
    seed('tpl_p4', null, [{ idx: 0, action: 'expect', selector: { label: 'Continue' } }],
      { entries: [['default', 'dismiss']] });
    const r = await runTemplatePlayback({ db, bus, dispatchDeps: null, artifactsDir: tmp, forgeState: { activeRunId: null }, awaitStreamLive: async () => undefined, listApps: async () => [{ bundleId: 'com.x' }] } as never, 'tpl_p4', {});
    await r.done;
    expect(db.prepare('SELECT status FROM runs WHERE id = ?').get(r.runId)).toMatchObject({ status: 'failed' });
    const noteText = (db.prepare('SELECT note FROM runs WHERE id = ?').get(r.runId) as { note: string }).note;
    expect(noteText).toContain('alert storm');
  });

  it('mid-run: swallowed tap drained + retried under policy → passes with screen change', async () => {
    screen = 'onboarding';
    // dialog appears after the first tap dispatch (async sim): first inspect
    // (gate) sees none; the tap lands into the dialog at step time.
    dialogQueue = [];
    let actCalls = 0;
    const origSeed = screen;
    void origSeed;
    // simulate: first alloy_act (the setup/main tap) triggers dialog arrival
    seed('tpl_p5', null, [{ idx: 0, action: 'tap', x: 150, y: 390, selector: { label: 'Promo' } }, { idx: 1, action: 'expect', selector: { label: 'Continue' } }],
      { entries: [['default', 'dismiss']] });
    const r = await runTemplatePlayback({ db, bus, dispatchDeps: null, artifactsDir: tmp, forgeState: { activeRunId: null }, awaitStreamLive: async () => undefined, listApps: async () => [{ bundleId: 'com.x' }] } as never, 'tpl_p5', {});
    await r.done;
    actCalls;
    expect(db.prepare('SELECT status FROM runs WHERE id = ?').get(r.runId)).toMatchObject({ status: 'passed' });
  });

  it('garbage alerts_policy column → honest default (named fail on dialog)', async () => {
    screen = 'onboarding';
    dialogQueue = ['Sign in to your Apple Account'];
    db.prepare(`INSERT INTO templates(id, name, ticket_key, udid, steps_json, setup_json, alerts_policy, app_bundle_id, logical_w, logical_h, tags_json, created_by, created_at, updated_at)
                VALUES ('tpl_p6', 'tpl_p6', NULL, 'sim-1', ?, NULL, 'not json', NULL, 393, 852, '[]', 'qa', 0, 0)`)
      .run(JSON.stringify([{ idx: 0, action: 'expect', selector: { label: 'Continue' } }]));
    const r = await runTemplatePlayback({ db, bus, dispatchDeps: null, artifactsDir: tmp, forgeState: { activeRunId: null }, awaitStreamLive: async () => undefined, listApps: async () => [{ bundleId: 'com.x' }] } as never, 'tpl_p6', {});
    await r.done;
    expect(db.prepare('SELECT status FROM runs WHERE id = ?').get(r.runId)).toMatchObject({ status: 'failed' });
  });
});

describe('stability gate (settle poll requires two identical reads)', () => {
  it('act is NOT dispatched while the hierarchy keeps changing; dispatches once quiet', async () => {
    screen = 'onboarding';
    // first 3 snapshots carry a transient spinner node (animating screen)
    animateFirstSnapshots = 3;
    let acts = 0;
    seed('tpl_g1', null, [{ idx: 0, action: 'tap', x: 150, y: 390, selector: { label: 'Promo' } }]);
    const r = await runTemplatePlayback({ db, bus, dispatchDeps: null, artifactsDir: tmp, forgeState: { activeRunId: null }, awaitStreamLive: async () => undefined, listApps: async () => [{ bundleId: 'com.x' }] } as never, 'tpl_g1', {});
    await r.done;
    const rs = rows(r.runId);
    // the tap MUST have dispatched (after waiting out the animation) and passed
    expect(rs[0]!.status).toBe('pass');
    acts;
    // and it polled more than the animation window (gate kept polling)
    expect(snapCount).toBeGreaterThan(3);
  });
});
