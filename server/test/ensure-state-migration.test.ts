/** Phase A S5 — ensureLogin/ensureLogout rebuilt onto the app_states registry
 *  (decision Q3) with the FULL legacy resolution order preserved:
 *    app_states entry → frozen app_login/app_logout row → inline (old stored cases)
 *  Migration is guarded + idempotent; every source produces the same audit
 *  fields ({action, source, …}); the registry WINS when present.
 *  Fake app worlds: 'loggedout' (open_login), 'form' (phone/password/submit),
 *  'loggedin' (session_badge). Submit tap → loggedin; open_login tap → form. */
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
let world: 'loggedout' | 'form' | 'loggedin';
let fillLog: string[];

const BUNDLE = 'com.example.app';

const NODE = (i: number, id: string, y = 200) =>
  ({ index: i, parentIndex: 0, type: 'Button', label: '', identifier: id, rect: { x: 100, y, width: 80, height: 40 }, hittable: true, ref: `n${i}` });
const ROOT = { index: 0, parentIndex: -1, type: 'Application', label: 'App', rect: { x: 0, y: 0, width: 393, height: 852 }, hittable: false, ref: 'root' } as const;

const TREES = {
  loggedout: [ROOT, NODE(1, 'open_login', 500)],
  form: [ROOT, NODE(1, 'phone_field', 300), NODE(2, 'password_field', 360), NODE(3, 'submit_button', 420)],
  loggedin: [ROOT, NODE(1, 'session_badge', 100), NODE(2, 'account_tab', 700)],
} as const;

function fakeAlloy(): AlloyExports {
  return {
    dispatch: async (tool: string, rawIn: unknown) => {
      if (tool === 'alloy_apps') return { ok: true, result: {} };
      if (tool === 'alloy_snapshot') return { ok: true, result: { nodes: TREES[world] } };
      if (tool === 'alloy_act') {
        const input = rawIn as { action: string; target?: { x: number; y: number }; text?: string };
        if (input.action === 'fill') { fillLog.push(String(input.text ?? '')); return { ok: true }; }
        if (input.action === 'press' && input.target) {
          // open_login center y=520 → form; submit center y=440 → loggedin;
          // account_tab center y=720 (on loggedin) → loggedout
          if (Math.abs(input.target.y - 520) < 30) world = 'form';
          if (Math.abs(input.target.y - 440) < 30) world = 'loggedin';
          if (Math.abs(input.target.y - 720) < 30 && world === 'loggedin') world = 'loggedout';
        }
        return { ok: true };
      }
      return { ok: true, result: {} };
    },
  } as unknown as AlloyExports;
}

/** the settled steps-form app_login recipe (post login-as-steps migration) */
const LOGIN_RECIPE = JSON.stringify({
  entry: { navigate: [{ on: 'open_login' }] },
  steps: [
    { type: { on: 'phone_field', text: '${env.DRILL_PHONE}' } },
    { type: { on: 'password_field', text: '${env.DRILL_PASSWORD}' } },
    { tap: { on: 'submit_button' } },
  ],
  verify: { screen: 'auth', state: 'session_on' },
});

