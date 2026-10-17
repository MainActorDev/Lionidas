/** Phase A S2 — app states registry: validation domain, CRUD API contract,
 *  schema placement (CREATE block, idempotent migration), attribution,
 *  provenance stamps, history append + revision guard.
 *  Route tests ride requireRole('operator') OFF via CRUCIBLE_REQUIRE_AUTH=0
 *  style (direct registration, like app-screens.test.ts). */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify, { type FastifyInstance } from 'fastify';
import { migrateM1 } from '../src/db/schema.ts';
import { registerAppStateRoutes } from '../src/routes/app-states.ts';
import { validateAppState } from '@crucible/shared/app-states';

let tmp: string;
let db: Database.Database;
let app: FastifyInstance;

const BUNDLE = 'com.example.foodiary';

const GOOD = {
  stateId: 'fresh_install',
  label: 'Fresh install',
  probe: { screen: 'onboarding' },
  recipe: { actuator: 'uninstallReinstall' },
  verify: { labelContains: 'Get Started' },
};

function authed(user = 'drill-qa'): void {
  // route tests register directly; stamp req.user like buildApp's hook would
  app.addHook('onRequest', async (req) => {
    (req as unknown as { user: { name: string; id: string; role: string } }).user = { name: user, id: user, role: 'operator' };
  });
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'app-states-'));
  db = new Database(join(tmp, 't.db'));
  migrateM1(db);
  // GOOD probes by screen: 'onboarding' — seed the registry row so the
  // save-time cross-check (S4 precedent) resolves
  db.prepare('INSERT INTO app_screens(app_bundle_id, screen_id, entry_json, states_json, updated_at, revision) VALUES (?, ?, ?, ?, 0, 1)')
    .run(BUNDLE, 'onboarding', JSON.stringify({ deepLink: 'foodiary://onboarding' }), JSON.stringify({ ready: { any: [{ label: 'Get Started' }] } }));
  app = Fastify();
  registerAppStateRoutes(app, db);
  authed();
});

