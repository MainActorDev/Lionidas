import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateM1 } from '../src/db/schema.ts';
import { resolveEnv } from '../src/manual/env-store.ts';

/** Managed env resolution chain (plan rev 2, Stage 2).
 *  Pins: global < app < plan < request body (variant sits ABOVE this base —
 *  its precedence is pinned in yaml-variants tests); per-source counts for
 *  the run-note audit line; scope isolation (app vars don't leak across
 *  bundles, plan vars don't leak across plans). */

let tmp: string;
let db: Database.Database;

const seed = (scope: 'global' | 'app' | 'plan', key: string, value: string, extra: { appBundleId?: string; planId?: string } = {}): void => {
  db.prepare('INSERT INTO env_vars(id, scope, app_bundle_id, plan_id, key, value, secret, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)')
    .run(`ev_${key}_${Math.random().toString(36).slice(2, 8)}`, scope, extra.appBundleId ?? null, extra.planId ?? null, key, value, 'qa', Date.now());
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'env-store-'));
  db = new Database(join(tmp, 't.db'));
  migrateM1(db);
  db.prepare("INSERT INTO plans(id, name, tags_json, env_json, created_by, created_at, updated_at) VALUES ('pl_1', 'p1', '[]', '{}', 'qa', 0, 0)").run();
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('resolveEnv — scope chain', () => {
  it('later (narrower) scope wins per key, non-overlapping keys merge', () => {
    seed('global', 'DRILL_PHONE', '1111');
    seed('global', 'SHARED', 'g');
    seed('app', 'SHARED', 'a', { appBundleId: 'com.x' });
    seed('app', 'APP_ONLY', 'a2', { appBundleId: 'com.x' });
    seed('plan', 'SHARED', 'p', { planId: 'pl_1' });
    const { env, sources } = resolveEnv(db, { appBundleId: 'com.x', planId: 'pl_1', requestEnv: { SHARED: 'r', REQ_ONLY: 'q' } });
    expect(env['SHARED']).toBe('r');       // request body beats plan/app/global
    expect(env['DRILL_PHONE']).toBe('1111'); // global survives when narrower scopes silent
    expect(env['APP_ONLY']).toBe('a2');
    expect(env['REQ_ONLY']).toBe('q');
    expect(sources).toEqual({ global: 1, app: 1, plan: 0, request: 2 }); // SHARED owned by request
  });

  it('app vars are bundle-isolated; plan vars plan-isolated', () => {
    seed('app', 'K', 'right', { appBundleId: 'com.x' });
    seed('app', 'K', 'wrong', { appBundleId: 'com.y' });
    seed('plan', 'P', 'right', { planId: 'pl_1' });
    const { env } = resolveEnv(db, { appBundleId: 'com.x', planId: null, requestEnv: {} });
    expect(env['K']).toBe('right');
    expect(env['P']).toBeUndefined();
    const { env: env2 } = resolveEnv(db, { appBundleId: 'com.y', planId: null, requestEnv: {} });
    expect(env2['K']).toBe('wrong');
  });

  it('empty env_vars table + empty request → empty env, zero counts', () => {
    const { env, sources } = resolveEnv(db, {});
    expect(env).toEqual({});
    expect(sources).toEqual({ global: 0, app: 0, plan: 0, request: 0 });
  });
});
