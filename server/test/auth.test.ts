import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { migrateM1 } from '../src/db/schema.ts';
import { registerAuthRoutes } from '../src/routes/auth.ts';
import { registerUserResolution } from '../src/auth/roles.ts';
import { seedUsers, hashPassword } from '../src/auth/users.ts';

let db: Database.Database;
let tmp: string;
let app: FastifyInstance;

function build(): FastifyInstance {
  const a = Fastify();
  registerUserResolution(a, db);
  registerAuthRoutes(a, db);
  return a;
}

const ADMIN_PW = 'bootstrap-pin-1';

function loginAs(email: string, password: string): Promise<string | null> {
  return app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } }).then((r) => {
    const setCookie = r.headers['set-cookie'] as string | string[] | undefined;
    const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    const m = /crucible_session=([a-f0-9]{64})/.exec(cookie ?? '');
    return m?.[1] ?? null;
  });
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'crucible-auth-'));
  db = new Database(join(tmp, 't.db'));
  db.pragma('journal_mode = WAL');
  migrateM1(db);
  seedUsers(db, ADMIN_PW);
  app = build();
});
afterEach(async () => {
  await app.close();
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('local login', () => {
  it('seeded admin logs in with the PIN bootstrap password; cookie set; me returns user', async () => {
    const sid = await loginAs('admin@lionparcel.com', ADMIN_PW);
    expect(sid).toBeTruthy();
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: `crucible_session=${sid}` } });
    const body = me.json() as { user: { email: string; role: string } | null };
    expect(body.user?.email).toBe('admin@lionparcel.com');
    expect(body.user?.role).toBe('admin');
  });

  it('wrong password → 401, no cookie', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@lionparcel.com', password: 'nope' } });
    expect(r.statusCode).toBe(401);
    expect(r.headers['set-cookie']).toBeUndefined();
  });

  it('unknown email → same 401 (no user enumeration)', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'ghost@x.com', password: 'x' } });
    expect(r.statusCode).toBe(401);
    expect((r.json() as { error: string }).error).toBe('invalid email or password');
  });

  it('bot account cannot log in via password', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'lioclaw@bot.local', password: 'anything' } });
    expect(r.statusCode).toBe(401);
  });

  it('logout destroys the session server-side', async () => {
    const sid = await loginAs('admin@lionparcel.com', ADMIN_PW);
    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: `crucible_session=${sid}` } });
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: `crucible_session=${sid}` } });
    expect((me.json() as { user: unknown }).user).toBeNull();
  });
});

describe('role guards', () => {
  it('viewer 403 on operator route, operator passes', async () => {
    db.prepare(`INSERT INTO users(id,email,name,role,password_hash,auth_source,active,created_at)
                VALUES ('usr_v1','v@x.com','v','viewer',?,'local',1,?)`).run(hashPassword('viewerpass1'), Date.now());
    db.prepare(`INSERT INTO users(id,email,name,role,password_hash,auth_source,active,created_at)
                VALUES ('usr_o1','o@x.com','o','operator',?,'local',1,?)`).run(hashPassword('operpass12'), Date.now());
    // users CRUD is admin-gated: viewer + operator both 403
    for (const email of ['v@x.com', 'o@x.com']) {
      const sid = await loginAs(email, email === 'v@x.com' ? 'viewerpass1' : 'operpass12');
      const r = await app.inject({ method: 'GET', url: '/api/users', headers: { cookie: `crucible_session=${sid}` } });
      expect(r.statusCode).toBe(403);
    }
    const adminSid = await loginAs('admin@lionparcel.com', ADMIN_PW);
    const ok = await app.inject({ method: 'GET', url: '/api/users', headers: { cookie: `crucible_session=${adminSid}` } });
    expect(ok.statusCode).toBe(200);
  });

  it('unauthenticated → 401', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/users' });
    expect(r.statusCode).toBe(401);
  });

  it('deactivated user sessions die and login is refused', async () => {
    db.prepare(`INSERT INTO users(id,email,name,role,password_hash,auth_source,active,created_at)
                VALUES ('usr_v2','g@x.com','g','operator',?,'local',1,?)`).run(hashPassword('goodpass12'), Date.now());
    const sid = await loginAs('g@x.com', 'goodpass12');
    expect(sid).toBeTruthy();
    db.prepare('UPDATE users SET active = 0 WHERE id = ?').run('usr_v2');
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: `crucible_session=${sid}` } });
    expect((me.json() as { user: unknown }).user).toBeNull();
    const again = await loginAs('g@x.com', 'goodpass12');
    expect(again).toBeNull();
  });
});