afterEach(() => {
  app.close();
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('schema placement + idempotency (lesson f)', () => {
  it('tables exist after migrate on a fresh DB and re-migrate is a no-op', () => {
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('app_states','app_states_history') ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
    expect(names).toEqual(['app_states', 'app_states_history']);
    expect(() => migrateM1(db)).not.toThrow(); // guarded idempotency
  });
  it('migration works on a pre-phase-A DB too (tables added late)', () => {
    const pre = new Database(join(tmp, 'pre.db'));
    pre.exec("CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT)");
    migrateM1(pre); // no app_states yet → CREATE adds them
    const n = (pre.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'app_states'").get() as { c: number }).c;
    expect(n).toBe(1);
    pre.close();
  });
});

describe('validateAppState (shape)', () => {
  it('accepts the full form (entry + steps walk + verify.via)', () => {
    const errors = validateAppState({
      stateId: 'logged_in',
      label: 'Logged in',
      probe: { labelContains: 'Hi, Dev' },
      recipe: {
        entry: { tab: { label: 'Account' } },
        steps: [
          { tap: { on: 'login_button' } },
          { type: { text: '${env.DRILL_PHONE}', on: 'phone_field' } },
          { wait: { text: 'Welcome' } },
        ],
      },
      verify: { screen: 'home', via: 'account_tab' },
    });
    expect(errors).toEqual([]);
  });
  it.each([
    ['bad state id', { ...GOOD, stateId: 'Fresh-Install' }, /stateId/],
    ['empty label', { ...GOOD, label: ' ' }, /label/],
    ['missing probe', { ...GOOD, probe: undefined }, /probe: required/],
    ['null probe on a walk recipe (not a reset)', { ...GOOD, probe: null, recipe: { steps: [{ tap: { on: 'get_started' } }] } }, /probe: required/],
    ['null probe on an entry recipe (not a reset)', { ...GOOD, probe: null, recipe: { entry: { tab: { label: 'Account' } } } }, /probe: required/],
    ['null probe on a mixed actuator+steps recipe', { ...GOOD, probe: null, recipe: { actuator: 'uninstallReinstall', steps: [{ tap: { on: 'x' } }] } }, /probe: required/],
    ['multi-key probe', { ...GOOD, probe: { label: 'A', identifier: 'b' } }, /exactly one targeting key/],
    ['recipe with no arm', { ...GOOD, recipe: {} }, /at least one arm/],
    ['relaunch without launchArgs', { ...GOOD, recipe: { actuator: 'relaunch' } }, /needs "launchArgs"/],
    ['mixed actuator companions', { ...GOOD, recipe: { actuator: 'relaunch', launchArgs: ['-x'], signal: 'com.x.y' } }, /belongs to actuator "signal"/],
    ['unknown verify key', { ...GOOD, verify: { label: 'x', timeout: 5 } }, /unknown key "timeout"/],
    ['empty steps list', { ...GOOD, recipe: { steps: [] } }, /non-empty list of steps/],
    ['walk action outside the player set', { ...GOOD, recipe: { steps: [{ scroll: 'down' }] } }, /not allowed in a state walk/],
  ])('rejects %s', (_n, state, rx) => {
    expect(validateAppState(state).join('\n')).toMatch(rx);
  });
  it('credential guard: password-targeted literal text is rejected, env ref passes (edge 16)', () => {
    const bad = validateAppState({
      ...GOOD,
      recipe: { steps: [{ type: { text: 'hunter2secret', on: 'password_field' } }] },
    });
    expect(bad.join('\n')).toMatch(/\$\{env\.NAME\}/);
    const ok = validateAppState({
      ...GOOD,
      recipe: { steps: [{ type: { text: '${env.DRILL_PASSWORD}', on: 'password_field' } }] },
    });
    expect(ok).toEqual([]);
  });
  it('forced reset: null probe + actuator-only recipe is the one valid probe-less state', () => {
    // live catch 2026-10-17: welcome visible ≠ fresh — a probe-hit skipped a
    // needed reinstall and the case died mid-walk. Forced = always converge.
    const ok = validateAppState({ ...GOOD, probe: null, recipe: { actuator: 'uninstallReinstall' }, verify: { label: 'Hi, Dev' } });
    expect(ok).toEqual([]);
  });
  it('phone-shaped bare literal rejected even untargeted', () => {
    expect(validateAppState({ ...GOOD, recipe: { steps: [{ type: { text: '081234567890', on: 'phone_field' } }] } }).join('\n')).toMatch(/env\.NAME/);
  });
});

describe('routes — contract', () => {
  it('POST creates with provenance user + attribution from req.user + history rev 1', async () => {
    const r = await app.inject({ method: 'POST', url: `/api/apps/${BUNDLE}/states`, payload: GOOD });
    expect(r.statusCode).toBe(201);
    const body = JSON.parse(r.body) as { state: { id: string; provenance: string; revision: number } };
    expect(body.state.id).toMatch(/^st_/);
    expect(body.state.provenance).toBe('user');
    expect(body.state.revision).toBe(1);
    const row = db.prepare('SELECT created_by, provenance, revision FROM app_states WHERE id = ?').get(body.state.id) as { created_by: string; provenance: string; revision: number };
    expect(row).toMatchObject({ created_by: 'drill-qa', provenance: 'user', revision: 1 });
    const hist = db.prepare('SELECT revision, snapshot_json FROM app_states_history WHERE app_state_id = ?').all(body.state.id) as Array<{ revision: number; snapshot_json: string }>;
    expect(hist).toHaveLength(1);
    expect(hist[0]?.revision).toBe(1);
    expect(JSON.parse(hist[0]!.snapshot_json)).toMatchObject({ stateId: 'fresh_install' });
  });
  it('POST accepts a forced reset (probe null + actuator-only) and stores probe_json null', async () => {
    const r = await app.inject({ method: 'POST', url: `/api/apps/${BUNDLE}/states`, payload: { ...GOOD, stateId: 'fresh_reset', probe: null, recipe: { actuator: 'uninstallReinstall' } } });
    expect(r.statusCode).toBe(201);
    const body = JSON.parse(r.body) as { state: { id: string; probe: unknown } };
    expect(body.state.probe).toBeNull();
    const row = db.prepare('SELECT probe_json FROM app_states WHERE id = ?').get(body.state.id) as { probe_json: string };
    expect(row.probe_json).toBe('null');
  });
  it('POST rejects probe null on a walk recipe (forced is actuator-only)', async () => {
    const r = await app.inject({ method: 'POST', url: `/api/apps/${BUNDLE}/states`, payload: { ...GOOD, stateId: 'bad_reset', probe: null, recipe: { steps: [{ tap: { on: 'get_started' } }] } } });
    expect(r.statusCode).toBe(422);
    expect(r.body).toMatch(/probe: required/);
  });

  it('body-supplied identity/provenance is IGNORED (attribution law)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/api/apps/${BUNDLE}/states`,
      payload: { ...GOOD, provenance: 'ai+user', createdBy: 'someone-else' } as never,
    });
    expect(r.statusCode).toBe(201);
    const row = db.prepare('SELECT created_by, provenance FROM app_states LIMIT 1').get() as { created_by: string; provenance: string };
    expect(row).toEqual({ created_by: 'drill-qa', provenance: 'user' });
  });

  it('POST duplicate state_id per bundle → honest 409', async () => {
    await app.inject({ method: 'POST', url: `/api/apps/${BUNDLE}/states`, payload: GOOD });
    const r = await app.inject({ method: 'POST', url: `/api/apps/${BUNDLE}/states`, payload: { ...GOOD, label: 'Again' } });
    expect(r.statusCode).toBe(409);
    expect(JSON.parse(r.body).error).toMatch(/already exists for/);
    // same state_id on a DIFFERENT bundle is fine — uniqueness is per app
    // (label probe: the onboarding screen is registered for BUNDLE only)
    const other = await app.inject({ method: 'POST', url: '/api/apps/com.example.other/states', payload: { ...GOOD, probe: { label: 'Get Started' } } });
    expect(other.statusCode).toBe(201);
  });

  it('invalid shape → 422 naming the first error; screen refs cross-checked against the registry', async () => {
    const r = await app.inject({ method: 'POST', url: `/api/apps/${BUNDLE}/states`, payload: { ...GOOD, probe: { screen: 'nope' } } });
    expect(r.statusCode).toBe(422);
    expect(JSON.parse(r.body).error).toMatch(/"nope" is not registered/);
    // the seeded 'onboarding' screen resolves — same payload shape passes
    const ok = await app.inject({ method: 'POST', url: `/api/apps/${BUNDLE}/states`, payload: { ...GOOD, probe: { screen: 'onboarding' } } });
    expect(ok.statusCode).toBe(201);
  });

  it('PUT: merge semantics, revision++ + history append; revision echo mismatch → 409 REGISTRY_STALE', async () => {
    const created = JSON.parse((await app.inject({ method: 'POST', url: `/api/apps/${BUNDLE}/states`, payload: GOOD })).body) as { state: { id: string; revision: number } };
    const id = created.state.id;
    // label-only edit keeps the stored recipe (absent keys merge)
    const r1 = await app.inject({ method: 'PUT', url: `/api/states/${id}`, payload: { label: 'Fresh install (v2)' } });
    expect(r1.statusCode).toBe(200);
    const after = JSON.parse(r1.body) as { state: { revision: number; label: string; recipe: { actuator: string } } };
    expect(after.state.revision).toBe(2);
    expect(after.state.label).toBe('Fresh install (v2)');
    expect(after.state.recipe).toEqual({ actuator: 'uninstallReinstall' });
    // stale revision echo → 409 with current row
    const stale = await app.inject({ method: 'PUT', url: `/api/states/${id}`, payload: { label: 'x', revision: 1 } });
    expect(stale.statusCode).toBe(409);
    expect(JSON.parse(stale.body).error).toMatch(/REGISTRY_STALE/);
    // revisionless PUT keeps last-write-wins
    const r2 = await app.inject({ method: 'PUT', url: `/api/states/${id}`, payload: { revision: 2, label: 'Fresh install (v3)' } });
    expect(r2.statusCode).toBe(200);
    const hist = db.prepare('SELECT revision FROM app_states_history WHERE app_state_id = ? ORDER BY revision').all(id) as Array<{ revision: number }>;
    expect(hist.map((h) => h.revision)).toEqual([1, 2, 3]);
  });

  it('GET lists parsed states for the bundle only', async () => {
    await app.inject({ method: 'POST', url: `/api/apps/${BUNDLE}/states`, payload: GOOD });
    await app.inject({ method: 'POST', url: `/api/apps/${BUNDLE}/states`, payload: { ...GOOD, stateId: 'logged_in', label: 'Logged in', probe: { label: 'Hi' }, recipe: { steps: [{ tap: { on: 'login_button' } }] }, verify: { label: 'Hi' } } });
    const r = await app.inject({ method: 'GET', url: `/api/apps/${BUNDLE}/states` });
    const body = JSON.parse(r.body) as { states: Array<{ stateId: string; probe: { screen: string }; recipe: { actuator: string } }> };
    expect(body.states.map((s) => s.stateId).sort()).toEqual(['fresh_install', 'logged_in']);
    expect(body.states[0]?.probe).toEqual({ screen: 'onboarding' });
    expect(body.states[0]?.recipe).toEqual({ actuator: 'uninstallReinstall' });
    const empty = await app.inject({ method: 'GET', url: '/api/apps/com.nope/states' });
    expect((JSON.parse(empty.body) as { states: unknown[] }).states).toEqual([]);
  });

  it('DELETE removes the row and its history; unknown id → 404', async () => {
    const created = JSON.parse((await app.inject({ method: 'POST', url: `/api/apps/${BUNDLE}/states`, payload: GOOD })).body) as { state: { id: string } };
    const r = await app.inject({ method: 'DELETE', url: `/api/states/${created.state.id}` });
    expect(r.statusCode).toBe(200);
    expect((db.prepare('SELECT COUNT(*) AS c FROM app_states').get() as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS c FROM app_states_history').get() as { c: number }).c).toBe(0);
    const gone = await app.inject({ method: 'DELETE', url: `/api/states/${created.state.id}` });
    expect(gone.statusCode).toBe(404);
  });

  it('PUT validates the merged result — a bad partial edit 422s without touching the row', async () => {
    const created = JSON.parse((await app.inject({ method: 'POST', url: `/api/apps/${BUNDLE}/states`, payload: GOOD })).body) as { state: { id: string } };
    const bad = await app.inject({ method: 'PUT', url: `/api/states/${created.state.id}`, payload: { probe: {} } });
    expect(bad.statusCode).toBe(422);
    const row = db.prepare('SELECT probe_json, revision FROM app_states WHERE id = ?').get(created.state.id) as { probe_json: string; revision: number };
    expect(row.revision).toBe(1);
    expect(JSON.parse(row.probe_json)).toEqual({ screen: 'onboarding' });
  });
});
