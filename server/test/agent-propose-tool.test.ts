/** Phase B S2 — the states.propose agent tool: deterministic drafts from green
 *  runs (probe/verify = final passing expect; recipe = the run's own walk or a
 *  deep copy of the ensureState walk it rode), refusal guards (failed runs,
 *  expect-less runs, prove-but-don't-walk, registry collisions, unnamed
 *  states), and idempotency through the shared insert core. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrateM1 } from '../src/db/schema.ts';

let db: Database.Database;
let tmp: string;

const B = 'com.example.foodiary';
const UDID = 'SIM-UDID-1';

interface Step { idx: number; action: string; selector?: Record<string, unknown>; ensureState?: string; on?: string; [k: string]: unknown }

function seedTemplate(id: string, steps: Step[], setup: Array<Record<string, unknown>> = [], bundle = B): void {
  db.prepare('INSERT INTO templates(id, name, ticket_key, udid, steps_json, setup_json, alerts_policy, app_bundle_id, logical_w, logical_h, tags_json, created_by, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, NULL, ?, 393, 852, \'[]\', \'qa\', 0, 0)')
    .run(id, id, UDID, JSON.stringify(steps), setup.length ? JSON.stringify(setup) : null, bundle);
}

function seedRun(id: string, tplId: string, status: string, steps: Array<{ name: string; status: string; ev?: unknown }>): void {
  db.prepare("INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, template_id, started_at, finished_at) VALUES (?, 'T-1', 'automated', ?, 'qa', ?, ?, 1, 2)").run(id, status, UDID, tplId);
  const ins = db.prepare('INSERT INTO run_steps(run_id, idx, flow_name, kind, name, status, evaluated_json) VALUES (?, ?, ?, ?, ?, ?, ?)');
  steps.forEach((s, i) => ins.run(id, i, 'f', 'step', s.name, s.status, s.ev === undefined ? null : JSON.stringify(s.ev)));
}

function seedRegistryState(stateId: string, recipe: Record<string, unknown>, rev = 1): void {
  const id = `st_${stateId}`;
  db.prepare("INSERT INTO app_states(id, app_bundle_id, state_id, label, probe_json, recipe_json, verify_json, provenance, revision, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'user', ?, 'qa', 0, 0)")
    .run(id, B, stateId, stateId, JSON.stringify({ identifier: 'x' }), JSON.stringify(recipe), JSON.stringify({ identifier: 'x' }), rev);
}

async function call(name: string, args: Record<string, unknown>): Promise<string> {
  const { buildToolRegistry } = await import('../src/agent/tools.ts');
  const storage = { run: () => undefined, get: () => undefined } as never;
  const retriever = { retrieve: async () => [] } as never;
  const r = buildToolRegistry({ db, storage, retriever, artifactsDir: tmp });
  const tool = (r as unknown as { list: () => Array<{ name: string; execute: (a: Record<string, unknown>) => Promise<string> }> }).list().find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return tool.execute(args);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 's2-propose-'));
  db = new Database(':memory:');
  migrateM1(db);
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const SEL = { identifier: 'profile_setup_next_button' };
const WALK = { idx: 0, action: 'tap', selector: { identifier: 'welcome_get_started_button' } };
const EXPECT = { idx: 1, action: 'expect', selector: SEL };

function greenWalkRun(): void {
  seedTemplate('tpl_walk', [WALK, EXPECT]);
  seedRun('run_green', 'tpl_walk', 'passed', [
    { name: 'tap', status: 'pass', ev: { action: 'tap', on: 'welcome_get_started_button' } },
    { name: 'expect', status: 'pass', ev: { action: 'expect', selector: SEL } },
  ]);
}

describe('states.propose — drafts', () => {
  it('drafts probe/verify from the final expect, recipe from the case walk, into an open proposal', async () => {
    greenWalkRun();
    const raw = await call('states.propose', { runId: 'run_green', stateId: 'on_profile_setup', label: 'Profile setup' });
    const out = JSON.parse(raw) as { proposal: { stateId: string; label: string; probe: unknown; recipe: unknown; verify: unknown; status: string; sourceRunId: string; createdBy: string }, deduped: boolean };
    expect(out.deduped).toBe(false);
    expect(out.proposal.stateId).toBe('on_profile_setup');
    expect(out.proposal.label).toBe('Profile setup');
    expect(out.proposal.probe).toEqual(SEL);
    expect(out.proposal.verify).toEqual(SEL);
    expect(out.proposal.recipe).toEqual({ steps: [{ tap: { on: 'welcome_get_started_button' } }] }); // compact grammar form
    expect(out.proposal.status).toBe('open');
    expect(out.proposal.sourceRunId).toBe('run_green');
    expect(out.proposal.createdBy).toBe('agent');
    const row = db.prepare('SELECT rationale FROM state_proposals').get() as { rationale: string };
    expect(row.rationale).toContain('run_green');
    expect(row.rationale).toContain('grammar-expressible step');
  });

  it('is idempotent — the second call dedupes to the same open proposal', async () => {
    greenWalkRun();
    await call('states.propose', { runId: 'run_green', stateId: 'on_profile_setup' });
    const raw2 = await call('states.propose', { runId: 'run_green', stateId: 'on_profile_setup' });
    expect((JSON.parse(raw2) as { deduped: boolean }).deduped).toBe(true);
    expect(db.prepare('SELECT COUNT(*) c FROM state_proposals').get()).toMatchObject({ c: 1 });
  });

  it('ensureState setup ⇒ deep copy of the referenced state\'s CURRENT recipe, revision cited', async () => {
    seedRegistryState('fresh_install', { actuator: 'uninstallReinstall' }, 3);
    seedTemplate('tpl_rider', [{ idx: 0, action: 'expect', selector: SEL }], [{ idx: 0, action: 'ensureState', ensureState: 'fresh_install' }]);
    seedRun('run_rider', 'tpl_rider', 'passed', [
      { name: 'ensure state', status: 'pass', ev: { action: 'ensureState', stateId: 'fresh_install', revision: 3, path: 'probe-hit', probeMs: 71 } },
      { name: 'expect', status: 'pass', ev: { action: 'expect', selector: SEL } },
    ]);
    const out = JSON.parse(await call('states.propose', { runId: 'run_rider', stateId: 'on_profile_setup' })) as { proposal: { recipe: unknown } };
    expect(out.proposal.recipe).toEqual({ actuator: 'uninstallReinstall' }); // deep copy, not a reference
    const row = db.prepare('SELECT rationale FROM state_proposals').get() as { rationale: string };
    expect(row.rationale).toContain('deep-copied from fresh_install r3');
    expect(row.rationale).toContain('probe-hit');
  });

  it('derives on_<screen> when the probe targets a registered screen', async () => {
    db.prepare('INSERT INTO app_screens(app_bundle_id, screen_id, entry_json, states_json, updated_at, revision) VALUES (?, ?, ?, ?, 0, 1)')
      .run(B, 'profile-setup', JSON.stringify({ deepLink: 'x://y' }), JSON.stringify({ visible: { any: [SEL] } }));
    seedTemplate('tpl_scr', [WALK, { idx: 1, action: 'expect', selector: { screen: 'profile-setup', state: 'visible' } }]);
    seedRun('run_scr', 'tpl_scr', 'passed', [
      { name: 'tap', status: 'pass', ev: { action: 'tap' } },
      { name: 'expect', status: 'pass', ev: { action: 'expect', selector: { screen: 'profile-setup', state: 'visible' } } },
    ]);
    const out = JSON.parse(await call('states.propose', { runId: 'run_scr' })) as { proposal: { stateId: string; probe: unknown } };
    expect(out.proposal.stateId).toBe('on_profile-setup');
    expect(out.proposal.probe).toEqual({ screen: 'profile-setup' }); // {screen,state} normalized to the probe grammar
  });
});

describe('states.propose — refusals (honest, named)', () => {
  it('refuses a failed run', async () => {
    greenWalkRun();
    db.prepare("UPDATE runs SET status = 'failed' WHERE id = 'run_green'").run();
    const raw = await call('states.propose', { runId: 'run_green', stateId: 'on_profile_setup' });
    expect(raw).toMatch(/^error: run run_green is failed/);
    expect(db.prepare('SELECT COUNT(*) c FROM state_proposals').get()).toMatchObject({ c: 0 });
  });

  it('refuses a run with no passing expect', async () => {
    seedTemplate('tpl_noexp', [WALK]);
    seedRun('run_noexp', 'tpl_noexp', 'passed', [{ name: 'tap', status: 'pass', ev: { action: 'tap' } }]);
    const raw = await call('states.propose', { runId: 'run_noexp', stateId: 'on_x' });
    expect(raw).toMatch(/no passing expect/);
  });

  it('refuses a case that proves but does not walk', async () => {
    seedTemplate('tpl_pure', [EXPECT]);
    seedRun('run_pure', 'tpl_pure', 'passed', [{ name: 'expect', status: 'pass', ev: { action: 'expect', selector: SEL } }]);
    const raw = await call('states.propose', { runId: 'run_pure', stateId: 'on_x' });
    expect(raw).toMatch(/proves but does not walk/);
  });

  it('refuses a registry collision (proposals create NEW states only)', async () => {
    seedRegistryState('on_profile_setup', { steps: [{ tap: { on: 'x' } }] });
    greenWalkRun();
    const raw = await call('states.propose', { runId: 'run_green', stateId: 'on_profile_setup' });
    expect(raw).toMatch(/^error \(409\)/);
    expect(db.prepare('SELECT COUNT(*) c FROM state_proposals').get()).toMatchObject({ c: 0 });
  });

  it('refuses when no stateId and no registered screen can name the state', async () => {
    greenWalkRun();
    const raw = await call('states.propose', { runId: 'run_green' });
    expect(raw).toMatch(/pass stateId/);
  });

  it('refuses when the ridden ensureState state is gone (walk not reproducible)', async () => {
    seedTemplate('tpl_rider', [EXPECT], [{ idx: 0, action: 'ensureState', ensureState: 'ghost' }]);
    seedRun('run_ghost', 'tpl_rider', 'passed', [{ name: 'expect', status: 'pass', ev: { action: 'expect', selector: SEL } }]);
    const raw = await call('states.propose', { runId: 'run_ghost', stateId: 'on_x' });
    expect(raw).toMatch(/no longer registered/);
  });

  it('refuses an unknown run id', async () => {
    const raw = await call('states.propose', { runId: 'run_nope' });
    expect(raw).toMatch(/^error: no run/);
  });
});
