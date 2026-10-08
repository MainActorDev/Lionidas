/** Setup wizard tests: state machine, guarded routes, claim flow, seeding
 *  interplay, rate limit, origin check, token lifecycle, readiness probes. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { migrateM1 } from '../src/db/schema.ts';
import { seedUsers } from '../src/auth/users.ts';
import {
  needsSetup, setupModeOff, writeSetupStamp, backfillSetupStamp,
  ensureSetupToken, setupTokenValid, deleteSetupToken, claimSetup,
  setupRateLimit, originAllowed, readinessRows, resetProbeCache, resetRateLimit,
} from '../src/auth/setup.ts';
import { registerSetupRoutes } from '../src/routes/setup.ts';
import { registerUserResolution } from '../src/auth/roles.ts';
import { registerAuthRoutes } from '../src/routes/auth.ts';

let db: Database.Database;
let tmp: string;
let app: FastifyInstance;

function build(): FastifyInstance {
  const a = Fastify();
  registerUserResolution(a, db);
  registerAuthRoutes(a, db);
  registerSetupRoutes(a, db);
  return a;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'crucible-setup-'));
  db = new Database(join(tmp, 't.db'));
  db.pragma('journal_mode = WAL');
  migrateM1(db);
  app = build();
  resetProbeCache();
  resetRateLimit();
});

afterEach(() => {
  app.close();
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('state machine', () => {
  it('fresh DB (wizard-aware seed) needs setup', () => {
    process.env.CRUCIBLE_SETUP_MODE = '';
    seedUsers(db, null);
    expect(needsSetup(db)).toBe(true);
  });

  it('setupModeOff disables the wizard', () => {
    expect(setupModeOff({ CRUCIBLE_SETUP_MODE: 'off' } as NodeJS.ProcessEnv)).toBe(true);
    expect(setupModeOff({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it('stamp closes the window', () => {
    seedUsers(db, null);
    writeSetupStamp(db, 'x@y.z');
    expect(needsSetup(db)).toBe(false);
  });

  it('PIN-seeded hash closes the window (headless)', () => {
    seedUsers(db, 'bootstrap-pin-1');
    expect(needsSetup(db)).toBe(false);
    expect(backfillSetupStamp(db)).toBe(true); // T0 stamps it
    expect(db.prepare("SELECT value FROM schema_meta WHERE key = 'setup_completed_by'").get()).toBeTruthy();
  });

  it('T0 backfill: local hash without stamp gets stamped', () => {
    seedUsers(db, 'pin-1');
    // simulate pre-wizard install: hash exists, stamp absent
    db.prepare("DELETE FROM schema_meta WHERE key = 'setup_completed_by'").run();
    expect(needsSetup(db)).toBe(false); // hash still closes it
    expect(backfillSetupStamp(db)).toBe(true);
    expect(db.prepare("SELECT value FROM schema_meta WHERE key = 'setup_backfilled'").get()).toBeTruthy();
  });

  it('bot rows never close the window (R2: local users only)', () => {
    seedUsers(db, null);
    // bots carry password_hash for their tokens — insert one via bot token path
    db.prepare("UPDATE users SET password_hash = 'deadbeef$deadbeef' WHERE email = 'lioclaw@bot.local'").run();
    expect(needsSetup(db)).toBe(true); // bot hash ≠ operator credential
  });

  it('Jira-provisioned hash never closes the window (R2)', () => {
    seedUsers(db, null);
    db.prepare(`INSERT INTO users(id, email, name, role, password_hash, auth_source, active, approved, created_at)
                VALUES ('usr_j1', 'jira@x.co', 'jirauser', 'viewer', 'aa$bb', 'jira', 1, 1, ?)`).run(Date.now());
    expect(needsSetup(db)).toBe(true);
  });
});

describe('claim token', () => {
  it('ensure → stable across calls, valid, deleted after claim', () => {
    seedUsers(db, null);
    const t1 = ensureSetupToken(db);
    const t2 = ensureSetupToken(db);
    expect(t1).toBe(t2); // same token until deleted
    expect(setupTokenValid(db, t1)).toBe(true);
    expect(setupTokenValid(db, 'wrong-token')).toBe(false);
    expect(setupTokenValid(db, undefined)).toBe(false);
    const r = claimSetup(db, 'op@x.co', 'op', 'password-1');
    expect(r.ok).toBe(true);
    expect(setupTokenValid(db, t1)).toBe(false); // token deleted
    expect(db.prepare("SELECT value FROM schema_meta WHERE key = 'setup_claim_token'").get()).toBeFalsy();
  });

  it('token format is 4 hex groups', () => {
    seedUsers(db, null);
    const t = ensureSetupToken(db);
    expect(t).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/);
  });
});

describe('routes', () => {
  it('state + admin POST work while open, 404 after claim', async () => {
    seedUsers(db, null);
    const token = ensureSetupToken(db);
    let r = await app.inject({ method: 'GET', url: '/api/setup/state' });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { needsSetup: boolean }).needsSetup).toBe(true);

    r = await app.inject({
      method: 'POST', url: '/api/setup/admin',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'OP@X.co ', name: 'Op', password: 'password-1', token },
    });
    expect(r.statusCode).toBe(200);

    r = await app.inject({ method: 'GET', url: '/api/setup/state' });
    expect(r.statusCode).toBe(404);
    r = await app.inject({
      method: 'POST', url: '/api/setup/admin',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'evil@x.co', password: 'password-2', token },
    });
    expect(r.statusCode).toBe(404);
  });

  it('claim deactivates the seed row when email differs (Q1)', async () => {
    seedUsers(db, null);
    const token = ensureSetupToken(db);
    const r = await app.inject({ method: 'POST', url: '/api/setup/admin', headers: { 'content-type': 'application/json' }, payload: { email: 'op@x.co', password: 'password-1', token } });
    expect(r.statusCode).toBe(200);
    const seed = db.prepare("SELECT active FROM users WHERE email = 'admin@lionparcel.com'").get() as { active: number };
    expect(seed.active).toBe(0);
  });

  it('claim with the seed email reuses that row (R2b)', async () => {
    seedUsers(db, null);
    const token = ensureSetupToken(db);
    const r = await app.inject({ method: 'POST', url: '/api/setup/admin', headers: { 'content-type': 'application/json' }, payload: { email: 'admin@lionparcel.com', password: 'password-1', token } });
    expect(r.statusCode).toBe(200);
    const count = db.prepare("SELECT COUNT(*) AS n FROM users WHERE email LIKE '%lionparcel.com%' OR email LIKE '%@x.co%'").get() as { n: number };
    expect(count.n).toBe(1); // no duplicate admin rows beyond bots/jira
  });

  it('wrong token → 403, never claims', async () => {
    seedUsers(db, null);
    ensureSetupToken(db);
    const r = await app.inject({ method: 'POST', url: '/api/setup/admin', headers: { 'content-type': 'application/json' }, payload: { email: 'op@x.co', password: 'password-1', token: '0000-0000-0000-0000' } });
    expect(r.statusCode).toBe(403);
    expect(needsSetup(db)).toBe(true);
  });

  it('bad email / short password → 400', async () => {
    seedUsers(db, null);
    const token = ensureSetupToken(db);
    let r = await app.inject({ method: 'POST', url: '/api/setup/admin', headers: { 'content-type': 'application/json' }, payload: { email: 'nope', password: 'password-1', token } });
    expect(r.statusCode).toBe(400);
    r = await app.inject({ method: 'POST', url: '/api/setup/admin', headers: { 'content-type': 'application/json' }, payload: { email: 'op@x.co', password: 'short', token } });
    expect(r.statusCode).toBe(400);
  });

  it('cross-origin POST → 403 (CSRF guard)', async () => {
    seedUsers(db, null);
    const token = ensureSetupToken(db);
    const r = await app.inject({
      method: 'POST', url: '/api/setup/admin',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example', host: '127.0.0.1:9230' },
      payload: { email: 'op@x.co', password: 'password-1', token },
    });
    expect(r.statusCode).toBe(403);
    expect(needsSetup(db)).toBe(true);
  });

  it('non-JSON content type → 415', async () => {
    seedUsers(db, null);
    ensureSetupToken(db);
    const r = await app.inject({ method: 'POST', url: '/api/setup/admin', headers: { 'content-type': 'text/plain' }, payload: 'x' });
    expect(r.statusCode).toBe(415);
  });

  it('rate limit: 11th attempt in the window → 429', async () => {
    seedUsers(db, null);
    ensureSetupToken(db);
    let last = 0;
    for (let i = 0; i < 11; i++) {
      const r = await app.inject({ method: 'POST', url: '/api/setup/admin', headers: { 'content-type': 'application/json' }, payload: { email: 'op@x.co', password: 'password-1', token: 'x'.repeat(19) } });
      last = r.statusCode;
    }
    expect(last).toBe(429);
  });

  it('claimed admin can log in (end-to-end)', async () => {
    seedUsers(db, null);
    const token = ensureSetupToken(db);
    await app.inject({ method: 'POST', url: '/api/setup/admin', headers: { 'content-type': 'application/json' }, payload: { email: 'op@x.co', name: 'Op', password: 'password-1', token } });
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'op@x.co', password: 'password-1' } });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { user: { role: string } }).user.role).toBe('admin');
  });

  it('readiness endpoint requires admin', async () => {
    seedUsers(db, 'pin-1');
    writeSetupStamp(db, 'admin@lionparcel.com');
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@lionparcel.com', password: 'pin-1' } });
    const setCookie = login.headers['set-cookie'] as string | string[] | undefined;
    const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(raw).toBeTruthy();
    const cookie = raw!.split(';')[0]!;
    const r = await app.inject({ method: 'GET', url: '/api/setup/readiness', headers: { cookie } });
    expect(r.statusCode).toBe(200);
    const rows = (r.json() as { rows: Array<{ key: string; state: string }> }).rows;
    expect(rows.length).toBeGreaterThanOrEqual(6);
    expect(rows.map((x) => x.key)).toContain('xcodebuild');
  });
});

describe('readiness probes', () => {
  it('rows cover tokens, dirs, toolchain, smoke — never throw', async () => {
    const rows = await readinessRows({} as NodeJS.ProcessEnv);
    expect(rows.map((r) => r.key)).toEqual(expect.arrayContaining(['github_token', 'jira_token', 'repos_dir', 'packages_dir', 'xcodebuild', 'xcbuddy', 'smoke_probe']));
    for (const r of rows) expect(['ok', 'fail', 'skip']).toContain(r.state);
  });

  it('token rows flip ok when env set', async () => {
    resetProbeCache();
    const rows = await readinessRows({ CRUCIBLE_GITHUB_TOKEN: 'x', JIRA_TOKEN: 'y' } as unknown as NodeJS.ProcessEnv);
    expect(rows.find((r) => r.key === 'github_token')!.state).toBe('ok');
    expect(rows.find((r) => r.key === 'jira_token')!.state).toBe('ok');
  });

  it('smoke row skips when CRUCIBLE_SMOKE=0', async () => {
    resetProbeCache();
    const rows = await readinessRows({ CRUCIBLE_SMOKE: '0' } as NodeJS.ProcessEnv);
    expect(rows.find((r) => r.key === 'smoke_probe')!.state).toBe('skip');
  });
});

describe('rate limiter + origin (unit)', () => {
  it('originAllowed: no-origin curl ok, same-origin ok, cross blocked', () => {
    expect(originAllowed({ headers: {} })).toBe(true);
    expect(originAllowed({ headers: { origin: 'http://a:1', host: 'a:1' } })).toBe(true);
    expect(originAllowed({ headers: { origin: 'http://b:2', host: 'a:1' } })).toBe(false);
  });

  it('setupRateLimit: 10/min then blocked, window slides', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 10; i++) expect(setupRateLimit('1.2.3.4', t0 + i)).toBe(true);
    expect(setupRateLimit('1.2.3.4', t0 + 999)).toBe(false);
    expect(setupRateLimit('1.2.3.4', t0 + 61_000)).toBe(true); // window slid
    expect(setupRateLimit('9.9.9.9', t0)).toBe(true); // per-IP
  });
});
