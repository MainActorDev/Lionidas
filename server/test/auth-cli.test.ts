import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { migrateM1 } from '../src/db/schema.ts';
import { seedUsers, createSession } from '../src/auth/users.ts';
import { registerAuthCliRoutes } from '../src/routes/auth-cli.ts';

/** PAT server additions (plan 20260930T092035Z rev 2 stage 1, review F1):
 *  api_tokens (hashed, scrypt), Bearer lion_<hex> resolution ordered AFTER
 *  cookie session and BEFORE bot paths — PAT and bot tokens coexist, each
 *  resolving to its own identity. Approval flow mints from a logged-in web
 *  session; paste route for CI; list/revoke. */

let db: Database.Database;
let app: FastifyInstance;
let adminSid = '';
let viewerSid = '';

const ADMIN = { email: 'admin@lionparcel.com', password: 'pin-1' };

/** sessions minted directly (the login ROUTE isn't part of this mini-app —
 *  these tests exercise the token routes, not login). */
function login(email: string): string {
  const u = db.prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: string };
  return createSession(db, u.id).cookie;
}

function bearer(token: string): Record<string, string> { return { authorization: `Bearer ${token}` }; }

beforeEach(async () => {
  db = new Database(':memory:');
  process.env['CRUCIBLE_PIN'] = 'pin-1';
  migrateM1(db);
  db.prepare(`INSERT INTO users(id, email, name, role, auth_source, active, approved, created_at) VALUES ('usr_v1', 'viewer@local', 'viewer', 'viewer', 'local', 1, 1, 0)`).run();
  seedUsers(db, 'pin-1'); // buildApp does this; the route-level harness must too
  app = Fastify();
  app.addHook('onRequest', async (req) => {
    // minimal user resolution for these route tests: cookie → user (roles
    // hook behavior is pinned separately in auth-cli-hook tests)
    const cookie = (req.headers['cookie'] as string | undefined) ?? '';
    const m = /crucible_session=([a-f0-9]{64})/.exec(cookie);
    if (m?.[1]) {
      const row = db.prepare('SELECT s.user_id FROM sessions s WHERE s.id = ?').get(m[1]) as { user_id: string } | undefined;
      if (row) {
        const u = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id) as Record<string, unknown>;
        if (u) (req as unknown as { user: unknown }).user = u;
      }
    }
  });
  registerAuthCliRoutes(app, db);
  await app.ready();
  adminSid = login(ADMIN.email);
  viewerSid = login('viewer@local');
});

describe('PAT minting', () => {
  it('paste route: operator session mints a lion_ token (shown once, hashed)', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/token', payload: { name: 'ci' }, headers: { cookie: `crucible_session=${adminSid}` } });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { token?: string };
    expect(body.token).toMatch(/^lion_[a-f0-9]{48,}$/);
    const row = db.prepare('SELECT token_hash, name, revoked_at FROM api_tokens').get() as { token_hash: string; name: string; revoked_at: string | null };
    expect(row.name).toBe('ci');
    expect(row.token_hash).not.toContain(body.token!);
    expect(row.revoked_at).toBeNull();
  });

  it('viewer (non-operator) cannot mint; anonymous cannot', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/token', payload: { name: 'x' }, headers: { cookie: `crucible_session=${viewerSid}` } });
    expect(r.statusCode).toBe(403);
    const r2 = await app.inject({ method: 'POST', url: '/api/auth/token', payload: { name: 'x' } });
    expect(r2.statusCode).toBe(401);
  });
});

describe('approval flow', () => {
  it('start → code+url; approve with operator session → CLI exchange gets a PAT', async () => {
    const start = await app.inject({ method: 'POST', url: '/api/auth/cli/start' });
    expect(start.statusCode).toBe(200);
    const { code } = start.json() as { code: string };
    expect(code).toMatch(/^[A-Z0-9]{6}$/);
    // not yet approved: exchange 403s
    const early = await app.inject({ method: 'POST', url: '/api/auth/cli/exchange', payload: { code } });
    expect(early.statusCode).toBe(403);
    // approve via the WEB session (the one-click "already logged in" moment)
    const ok = await app.inject({ method: 'POST', url: '/api/auth/cli/approve', payload: { code }, headers: { cookie: `crucible_session=${adminSid}` } });
    expect(ok.statusCode).toBe(200);
    const ex = await app.inject({ method: 'POST', url: '/api/auth/cli/exchange', payload: { code } });
    expect(ex.statusCode).toBe(200);
    const { token } = ex.json() as { token: string };
    expect(token).toMatch(/^lion_/);
    // single-use: second exchange fails (code consumed → 404)
    const ex2 = await app.inject({ method: 'POST', url: '/api/auth/cli/exchange', payload: { code } });
    expect(ex2.statusCode).toBe(404);
  });

  it('approve requires an operator session', async () => {
    const start = await app.inject({ method: 'POST', url: '/api/auth/cli/start' });
    const { code } = start.json() as { code: string };
    const r = await app.inject({ method: 'POST', url: '/api/auth/cli/approve', payload: { code }, headers: { cookie: `crucible_session=${viewerSid}` } });
    expect(r.statusCode).toBe(403);
  });
});

describe('token list / revoke', () => {
  it('lists with metadata (never the token); revoke makes it dead', async () => {
    const mint = await app.inject({ method: 'POST', url: '/api/auth/token', payload: { name: 't1' }, headers: { cookie: `crucible_session=${adminSid}` } });
    const { id } = mint.json() as { id: string };
    const list = await app.inject({ method: 'GET', url: '/api/auth/tokens', headers: { cookie: `crucible_session=${adminSid}` } });
    const tokens = list.json() as Array<{ id: string; name: string; last_used_at: number | null }>;
    expect(tokens.some((t) => t.id === id && t.name === 't1')).toBe(true);
    expect(JSON.stringify(tokens)).not.toContain('lion_');
    const rev = await app.inject({ method: 'DELETE', url: `/api/auth/tokens/${id}`, headers: { cookie: `crucible_session=${adminSid}` } });
    expect(rev.statusCode).toBe(200);
    const list2 = await app.inject({ method: 'GET', url: '/api/auth/tokens', headers: { cookie: `crucible_session=${adminSid}` } });
    expect(((list2.json()) as Array<{ id: string }>).some((t) => t.id === id)).toBe(false);
  });
});
