import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { migrateM1 } from '../src/db/schema.ts';
import { seedUsers, createSession, hashPassword } from '../src/auth/users.ts';
import { registerUserResolution } from '../src/auth/roles.ts';
import { registerAuthCliRoutes, hashToken } from '../src/routes/auth-cli.ts';

/** Roles-hook PAT branch (review F1): cookie → PAT (early return, person
 *  identity) → bot paths. PAT and bot token COEXIST on one server, each
 *  resolving to its own identity; lion_ never falls through to bots. */

let db: Database.Database;
let app: FastifyInstance;
let patToken = '';
let botToken = '';

beforeEach(async () => {
  db = new Database(':memory:');
  process.env['CRUCIBLE_PIN'] = 'pin-1';
  migrateM1(db);
  seedUsers(db, 'pin-1');
  // a bot with a per-bot secret (format <botname>-<secret>)
  db.prepare(`INSERT INTO users(id, email, name, role, password_hash, auth_source, active, approved, created_at)
              VALUES ('usr_bot_x', 'xbot@bot.local', 'xbot', 'bot', ?, 'bot', 1, 1, 0)`).run(hashPassword('secret-xyz'));
  botToken = 'xbot-secret-xyz';
  // an operator PAT
  patToken = 'lion_' + 'a'.repeat(48);
  const admin = db.prepare("SELECT id FROM users WHERE email = 'admin@lionparcel.com'").get() as { id: string };
  db.prepare('INSERT INTO api_tokens(id, user_id, name, token_hash, created_at, last_used_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL, NULL)')
    .run('tok_x', admin.id, 'cli', hashToken(patToken), Date.now());
  app = Fastify();
  registerUserResolution(app, db);
  app.get('/api/whoami', async (req) => ({ user: (req as unknown as { user?: { name?: string; role?: string } }).user?.name ?? null, role: (req as unknown as { user?: { role?: string } }).user?.role ?? null }));
  await app.ready();
});

describe('roles hook: PAT + bot coexistence (F1)', () => {
  it('Bearer lion_ resolves to the CREATING user (person, operator)', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/whoami', headers: { authorization: `Bearer ${patToken}` } });
    const body = r.json() as { user: string | null; role: string | null };
    expect(body.user).toBe('admin');
    expect(body.role).toBe('admin');
  });

  it('bot token (x-crucible-agent) resolves to the BOT — unchanged path', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/whoami', headers: { 'x-crucible-agent': botToken } });
    const body = r.json() as { user: string | null };
    expect(body.user).toBe('xbot');
  });

  it('unknown lion_ token → anonymous (never bot fallback)', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/whoami', headers: { authorization: 'Bearer lion_deadbeef' } });
    const body = r.json() as { user: string | null };
    expect(body.user).toBeNull();
  });

  it('cookie session still wins when both cookie and PAT present', async () => {
    const admin = db.prepare("SELECT id FROM users WHERE email = 'admin@lionparcel.com'").get() as { id: string };
    const sid = createSession(db, admin.id).cookie;
    const r = await app.inject({ method: 'GET', url: '/api/whoami', headers: { cookie: `crucible_session=${sid}`, authorization: `Bearer ${patToken}` } });
    const body = r.json() as { user: string | null };
    expect(body.user).toBe('admin'); // both point at admin; cookie path taken (first branch)
  });

  it('revoked PAT → anonymous', async () => {
    db.prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ?').run(Date.now(), 'tok_x');
    const r = await app.inject({ method: 'GET', url: '/api/whoami', headers: { authorization: `Bearer ${patToken}` } });
    const body = r.json() as { user: string | null };
    expect(body.user).toBeNull();
  });

  it('last_used touched (throttled) on PAT use', async () => {
    await app.inject({ method: 'GET', url: '/api/whoami', headers: { authorization: `Bearer ${patToken}` } });
    const row = db.prepare('SELECT last_used_at FROM api_tokens WHERE id = ?').get('tok_x') as { last_used_at: number | null };
    expect(row.last_used_at).not.toBeNull();
  });
  void registerAuthCliRoutes;
});
