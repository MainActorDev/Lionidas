import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrateM1 } from '../src/db/schema.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { registerAppScreenRoutes } from '../src/routes/app-screens.ts';

/** Registry-UI stage 2 — the F3 revision guard. The PUT is total-replace;
 *  two editors would silently clobber each other. With a revision echo:
 *  stale → 409 + current registry; fresh → replace + bump. Revisionless
 *  PUTs (scripts/yaml) keep last-write behavior. */

let tmp: string;
let db: Database.Database;
let app: ReturnType<typeof Fastify>;

const BUNDLE = 'com.test.app';
const SCREEN = { id: 'home', entry: { deepLink: 'app://home' }, states: { loaded: { all: [{ labelContains: 'OK' }] } } };

async function put(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.inject({ method: 'PUT', url: `/api/apps/${BUNDLE}/screens`, payload: body });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'reg-rev-'));
  db = new Database(join(tmp, 't.db'));
  migrateM1(db); // real schema (incl. login_json) — hand-rolled DDL drifted
  app = Fastify();
  registerAppScreenRoutes(app, db);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('registry revision guard (F3)', () => {
  it('GET carries the revision; PUT bumps it', async () => {
    await put({ screens: [SCREEN] });
    const g1 = await app.inject({ method: 'GET', url: `/api/apps/${BUNDLE}/screens` });
    const rev1 = (g1.json() as { revision: number }).revision;
    await put({ screens: [SCREEN] });
    const g2 = await app.inject({ method: 'GET', url: `/api/apps/${BUNDLE}/screens` });
    const rev2 = (g2.json() as { revision: number }).revision;
    expect(rev2).toBeGreaterThan(rev1);
  });

  it('stale revision → 409 with the current registry in the body', async () => {
    const first = await put({ screens: [SCREEN] });
    const rev = first.body['revision'] as number;
    // someone else replaces the registry — revision moves past ours
    await put({ screens: [SCREEN] });
    const stale = await put({ screens: [SCREEN], revision: rev });
    expect(stale.status).toBe(409);
    expect(stale.body['code']).toBe('REGISTRY_STALE');
    expect(Array.isArray(stale.body['screens'])).toBe(true); // current state for re-apply
    expect(typeof stale.body['revision']).toBe('number');
  });

  it('fresh revision → replaces cleanly and returns the new revision', async () => {
    const first = await put({ screens: [SCREEN] });
    const rev = first.body['revision'] as number;
    const second = await put({ screens: [{ ...SCREEN, id: 'home2' }], revision: rev });
    expect(second.status).toBe(200);
    expect(second.body['ok']).toBe(true);
    expect((second.body['revision'] as number) > rev).toBe(true);
    const g = await app.inject({ method: 'GET', url: `/api/apps/${BUNDLE}/screens` });
    const screens = (g.json() as { screens: Array<{ id: string }> }).screens.map((s) => s.id);
    expect(screens).toEqual(['home2']); // total replace held
  });

  it('revisionless PUT keeps last-write behavior (scripts/yaml imports)', async () => {
    await put({ screens: [SCREEN] });
    const noRev = await put({ screens: [{ ...SCREEN, id: 'home3' }] });
    expect(noRev.status).toBe(200); // no revision echoed → no guard
    const g = await app.inject({ method: 'GET', url: `/api/apps/${BUNDLE}/screens` });
    expect((g.json() as { screens: Array<{ id: string }> }).screens.map((s) => s.id)).toEqual(['home3']);
  });

  it('empty-registry edge: GET revision of an unknown bundle is 1, PUT without prior state succeeds', async () => {
    const g = await app.inject({ method: 'GET', url: '/api/apps/never.seen/screens' });
    expect((g.json() as { revision: number }).revision).toBe(1);
    const r = await put({ screens: [SCREEN], revision: 1 });
    expect(r.status).toBe(200);
  });
});