describe('user management (admin)', () => {
  let adminSid: string;
  beforeEach(async () => { adminSid = (await loginAs('admin@lionparcel.com', ADMIN_PW))!; });
  const H = () => ({ cookie: `crucible_session=${adminSid}` });

  it('create user → login works with the issued password', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/users', headers: H(), payload: { email: 'dita@lionparcel.com', name: 'dita', role: 'operator', password: 'dita-pass-1' } });
    expect(r.statusCode).toBe(200);
    const sid = await loginAs('dita@lionparcel.com', 'dita-pass-1');
    expect(sid).toBeTruthy();
  });

  it('role change applies immediately; password reset kills sessions', async () => {
    await app.inject({ method: 'POST', url: '/api/users', headers: H(), payload: { email: 'q@x.com', name: 'q', role: 'viewer', password: 'viewerpass1' } });
    const row = db.prepare("SELECT id FROM users WHERE email = 'q@x.com'").get() as { id: string };
    const sid = await loginAs('q@x.com', 'viewerpass1');
    await app.inject({ method: 'PATCH', url: `/api/users/${row.id}`, headers: H(), payload: { role: 'operator' } });
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: `crucible_session=${sid}` } });
    expect((me.json() as { user: { role: string } }).user.role).toBe('operator');
    await app.inject({ method: 'PATCH', url: `/api/users/${row.id}`, headers: H(), payload: { password: 'new-pass-99' } });
    const dead = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: `crucible_session=${sid}` } });
    expect((dead.json() as { user: unknown }).user).toBeNull();
  });

  it('admin mutations leave an audit trail in auth_log (actor, target, event)', async () => {
    await app.inject({ method: 'POST', url: '/api/users', headers: H(), payload: { email: 'audit@x.com', name: 'audit', role: 'viewer', password: 'viewerpass1' } });
    const row = db.prepare("SELECT id FROM users WHERE email = 'audit@x.com'").get() as { id: string };
    // role change → logged
    await app.inject({ method: 'PATCH', url: `/api/users/${row.id}`, headers: H(), payload: { role: 'operator' } });
    // password reset → logged, value never appears
    await app.inject({ method: 'PATCH', url: `/api/users/${row.id}`, headers: H(), payload: { password: 'rotated-pass-9' } });
    // deactivate → logged
    await app.inject({ method: 'PATCH', url: `/api/users/${row.id}`, headers: H(), payload: { active: false } });
    const events = db.prepare('SELECT event, detail, email FROM auth_log WHERE user_id = ? ORDER BY id').all(row.id) as Array<{ event: string; detail: string; email: string }>;
    const names = events.map((e) => e.event);
    expect(names).toContain('role_changed');
    expect(names).toContain('password_changed');
    expect(names).toContain('active_changed');
    // detail names actor and transition, never the secret
    const pw = events.find((e) => e.event === 'password_changed')!;
    expect(pw.detail).toContain('by admin');
    expect(pw.detail).not.toContain('rotated-pass-9');
    // target identity recorded on every row
    for (const e of events) expect(e.email).toBe('audit@x.com');
    // no-op PATCH (same role) → not logged
    await app.inject({ method: 'PATCH', url: `/api/users/${row.id}`, headers: H(), payload: { role: 'operator' } });
    const again = db.prepare("SELECT COUNT(*) AS c FROM auth_log WHERE user_id = ? AND event = 'role_changed'").get(row.id) as { c: number };
    expect(again.c).toBe(1);
  });

  it('bootstrap admin cannot be deactivated', async () => {
    const r = await app.inject({ method: 'PATCH', url: '/api/users/usr_admin01', headers: H(), payload: { active: false } });
    expect(r.statusCode).toBe(400);
  });

  it('jira unconfigured is reported honestly', async () => {
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: H() });
    expect((me.json() as { jiraConfigured: boolean }).jiraConfigured).toBe(false);
    const start = await app.inject({ method: 'GET', url: '/api/auth/jira/start' });
    expect(start.statusCode).toBe(503);
  });
});

describe('bot resolution', () => {
  it('agent token resolves to a bot user for audit identity', async () => {
    process.env['CRUCIBLE_AGENT_TOKEN'] = 'lioclaw-secret-1';
    const a = build();
    const me = await a.inject({ method: 'GET', url: '/api/auth/me', headers: { 'x-crucible-agent': 'lioclaw-secret-1' } });
    const body = me.json() as { user: { name: string; role: string } | null };
    expect(body.user?.name).toBe('lioclaw');
    expect(body.user?.role).toBe('bot');
    delete process.env['CRUCIBLE_AGENT_TOKEN'];
    await a.close();
  });
});