function seedAppLogin(): void {
  db.prepare('INSERT INTO app_login(bundle_id, login_json, updated_at, revision) VALUES (?, ?, 0, 1)').run(BUNDLE, LOGIN_RECIPE);
}
function seedAuthScreen(): void {
  db.prepare('INSERT INTO app_screens(app_bundle_id, screen_id, entry_json, refresh_json, states_json, updated_at, revision) VALUES (?, ?, ?, NULL, ?, 0, 1)')
    .run(BUNDLE, 'auth', '{}', JSON.stringify({ session_on: { all: [{ identifier: 'session_badge' }] } }));
}
function seedTemplate(id: string, setup: unknown[]): void {
  db.prepare(`INSERT INTO templates(id, name, ticket_key, udid, steps_json, setup_json, alerts_policy, app_bundle_id, logical_w, logical_h, tags_json, created_by, created_at, updated_at)
              VALUES (?, ?, NULL, 'sim', ?, ?, NULL, ?, 393, 852, '[]', 'qa', 0, 0)`)
    .run(id, id, JSON.stringify([{ idx: 0, action: 'expect', selector: { label: 'Done' } }]), JSON.stringify(setup), BUNDLE);
  db.prepare(`INSERT INTO devices(udid, name, state, platform, kind, last_seen) VALUES ('sim', 'Sim', 'Booted', 'ios', 'simulator', 0)
              ON CONFLICT(udid) DO UPDATE SET state = 'Booted'`).run();
}
async function play(id: string, env: Record<string, string> = {}): Promise<string> {
  const bus = { emit: () => undefined } as never;
  const r = await runTemplatePlayback({ db, bus, dispatchDeps: null, artifactsDir: tmp, forgeState: { activeRunId: null }, awaitStreamLive: null } as never, id, { env });
  await r.done;
  return r.runId;
}
function firstStep(runId: string): { status: string; reason: string | null; evaluated_json: string | null } {
  return db.prepare('SELECT status, reason, evaluated_json FROM run_steps WHERE run_id = ? ORDER BY idx LIMIT 1').get(runId) as never;
}
function audit(runId: string): Record<string, unknown> {
  const r = firstStep(runId);
  return r.evaluated_json ? (JSON.parse(r.evaluated_json) as Record<string, unknown>) : {};
}
const ENV = { DRILL_PHONE: '081200001111', DRILL_PASSWORD: 'pw123' };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 's5-'));
  db = new Database(':memory:');
  migrateM1(db);
  world = 'loggedout';
  fillLog = [];
  __setAlloyForTest(fakeAlloy());
  process.env.CRUCIBLE_STATE_PROBE_MS = '150';
});
afterEach(() => {
  __setAlloyForTest(null);
  delete process.env.CRUCIBLE_STATE_PROBE_MS;
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('S5 data migration (app_login → app_states logged_in)', () => {
  it('steps-form rows become logged_in entries with derived probe/recipe/verify + history rev 1', () => {
    seedAppLogin();
    seedAuthScreen();
    migrateM1(db); // re-run: the phase-A migration picks the row up
    const row = db.prepare("SELECT * FROM app_states WHERE app_bundle_id = ? AND state_id = 'logged_in'").get(BUNDLE) as { id: string; probe_json: string; recipe_json: string; verify_json: string; provenance: string; revision: number } | undefined;
    expect(row).toBeDefined();
    expect(row?.id).toBe(`st_li_${BUNDLE}`);
    expect(JSON.parse(row!.probe_json)).toEqual({ screen: 'auth.session_on' });
    expect(JSON.parse(row!.verify_json)).toEqual({ screen: 'auth.session_on' });
    const recipe = JSON.parse(row!.recipe_json) as { entry: unknown; steps: unknown[] };
    expect(recipe.entry).toEqual({ navigate: [{ on: 'open_login' }] });
    expect(recipe.steps).toHaveLength(3);
    expect(row).toMatchObject({ provenance: 'import', revision: 1 });
    const hist = db.prepare('SELECT revision FROM app_states_history WHERE app_state_id = ?').all(row!.id) as Array<{ revision: number }>;
    expect(hist).toEqual([{ revision: 1 }]);
  });

  it('idempotent: re-migrating never duplicates or overwrites (registry wins once authored)', async () => {
    seedAppLogin();
    await migrateM1Async();
    // user edits the state → revision bumps
    db.prepare("UPDATE app_states SET revision = 5, label = 'Angemeldet' WHERE state_id = 'logged_in'").run();
    await migrateM1Async();
    const rows = db.prepare("SELECT revision, label FROM app_states WHERE state_id = 'logged_in'").all() as Array<{ revision: number; label: string }>;
    expect(rows).toEqual([{ revision: 5, label: 'Angemeldet' }]);
    expect((db.prepare('SELECT COUNT(*) AS c FROM app_states_history').get() as { c: number }).c).toBe(1);
  });

  it('non-steps legacy rows are left alone (no derived garbage)', () => {
    db.prepare('INSERT INTO app_login(bundle_id, login_json, updated_at, revision) VALUES (?, ?, 0, 1)').run('com.other', JSON.stringify({ entry: {}, phone: 'p', password: 'x', submit: 's' }));
    expect(() => migrateM1(db)).not.toThrow();
    expect((db.prepare("SELECT COUNT(*) AS c FROM app_states WHERE app_bundle_id = 'com.other'").get() as { c: number }).c).toBe(0);
  });
});
async function migrateM1Async(): Promise<void> { migrateM1(db); }

describe('S5 parity — the three resolution sources (same audit fields)', () => {
  it('registry-sourced: bare ensure login converges via app_states, audit {source: registry, stateId, revision, path}', async () => {
    seedAppLogin(); seedAuthScreen();
    migrateM1(db);
    seedTemplate('tpl_reg', [{ idx: 0, action: 'ensureLogin', ensureLogin: { recipe: 'app' } }]);
    const runId = await play('tpl_reg', ENV);
    expect(firstStep(runId).status).toBe('pass');
    expect(fillLog).toEqual([ENV.DRILL_PHONE, ENV.DRILL_PASSWORD]); // the recipe walk typed both
    expect(audit(runId)).toMatchObject({ action: 'ensureLogin', source: 'registry', stateId: 'logged_in', revision: 1, path: 'recipe' });
  });

  it('legacy-row-sourced: app_login row (registry absent) walks the legacy loop, audit source: legacy-row', async () => {
    seedAppLogin(); seedAuthScreen();
    // NO migrate → no app_states row → legacy path
    seedTemplate('tpl_legacy', [{ idx: 0, action: 'ensureLogin', ensureLogin: { recipe: 'app' } }]);
    const runId = await play('tpl_legacy', ENV);
    expect(firstStep(runId).status).toBe('pass');
    expect(fillLog).toEqual([ENV.DRILL_PHONE, ENV.DRILL_PASSWORD]);
    expect(audit(runId)).toMatchObject({ action: 'ensureLogin', source: 'legacy-row' });
    expect(audit(runId).stateId).toBeUndefined(); // legacy audit shape unchanged
  });

  it('inline-sourced: an old stored full-selector case walks inline, audit source: inline', async () => {
    seedAuthScreen(); // no app_login row at all
    seedTemplate('tpl_inline', [{ idx: 0, action: 'ensureLogin', ensureLogin: { entry: 'open_login', phoneField: 'phone_field', passwordField: 'password_field', submit: 'submit_button', session: 'session_badge', phone: '0812', password: 'pw' } }]);
    const runId = await play('tpl_inline');
    expect(firstStep(runId).status).toBe('pass');
    expect(fillLog).toEqual(['0812', 'pw']);
    expect(audit(runId)).toMatchObject({ action: 'ensureLogin', source: 'inline' });
  });

  it('precedence: registry WINS when both registry and app_login exist (probe-hit short-circuits)', async () => {
    seedAppLogin(); seedAuthScreen();
    migrateM1(db);
    world = 'loggedin'; // probe hits → no fills at all
    seedTemplate('tpl_prec', [{ idx: 0, action: 'ensureLogin', ensureLogin: { recipe: 'app' } }]);
    const runId = await play('tpl_prec', ENV);
    expect(firstStep(runId).status).toBe('pass');
    expect(fillLog).toEqual([]);
    expect(audit(runId)).toMatchObject({ source: 'registry', path: 'probe-hit' });
    expect(firstStep(runId).reason).toMatch(/probe hit/);
  });
});

describe('S5 ensureLogout registry-first', () => {
  it('an authored logged_out state converges (audit source: registry)', async () => {
    world = 'loggedin'; // the log-out walk: account tab → (fake) logout control
    // author: probe = the login button reappears (identity of logged-out)
    db.prepare("INSERT INTO app_states(id, app_bundle_id, state_id, label, probe_json, recipe_json, verify_json, provenance, revision, created_by, created_at, updated_at) VALUES ('st_lo', ?, 'logged_out', 'Logged out', ?, ?, ?, 'user', 1, 'qa', 0, 0)")
      .run(BUNDLE, JSON.stringify({ identifier: 'open_login' }), JSON.stringify({ steps: [{ tap: { on: 'account_tab' } }] }), JSON.stringify({ identifier: 'open_login' }));
    seedTemplate('tpl_lo', [{ idx: 0, action: 'ensureLogout', ensureLogout: { recipe: 'app' } }]);
    // model: tapping account_tab (y=720) on loggedin → loggedout world
    const runId = await play('tpl_lo');
    expect(firstStep(runId).status).toBe('pass');
    expect(audit(runId)).toMatchObject({ action: 'ensureLogout', source: 'registry', stateId: 'logged_out', path: 'recipe' });
  });
});
