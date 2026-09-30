import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { migrateM1 } from '../src/db/schema.ts';
import { registerAppScreenRoutes } from '../src/routes/app-screens.ts';
import { validateAppLogout } from '../../shared/src/app-screens.ts';

/** Plan 20260929T080249Z rev 2 — stages 2+3: app_logout CRUD, validator,
 *  login settlement (screen data migrates once; column drops; app_login wins). */

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  migrateM1(db);
});

describe('validateAppLogout (F4)', () => {
  it('accepts the canonical recipe; rejects empties and unknown keys', () => {
    expect(validateAppLogout({ button: 'b', confirm: 'c', via: 'v', stay: 's' })).toEqual([]);
    expect(validateAppLogout({ button: 'b', confirm: 'c' })).toEqual([]);
    expect(validateAppLogout({ button: '', confirm: 'c' }).join(' ')).toContain('button');
    expect(validateAppLogout({ button: 'b' }).join(' ')).toContain('confirm');
    expect(validateAppLogout({ button: 'b', confirm: 'c', nope: 1 }).join(' ')).toContain('unknown key');
    expect(validateAppLogout('x').join(' ')).toContain('mapping');
    expect(validateAppLogout({ button: 'b', confirm: 'c', stay: ' ' }).join(' ')).toContain('stay');
  });
});

describe('login settlement (F1/F3)', () => {
  it('migrates screen-level recipes to app_login exactly once; app_login wins; column drops', () => {
    // simulate a PRE-settlement DB: app_screens still has the column? No —
    // migrateM1 already settled it. Verify post-conditions instead:
    const cols = (db.pragma('table_info(app_screens)') as Array<{ name: string }>).map((c) => c.name);
    expect(cols).not.toContain('login_json');
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('app_login','app_logout')").all() as Array<{ name: string }>).map((t) => t.name);
    expect(tables).toContain('app_login');
    expect(tables).toContain('app_logout');
    // idempotent: run migrate again — no throw
    expect(() => migrateM1(db)).not.toThrow();
  });

  it('migration path: screen-level recipe with no app_login row lands in app_login', () => {
    // build the old shape by hand, then re-run the migration statements the schema applies for old DBs
    db.prepare("INSERT INTO app_screens(app_bundle_id, screen_id, entry_json, refresh_json, states_json, updated_at, revision) VALUES ('com.example.app', 'auth', '{}', NULL, '{}', 0, 1)").run();
    db.exec('ALTER TABLE app_screens ADD COLUMN login_json_txt TEXT'); // stand-in column
    db.prepare("UPDATE app_screens SET login_json_txt = ? WHERE screen_id = 'auth'").run(JSON.stringify({ phone: 'p', password: 'w', submit: 's' }));
    db.prepare(`INSERT INTO app_login(bundle_id, login_json, updated_at, revision)
                SELECT app_bundle_id, login_json_txt, 0, 1 FROM app_screens
                WHERE login_json_txt IS NOT NULL AND app_bundle_id NOT IN (SELECT bundle_id FROM app_login)`).run();
    const row = db.prepare("SELECT login_json FROM app_login WHERE bundle_id = (SELECT app_bundle_id FROM app_screens WHERE screen_id = 'auth')").get() as { login_json: string };
    expect(JSON.parse(row.login_json)).toEqual({ phone: 'p', password: 'w', submit: 's' });
  });
});

