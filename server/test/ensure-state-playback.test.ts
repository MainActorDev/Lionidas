/** ensure state playback executor (phase A S3): the convergence loop —
 *  probe → recipe → verify with honest, named failures on every branch,
 *  and the {stateId, revision, path} audit that Phase-B provenance rides on.
 *  Mini app model: 'Get Started' tap transitions onboarding → home where
 *  the 'Hi, Dev' session text appears (the logged_in probe/verify target). */
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
/** 'onboarding' | 'home' — the fake app's current screen */
let world: 'onboarding' | 'home';
let appsCalls: Array<Record<string, unknown>>;
let tapLog: string[];

const NODE = (index: number, parentIndex: number, type: string, label: string, y: number) =>
  ({ index, parentIndex, type, label, rect: { x: 10, y, width: 200, height: 40 }, hittable: true, ref: `n${index}` });

const TREES = {
  onboarding: [
    { index: 0, parentIndex: -1, type: 'Application', label: 'App', rect: { x: 0, y: 0, width: 393, height: 852 }, hittable: false, ref: 'root' },
    NODE(1, 0, 'StaticText', 'Promo', 300),
    NODE(2, 0, 'Button', 'Get Started', 700),
  ],
  home: [
    { index: 0, parentIndex: -1, type: 'Application', label: 'App', rect: { x: 0, y: 0, width: 393, height: 852 }, hittable: false, ref: 'root' },
    NODE(1, 0, 'StaticText', 'Home', 100),
    NODE(2, 0, 'StaticText', 'Hi, Dev', 150),
  ],
} as const;

function fakeAlloy(): AlloyExports {
  return {
    dispatch: async (tool: string, rawIn: unknown) => {
      if (tool === 'alloy_snapshot') return { ok: true, result: { nodes: TREES[world] } };
      if (tool === 'alloy_apps') { appsCalls.push(rawIn as Record<string, unknown>); return { ok: true, result: {} }; }
      if (tool === 'alloy_act') {
        const input = rawIn as { action: string; target?: { x: number; y: number } };
        if (input.action === 'press' && input.target && Math.abs(input.target.y - 720) < 60) {
          // the Get Started button (y=700, h=40 → center 720): transition
          world = 'home';
          tapLog.push('get-started');
        }
        return { ok: true, result: {} };
      }
      return { ok: true, result: {} };
    },
  } as unknown as AlloyExports;
}

const BUNDLE = 'com.example.foodiary';

function seedState(stateId: string, probe: unknown, recipe: unknown, verify: unknown, bundle = BUNDLE): void {
  db.prepare('INSERT INTO app_states(id, app_bundle_id, state_id, label, probe_json, recipe_json, verify_json, provenance, revision, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, \'user\', 3, \'qa\', 0, 0)')
    .run(`st_${stateId}`, bundle, stateId, stateId, JSON.stringify(probe), JSON.stringify(recipe), JSON.stringify(verify));
}

function seedTemplate(id: string, steps: unknown[], appBundle: string | null): void {
  db.prepare(`INSERT INTO templates(id, name, udid, steps_json, app_bundle_id, created_by, created_at, updated_at) VALUES (?, ?, 'sim', ?, ?, 'qa', 0, 0)`)
    .run(id, id, JSON.stringify(steps), appBundle);
  db.prepare(`INSERT INTO devices(udid, name, state, platform, kind, last_seen) VALUES ('sim', 'Sim', 'Booted', 'ios', 'simulator', 0)
              ON CONFLICT(udid) DO UPDATE SET state = 'Booted'`).run();
}

async function play(id: string): Promise<{ runId: string }> {
  const bus = { emit: () => undefined } as never;
  const r = await runTemplatePlayback({ db, bus, dispatchDeps: null, artifactsDir: tmp, forgeState: { activeRunId: null }, awaitStreamLive: null } as never, id, {});
  await r.done;
  return r;
}

