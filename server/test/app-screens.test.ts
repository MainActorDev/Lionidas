import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { migrateM1 } from '../src/db/schema.ts';
import { registerAppScreenRoutes } from '../src/routes/app-screens.ts';
import { validateScreen, validateRegistry } from '@crucible/shared/app-screens';

/** R2 S3 — app screen registry: validation domain + CRUD API + YAML
 *  round-trip. The registry is the app's map; cases reference it (S4). */

let tmp: string;
let db: Database.Database;
let app: FastifyInstance;

const BUNDLE = 'com.lioparcel.services.consumer.int-dev';
const GOOD_SCREEN = {
  id: 'tracking',
  entry: { deepLink: 'shipments/{id}' },
  refresh: { gesture: 'pull' },
  states: {
    loading: { any: [{ labelContains: 'Memuat' }] },
    loaded: { all: [{ labelContains: 'STATUS PENGIRIMAN' }] },
    error: { any: [{ labelContains: 'Gagal memuat' }, { identifier: 'error-retry-button' }] },
  },
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 's3-screens-'));
  db = new Database(join(tmp, 't.db'));
  migrateM1(db);
  app = Fastify();
  registerAppScreenRoutes(app, db);
});

afterEach(() => {
  app.close();
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('S3 — validateScreen (domain)', () => {
  it('accepts the reference screen (deepLink entry, pull refresh, 3 states)', () => {
    expect(validateScreen(GOOD_SCREEN)).toEqual([]);
  });

  it('accepts tab entry with point, tab-retap refresh', () => {
    const s = {
      id: 'home',
      entry: { tab: { label: 'Home', point: [196, 820] } },
      refresh: { gesture: 'tab-retap', selector: { label: 'Home' } },
      states: { loaded: { all: [{ identifier: 'feed' }] } },
    };
    expect(validateScreen(s)).toEqual([]);
  });

  it('rejects: no entry mode, multiple modes, bad id, empty states, selector without matcher', () => {
    expect(validateScreen({ id: 'x', entry: {}, states: { a: { all: [{ label: 'x' }] } } })[0]).toContain('entry needs exactly one');
    expect(validateScreen({ id: 'x', entry: { tab: { label: 't' }, deepLink: 'route' }, states: { a: { all: [{ label: 'x' }] } } })[0]).toContain('only one of');
    expect(validateScreen({ id: 'Bad_Id', entry: { deepLink: 'r' }, states: { a: { all: [{ label: 'x' }] } } })[0]).toContain('id must match');
    expect(validateScreen({ id: 'x', entry: { deepLink: 'r' }, states: {} })[0]).toContain('at least one named state');
    expect(validateScreen({ id: 'x', entry: { deepLink: 'r' }, states: { a: { all: [{ ignoreCase: true }] } } })[0]).toContain('needs one of identifier | label | labelContains');
  });

  it('rejects gesture/aux mismatches: tab-retap without selector, deepLink gesture without route, pull with selector', () => {
    const base = (refresh: unknown): unknown => ({ id: 'x', entry: { deepLink: 'r' }, states: { a: { all: [{ label: 'x' }] } }, refresh });
    expect(validateScreen(base({ gesture: 'tab-retap' }))[0]).toContain('tab-retap needs a selector');
    expect(validateScreen(base({ gesture: 'deepLink' }))[0]).toContain('deepLink gesture needs a deepLink route');
    expect(validateScreen(base({ gesture: 'pull', selector: { label: 'x' } }))[0]).toContain('pull takes no selector');
  });

  it('validateRegistry: duplicate ids named with both positions', () => {
    const errs = validateRegistry([GOOD_SCREEN, { ...GOOD_SCREEN }]);
    expect(errs.some((e) => e.includes('duplicate id "tracking"'))).toBe(true);
  });
});

describe('S3 — registry API', () => {
  it('PUT validates and stores; GET returns parsed screens; replace is total', async () => {
    const put = await app.inject({ method: 'PUT', url: `/api/apps/${BUNDLE}/screens`, payload: { screens: [GOOD_SCREEN] } });
    expect(put.statusCode).toBe(200);
    expect((put.json() as { count: number }).count).toBe(1);

    const get = await app.inject({ method: 'GET', url: `/api/apps/${BUNDLE}/screens` });
    const screens = (get.json() as { screens: Array<{ id: string; states: Record<string, unknown> }> }).screens;
    expect(screens.map((s) => s.id)).toEqual(['tracking']);
    expect(Object.keys(screens[0]!.states)).toEqual(['loading', 'loaded', 'error']);

    // replace: old screens gone
    const other = { ...GOOD_SCREEN, id: 'rates' };
    await app.inject({ method: 'PUT', url: `/api/apps/${BUNDLE}/screens`, payload: { screens: [other] } });
    const get2 = await app.inject({ method: 'GET', url: `/api/apps/${BUNDLE}/screens` });
    expect((get2.json() as { screens: Array<{ id: string }> }).screens.map((s) => s.id)).toEqual(['rates']);
  });

  it('PUT with invalid screen → 422 with every error', async () => {
    const put = await app.inject({ method: 'PUT', url: `/api/apps/${BUNDLE}/screens`, payload: { screens: [{ id: 'X', entry: {}, states: {} }] } });
    expect(put.statusCode).toBe(422);
    const errors = (put.json() as { errors: string[] }).errors;
    expect(errors.some((e) => e.includes('id must match'))).toBe(true);
    expect(errors.some((e) => e.includes('entry needs exactly one'))).toBe(true);
    expect(errors.some((e) => e.includes('at least one named state'))).toBe(true);
  });

  it('DELETE removes one screen; 404 for unknown', async () => {
    await app.inject({ method: 'PUT', url: `/api/apps/${BUNDLE}/screens`, payload: { screens: [GOOD_SCREEN] } });
    const del = await app.inject({ method: 'DELETE', url: `/api/apps/${BUNDLE}/screens/tracking` });
    expect(del.statusCode).toBe(200);
    const del2 = await app.inject({ method: 'DELETE', url: `/api/apps/${BUNDLE}/screens/tracking` });
    expect(del2.statusCode).toBe(404);
  });

  it('apps are isolated (registry per bundle)', async () => {
    await app.inject({ method: 'PUT', url: `/api/apps/${BUNDLE}/screens`, payload: { screens: [GOOD_SCREEN] } });
    const other = await app.inject({ method: 'GET', url: '/api/apps/com.other.app/screens' });
    expect((other.json() as { screens: unknown[] }).screens).toEqual([]);
  });
});

describe('S3 — YAML round-trip', () => {
  it('export → import reproduces the same registry', async () => {
    await app.inject({ method: 'PUT', url: `/api/apps/${BUNDLE}/screens`, payload: { screens: [GOOD_SCREEN] } });
    const y = await app.inject({ method: 'GET', url: `/api/apps/${BUNDLE}/screens.yaml` });
    expect(y.statusCode).toBe(200);
    const yaml = y.body;
    expect(yaml).toContain('- id: tracking');

    // round-trip through a FRESH app instance (same db)
    const app2 = Fastify();
    registerAppScreenRoutes(app2, db);
    // clear then import
    db.prepare('DELETE FROM app_screens').run();
    const imp = await app2.inject({ method: 'PUT', url: `/api/apps/${BUNDLE}/screens.yaml`, payload: { yaml } });
    expect(imp.statusCode).toBe(200);
    const back = await app2.inject({ method: 'GET', url: `/api/apps/${BUNDLE}/screens` });
    const screens = (back.json() as { screens: Array<{ id: string; entry: { deepLink: string }; states: Record<string, { any?: unknown[]; all?: unknown[] }> }> }).screens;
    expect(screens[0]!.id).toBe('tracking');
    expect(screens[0]!.entry.deepLink).toBe('shipments/{id}');
    expect(screens[0]!.states.loading!.any).toEqual([{ labelContains: 'Memuat' }]);
    await app2.close();
  });

  it('invalid YAML import → 422', async () => {
    const imp = await app.inject({ method: 'PUT', url: `/api/apps/${BUNDLE}/screens.yaml`, payload: { yaml: 'screens: [' } });
    expect(imp.statusCode).toBe(422);
  });
});

/** navigate selector steps (register-flow S1) — the login half moved to
 *  the app-level procedure (below). */
describe('navigate selector steps (register-flow S1)', () => {
  const mk = (steps: Array<Record<string, unknown>>) => [{ id: 's', entry: { navigate: steps }, states: { ok: { all: [{ label: 'X' }] } } }];
  it('navigate steps accept on: OR x/y — neither or both → named errors', () => {
    expect(validateRegistry(mk([{ on: 'menu_button' }]))).toEqual([]);
    expect(validateRegistry(mk([{ x: 10, y: 20 }]))).toEqual([]);
    expect(validateRegistry(mk([{ on: 'a', x: 1, y: 2 }]))).not.toEqual([]);
    const errs = validateRegistry(mk([{ }]));
    expect(errs.some((e) => e.includes('needs on:'))).toBe(true);
    const unk = validateRegistry(mk([{ on: 'a', tap: 1 }]));
    expect(unk.some((e) => e.includes('unknown key "tap"'))).toBe(true);
  });
  it('yaml import carries navigate on: steps', async () => {
    const yaml = [
      '- id: deep',
      '  entry:',
      '    navigate:',
      '      - on: menu_button',
      '      - on: account_legal_privacy_row',
      '  states:',
      '    ok:',
      '      all:',
      '        - { identifier: legal_doc }',
    ].join('\n') + '\n';
    const YAML = await import('yaml');
    const parsed = YAML.parse(yaml);
    expect(validateRegistry(parsed)).toEqual([]);
    const nav = (parsed[0]['entry'] as { navigate: Array<Record<string, unknown>> })['navigate'];
    expect(nav![0]!['on']).toBe('menu_button');
  });
});


/** login as an app-level procedure (plan rev 2): validateAppLogin cross-
 *  references, screens reject login on new data. */
import { validateAppLogin } from '@crucible/shared/app-screens';
describe('app-level login procedure', () => {
  const screens = [{ id: 'auth', entry: { tab: { label: 'x' } }, states: { logged_in: { all: [{ identifier: 'lo' }] } } }];
  const good = { entry: { navigate: [{ on: 'a' }, { on: 'b' }] }, steps: [{ type: { on: 'phone_field', text: '${env.P}' } }, { tap: { on: 'submit' } }], verify: { screen: 'auth', state: 'logged_in' } };
  it('valid procedure passes', () => expect(validateAppLogin(good, screens)).toEqual([]));
  it('verify referencing an unknown screen / state → named errors', () => {
    expect(validateAppLogin({ ...good, verify: { screen: 'nope', state: 'x' } }, screens)[0]).toContain('verify.screen "nope" is not in this app');
    expect(validateAppLogin({ ...good, verify: { screen: 'auth', state: 'zz' } }, screens)[0]).toContain('verify.state "zz" is not a state');
  });
  it('entry must be exactly one kind; legacy 5-slot keys rejected', () => {
    expect(validateAppLogin({ ...good, entry: { tab: { identifier: 't' }, deepLink: 'x://' } }, screens).some((e) => e.includes('only one of'))).toBe(true);
    expect(validateAppLogin({ ...good, phone: 'p' } as never, screens).some((e) => e.includes('unknown key "phone"'))).toBe(true);
    expect(validateAppLogin({ ...good, steps: [] }, screens).some((e) => e.includes('steps'))).toBe(true);
  });
  it('screens reject login on NEW data (the era ends loudly)', () => {
    const errs = validateRegistry([{ id: 's', entry: { tab: { label: 'L' } }, states: { ok: { all: [{ label: 'X' }] } }, login: good } as never]);
    expect(errs.some((e) => e.includes('login is app-level now'))).toBe(true);
  });
});