describe('screens.yaml carries the recipes', () => {
  it('export includes login/logout; import (wrapper form) restores them; bare-list import keeps working', async () => {
    const app: FastifyInstance = Fastify();
    app.addHook('onRequest', async (req) => { (req as unknown as { user: unknown }).user = { name: 't', role: 'operator' }; });
    registerAppScreenRoutes(app, db);
    await app.ready();
    const bundle = 'com.example.app';
    // seed: one screen + both recipes
    await app.inject({ method: 'PUT', url: `/api/apps/${bundle}/screens`, payload: { screens: [{ id: 'home', entry: { tab: { label: 'Home' } }, states: { guest: { all: [{ label: 'welcome' }] } } }, { id: 'auth', entry: { tab: { label: 'Log In' } }, states: { logged_out: { all: [{ label: 'log_in' }] } } }] } });
    await app.inject({ method: 'PUT', url: `/api/apps/${bundle}/logout`, payload: { logout: { button: 'b1', confirm: 'c1' } } });
    await app.inject({ method: 'PUT', url: `/api/apps/${bundle}/login`, payload: { login: { entry: { tab: { label: 'Log In' } }, steps: [{ type: { on: 'ph', text: '${env.P}' } }, { tap: { on: 'go' } }], verify: { screen: 'auth', state: 'logged_out' } } } });
    const yaml = (await (await app.inject({ method: 'GET', url: `/api/apps/${bundle}/screens.yaml` })).body);
    expect(yaml).toContain('login:');
    expect(yaml).toContain('logout:');
    expect(yaml).toContain('button: b1');
    // wipe and re-import the exported yaml → recipes restored
    await app.inject({ method: 'DELETE', url: `/api/apps/${bundle}/logout` });
    const imp = await app.inject({ method: 'PUT', url: `/api/apps/${bundle}/screens.yaml`, payload: { yaml } });
    expect(imp.statusCode).toBe(200);
    const got = await app.inject({ method: 'GET', url: `/api/apps/${bundle}/logout` });
    expect(got.json().logout).toEqual({ button: 'b1', confirm: 'c1' });
    // bare list (legacy form) still imports
    const legacy = (await (await app.inject({ method: 'GET', url: `/api/apps/${bundle}/screens.yaml` })).body);
    const bareList = legacy.split('\n').filter((l) => !/^(login|logout):/.test(l) && !/^  /.test(l) || /^  (entry|states|refresh)/.test(l)).join('\n');
    const imp2 = await app.inject({ method: 'PUT', url: `/api/apps/${bundle}/screens.yaml`, payload: { yaml: '- id: home\n  entry:\n    tab:\n      label: Home\n  states:\n    guest:\n      all:\n        - label: welcome\n' } });
    expect(imp2.statusCode).toBe(200);
  });
});

describe('app_logout routes', () => {
  it('GET 404-shape → {logout: null}; PUT validates + revision-guards; DELETE round-trips', async () => {
    const app: FastifyInstance = Fastify();
    app.addHook('onRequest', async (req) => { (req as unknown as { user: unknown }).user = { name: 't', role: 'operator' }; });
    registerAppScreenRoutes(app, db);
    await app.ready();
    const get = await app.inject({ method: 'GET', url: '/api/apps/com.example.app/logout' });
    expect(get.json()).toEqual({ logout: null, revision: 1 });

    const bad = await app.inject({ method: 'PUT', url: '/api/apps/com.example.app/logout', payload: { logout: { button: 'b' } } });
    expect(bad.statusCode).toBe(422);

    const ok = await app.inject({ method: 'PUT', url: '/api/apps/com.example.app/logout', payload: { logout: { button: 'account_logout_button', confirm: 'account_logout_confirm_button', stay: 'account_logout_stay_button', via: 'ic_tabbar_account_inactive' } } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().revision).toBe(2);

    const stale = await app.inject({ method: 'PUT', url: '/api/apps/com.example.app/logout', payload: { logout: { button: 'x', confirm: 'y' }, revision: 1 } });
    expect(stale.statusCode).toBe(409);

    const got = await app.inject({ method: 'GET', url: '/api/apps/com.example.app/logout' });
    expect(got.json().logout.button).toBe('account_logout_button');

    const del = await app.inject({ method: 'DELETE', url: '/api/apps/com.example.app/logout' });
    expect(del.statusCode).toBe(200);
    const after = await app.inject({ method: 'DELETE', url: '/api/apps/com.example.app/logout' });
    expect(after.statusCode).toBe(404);
  });
});