function stepRows(runId: string): Array<{ idx: number; name: string; status: string; reason: string | null; evaluated_json: string | null }> {
  return db.prepare('SELECT idx, name, status, reason, evaluated_json FROM run_steps WHERE run_id = ? ORDER BY idx').all(runId) as never;
}
function runStatus(runId: string): string {
  return (db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status: string }).status;
}
function audit(runId: string, idx = 0): Record<string, unknown> {
  const r = stepRows(runId).find((x) => x.idx === idx);
  return r?.evaluated_json ? (JSON.parse(r.evaluated_json) as Record<string, unknown>) : {};
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'es3-'));
  db = new Database(':memory:');
  migrateM1(db);
  world = 'onboarding';
  appsCalls = [];
  tapLog = [];
  __setAlloyForTest(fakeAlloy());
});
afterEach(() => {
  __setAlloyForTest(null);
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('ensure state executor — convergence branches', () => {
  it('probe-hit: already in state → narrated no-op pass, path=probe-hit, recipe NOT played', async () => {
    world = 'home';
    seedState('logged_in', { label: 'Hi, Dev' }, { steps: [{ tap: { on: 'Get Started' } }] }, { label: 'Hi, Dev' });
    seedTemplate('tpl_hit', [{ idx: 0, action: 'ensureState', ensureState: 'logged_in' }, { idx: 1, action: 'expect', selector: { label: 'Home' } }], BUNDLE);
    const { runId } = await play('tpl_hit');
    const steps = stepRows(runId);
    expect(steps[0]?.status).toBe('pass');
    expect(steps[0]?.reason).toMatch(/probe hit/);
    expect(tapLog).toEqual([]); // no recipe taps
    expect(audit(runId)).toMatchObject({ action: 'ensureState', stateId: 'logged_in', revision: 3, path: 'probe-hit' });
    expect(runStatus(runId)).toBe('passed');
  });

  it('probe-miss → walk → verify: converges, path=recipe, stepsPlayed counted, audit carries revision', async () => {
    seedState('logged_in', { label: 'Hi, Dev' }, { steps: [{ tap: { on: 'Get Started' } }] }, { label: 'Hi, Dev' });
    seedTemplate('tpl_conv', [{ idx: 0, action: 'ensureState', ensureState: 'logged_in' }], BUNDLE);
    const { runId } = await play('tpl_conv');
    const steps = stepRows(runId);
    expect(steps[0]?.status).toBe('pass');
    expect(steps[0]?.reason).toMatch(/probe miss.*recipe 1 step/);
    expect(tapLog).toEqual(['get-started']);
    expect(audit(runId)).toMatchObject({ stateId: 'logged_in', revision: 3, path: 'recipe', stepsPlayed: 1 });
  });

  it('recipe step fails mid-walk → named step failure, rest skipped, run failed', async () => {
    seedState('logged_in', { label: 'Hi, Dev' }, { steps: [{ tap: { on: 'Not Anywhere' } }] }, { label: 'Hi, Dev' });
    seedTemplate('tpl_walkfail', [
      { idx: 0, action: 'ensureState', ensureState: 'logged_in' },
      { idx: 1, action: 'expect', selector: { label: 'Never' } },
    ], BUNDLE);
    const { runId } = await play('tpl_walkfail');
    const steps = stepRows(runId);
    expect(steps[0]?.status).toBe('fail');
    expect(steps[0]?.reason).toMatch(/recipe step failed.*Not Anywhere/);
    expect(steps[1]).toMatchObject({ status: 'skip', reason: 'not reached' });
    expect(runStatus(runId)).toBe('failed');
  });

  it('verify fail: walk ran but the state never held → honest named failure', async () => {
    // the walk succeeds but lands a world where verify's target is absent
    seedState('logged_in', { label: 'Hi, Dev' }, { steps: [{ tap: { on: 'Get Started' } }] }, { label: 'Not This Text' });
    seedTemplate('tpl_vfail', [{ idx: 0, action: 'ensureState', ensureState: 'logged_in' }], BUNDLE);
    const { runId } = await play('tpl_vfail');
    const steps = stepRows(runId);
    expect(steps[0]?.status).toBe('fail');
    expect(steps[0]?.reason).toMatch(/verify never held/);
    expect(audit(runId)).toMatchObject({ path: 'verify' });
    expect(runStatus(runId)).toBe('failed');
  });

  it('missing state → explicit failure naming state AND bundle, pointing at the app states page (edge 3/7)', async () => {
    seedTemplate('tpl_missing', [{ idx: 0, action: 'ensureState', ensureState: 'fresh_install' }], BUNDLE);
    const { runId } = await play('tpl_missing');
    const steps = stepRows(runId);
    expect(steps[0]?.status).toBe('fail');
    expect(steps[0]?.reason).toMatch(/"fresh_install" is not registered for com.example.foodiary.*app states page/);
  });

  it('wrong-bundle registration does not leak: state on bundle A, case on bundle B → not-registered names B', async () => {
    seedState('logged_in', { label: 'Hi, Dev' }, { steps: [{ tap: { on: 'Get Started' } }] }, { label: 'Hi, Dev' }, 'com.other.app');
    seedTemplate('tpl_wrongb', [{ idx: 0, action: 'ensureState', ensureState: 'logged_in' }], BUNDLE);
    const { runId } = await play('tpl_wrongb');
    expect(stepRows(runId)[0]?.reason).toMatch(/"logged_in" is not registered for com.example.foodiary/);
  });

  it('relaunch actuator: open keeps -uitest-live-refresh + recipe launchArgs, then verify holds', async () => {
    // relaunch flips the fake world back to onboarding, then the verify text
    // lives on home — use probe home-then-verify-home shape: probe absent
    // (world onboarding), relaunch, verify... relaunch leaves world as-is;
    // simplest: verify a label present in BOTH trees after relaunch settles
    seedState('launched_with_flag', { label: 'Nowhere At All' }, { actuator: 'relaunch', launchArgs: ['--reset-onboarding'] }, { label: 'Promo' });
    seedTemplate('tpl_rel', [{ idx: 0, action: 'ensureState', ensureState: 'launched_with_flag' }], BUNDLE);
    const { runId } = await play('tpl_rel');
    const steps = stepRows(runId);
    expect(steps[0]?.status).toBe('pass');
    const opens = appsCalls.filter((c) => c['action'] === 'open');
    const open = opens[opens.length - 1];
    expect(open).toMatchObject({ app: BUNDLE });
    expect(open?.['launchArgs']).toEqual(['-uitest-live-refresh', '--reset-onboarding']);
    expect(audit(runId)).toMatchObject({ path: 'recipe', stepsPlayed: 0 });
  });

  it('S4-pending actuators fail loud with STATE_ACTUATOR_PENDING (never silent pass)', async () => {
    seedState('fresh', { label: 'Hi, Dev' }, { actuator: 'uninstallReinstall' }, { label: 'Hi, Dev' });
    seedTemplate('tpl_s4', [{ idx: 0, action: 'ensureState', ensureState: 'fresh' }], BUNDLE);
    const { runId } = await play('tpl_s4');
    expect(stepRows(runId)[0]?.reason).toMatch(/STATE_ACTUATOR_PENDING.*uninstallReinstall/);
    expect(runStatus(runId)).toBe('failed');
  });

  it('screen-form probe/verify: a bare screen ref asserts the registry state; dotted screen.state names it', async () => {
    db.prepare('INSERT INTO app_screens(app_bundle_id, screen_id, entry_json, states_json, updated_at, revision) VALUES (?, ?, ?, ?, 0, 1)')
      .run(BUNDLE, 'home', JSON.stringify({ deepLink: 'x://h' }), JSON.stringify({ landed: { all: [{ label: 'Hi, Dev' }] } }));
    world = 'home';
    // bare screen ref → FIRST state ('landed') holds on home
    seedState('on_home', { screen: 'home' }, { steps: [{ tap: { on: 'Get Started' } }] }, { screen: 'home.landed' });
    seedTemplate('tpl_scr', [{ idx: 0, action: 'ensureState', ensureState: 'on_home' }], BUNDLE);
    const { runId } = await play('tpl_scr');
    expect(stepRows(runId)[0]?.status).toBe('pass');
    expect(audit(runId)).toMatchObject({ path: 'probe-hit' });
    // dotted ref to a state that does NOT hold → probe misses (world reset:
    // the first scenario left the fake app on home)
    world = 'onboarding';
    seedState('on_home_named', { screen: 'home.absent_state' }, { steps: [{ tap: { on: 'Get Started' } }] }, { screen: 'home.landed' });
    seedTemplate('tpl_scr2', [{ idx: 0, action: 'ensureState', ensureState: 'on_home_named' }], BUNDLE);
    const r2 = await play('tpl_scr2');
    // probe misses (absent_state undefined) → walk taps Get Started → verify home.landed holds → converge
    expect(stepRows(r2.runId)[0]?.status).toBe('pass');
    expect(audit(r2.runId)).toMatchObject({ path: 'recipe' });
  });

  it('walk steps expand ${env.X} through the run env; a missing ref fails the recipe honestly', async () => {
    db.prepare("INSERT INTO templates(id, name, udid, steps_json, app_bundle_id, created_by, created_at, updated_at) VALUES ('tpl_env', 'tpl_env', 'sim', ?, 'com.example.foodiary', 'qa', 0, 0)")
      .run(JSON.stringify([{ idx: 0, action: 'ensureState', ensureState: 'typed' }]));
    seedState('typed', { label: 'Hi, Dev' }, { steps: [{ type: { text: '${env.MISSING_ONE}', on: 'Get Started' } }] }, { label: 'Hi, Dev' });
    const bus = { emit: () => undefined } as never;
    const r = await runTemplatePlayback({ db, bus, dispatchDeps: null, artifactsDir: tmp, forgeState: { activeRunId: null }, awaitStreamLive: null } as never, 'tpl_env', {});
    await r.done;
    expect(stepRows(r.runId)[0]?.reason).toMatch(/env var that is not set/);
  });
});
