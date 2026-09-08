/** Auth routes: local login, Jira SSO, session introspection, admin user CRUD. */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID as cryptoRandomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { createSession, destroySession, hashPassword, jiraConfigured, newUserId, userByEmail, userByJiraSubject, verifyPassword, type Role, type UserRow } from '../auth/users.ts';
import { requireRole, SESSION_COOKIE } from '../auth/roles.ts';


/** OAuth origin = the origin the browser is actually on (Host header), so the
 *  state cookie set at /start is visible at /callback through the same origin.
 *  Dev: localhost:5180 (vite proxies /api to the API server). Prod: single origin.
 *  Override with CRUCIBLE_PUBLIC_ORIGIN when behind a proxy that rewrites Host. */
function publicOrigin(req: FastifyRequest): string {
  const host = Array.isArray(req.headers['host']) ? req.headers['host'][0] : req.headers['host'];
  const fallback = '127.0.0.1:9230';
  return process.env['CRUCIBLE_PUBLIC_ORIGIN'] ?? `http://${host ?? fallback}`;
}

export function registerAuthRoutes(app: FastifyInstance, db: Database.Database): void {
  app.post('/api/auth/login', async (req, reply) => {
    const b = req.body as { email?: string; password?: string } | null;
    if (!b?.email || !b?.password) return reply.code(400).send({ error: 'email and password required' });
    const user = userByEmail(db, b.email.toLowerCase().trim());
    // uniform failure: never reveal whether the email exists
    const badCredentials = () => {
      const email = (b?.email ?? '').toLowerCase().trim();
      db.prepare('INSERT INTO auth_log(at, email, event, detail) VALUES (?, ?, ?, ?)').run(Date.now(), email, 'login_failed', 'invalid credentials');
      return reply.code(401).send({ error: 'invalid email or password' });
    };
    if (!user || user.auth_source === 'bot' || !user.password_hash || !user.active || !verifyPassword(b.password, user.password_hash)) return badCredentials();
    if (!user.approved) {
      db.prepare('INSERT INTO auth_log(at, email, user_id, event, detail) VALUES (?, ?, ?, ?, ?)').run(Date.now(), user.email, user.id, 'login_failed', 'pending admin approval');
      return reply.code(403).send({ error: 'account awaiting admin approval' });
    }
    db.prepare('INSERT INTO auth_log(at, email, user_id, event) VALUES (?, ?, ?, ?)').run(Date.now(), user.email, user.id, 'login');
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(Date.now(), user.id);
    const s = createSession(db, user.id);
    reply.header('set-cookie', `${SESSION_COOKIE}=${s.cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${12 * 60 * 60}`);
    return { user: publicUser(user) };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const cookieHeader = req.headers['cookie'];
    const cookie = typeof cookieHeader === 'string' ? cookieHeader : '';
    const m = /(?:^|;\s*)crucible_session=([a-f0-9]{64})/.exec(cookie);
    if (m?.[1]) {
      destroySession(db, m[1]);
      db.prepare('INSERT INTO auth_log(at, user_id, event) VALUES (?, ?, ?)').run(Date.now(), req.user?.id ?? null, 'logout');
    }
    reply.header('set-cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    return { user: req.user ? publicUser(req.user) : null, jiraConfigured: jiraConfigured() };
  });

  // ── Jira SSO (env-gated; 503-honest when unconfigured) ──
  app.get('/api/auth/jira/start', async (req, reply) => {
    if (!jiraConfigured()) return reply.code(503).send({ error: 'Jira SSO not configured (CRUCIBLE_JIRA_CLIENT_ID/SECRET)' });
    const clientId = process.env['CRUCIBLE_JIRA_CLIENT_ID']!;
    const redirect = `${publicOrigin(req)}/api/auth/jira/callback`;
    const state = cryptoRandomUUID();
    const url = `https://auth.atlassian.com/authorize?audience=api.atlassian.com&client_id=${clientId}&scope=read%3ame%20read%3ajira-user&redirect_uri=${encodeURIComponent(redirect)}&state=${state}&response_type=code&prompt=consent`;
    reply.header('set-cookie', `crucible_oauth_state=${state}; Path=/api/auth/jira; HttpOnly; SameSite=Lax; Max-Age=600`);
    return reply.redirect(url);
  });

  app.get('/api/auth/jira/callback', async (req, reply) => {
    if (!jiraConfigured()) return reply.code(503).send({ error: 'Jira SSO not configured' });
    const q = req.query as { code?: string; state?: string; error?: string };
    if (q.error) return reply.code(401).send({ error: `atlassian: ${q.error}` });
    if (!q.code) return reply.code(400).send({ error: 'missing code' });
    const cookieState = /(?:^|;\s*)crucible_oauth_state=([^;]+)/.exec(req.headers['cookie'] ?? '')?.[1];
    if (!q.state || !cookieState || q.state !== cookieState) return reply.code(400).send({ error: 'oauth state mismatch (re-open login)' });
    try {
      const redirect = `${publicOrigin(req)}/api/auth/jira/callback`;
      const tokenRes = await fetch('https://auth.atlassian.com/oauth/token', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ grant_type: 'authorization_code', client_id: process.env['CRUCIBLE_JIRA_CLIENT_ID'], client_secret: process.env['CRUCIBLE_JIRA_CLIENT_SECRET'], code: q.code, redirect_uri: redirect }),
      });
      const token = await tokenRes.json() as { access_token?: string };
      if (!token.access_token) throw new Error('token exchange failed');
      const meRes = await fetch('https://api.atlassian.com/me', { headers: { authorization: `Bearer ${token.access_token}` } });
      const me = await meRes.json() as { account_id?: string; email?: string; name?: string };
      if (!me.account_id || !me.email) throw new Error('profile fetch failed');

      // find by subject, then by email (link a local account to Jira), else create viewer
      let user = userByJiraSubject(db, me.account_id)
        ?? userByEmail(db, me.email.toLowerCase());
      let created = false;
      if (!user) {
        const id = newUserId();
        db.prepare(`INSERT INTO users(id, email, name, role, auth_source, jira_subject, active, approved, created_at)
                    VALUES (?, ?, ?, 'viewer', 'jira', ?, 1, 0, ?)`)
          .run(id, me.email.toLowerCase(), me.name ?? me.email.split('@')[0], me.account_id, Date.now());
        user = userByEmail(db, me.email.toLowerCase())!;
        created = true;
      } else if (user.jira_subject !== me.account_id) {
        db.prepare('UPDATE users SET jira_subject = ? WHERE id = ?').run(me.account_id, user.id);
      }
      const origin = publicOrigin(req);
      if (!user.active) return reply.redirect(`${origin}/login?error=deactivated`);
      if (!user.approved) {
        // first Jira login creates a PENDING row; admin approves in the users page.
        if (created) db.prepare('INSERT INTO auth_log(at, email, user_id, event, detail) VALUES (?, ?, ?, ?, ?)').run(Date.now(), user.email, user.id, 'jira_signup_pending', `first login — awaiting approval (${user.email})`);
        return reply.redirect(`${origin}/login?error=pending`);
      }
      db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(Date.now(), user.id);
      const s = createSession(db, user.id);
      reply.header('set-cookie', `${SESSION_COOKIE}=${s.cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${12 * 60 * 60}`);
      return reply.redirect(`${publicOrigin(req)}/`);
    } catch (err) {
      return reply.code(502).send({ error: `jira login failed: ${err instanceof Error ? err.message : 'unknown'}` });
    }
  });

  // ── user management (admin) ──
  app.get('/api/auth/log', { preHandler: requireRole('admin') }, async () => {
    const rows = db.prepare('SELECT * FROM auth_log ORDER BY at DESC LIMIT 200').all();
    return { log: rows };
  });

  app.get('/api/sessions', { preHandler: requireRole('admin') }, async () => {
    const rows = db.prepare(`SELECT s.id, s.user_id, u.name, u.email, s.created_at, s.expires_at, s.last_seen_at
                             FROM sessions s JOIN users u ON u.id = s.user_id ORDER BY s.last_seen_at DESC LIMIT 100`).all();
    return { sessions: rows.map((r) => ({ ...r as Record<string, unknown>, id: (r as { id: string }).id.slice(0, 8) })) };
  });

  app.delete('/api/sessions/:prefix', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { prefix } = req.params as { prefix: string };
    const row = db.prepare('SELECT id, user_id FROM sessions WHERE id LIKE ?').get(`${prefix}%`) as { id: string; user_id: string } | undefined;
    if (!row) return reply.code(404).send({ error: 'session not found' });
    destroySession(db, row.id);
    db.prepare('INSERT INTO auth_log(at, user_id, event, detail) VALUES (?, ?, ?, ?)').run(Date.now(), row.user_id, 'session_killed', `killed by ${req.user?.name ?? 'admin'} (prefix ${prefix})`);
    return { ok: true };
  });

  app.get('/api/users', { preHandler: requireRole('admin') }, async () => {
    const rows = db.prepare('SELECT * FROM users ORDER BY created_at').all() as UserRow[];
    return { users: rows.map(publicUser) };
  });

  app.post('/api/users', { preHandler: requireRole('admin') }, async (req, reply) => {
    const b = req.body as { email?: string; name?: string; role?: Role; password?: string } | null;
    if (!b?.email || !b.name || !b.role || !['viewer', 'operator', 'admin'].includes(b.role)) {
      return reply.code(400).send({ error: 'email, name, role (viewer|operator|admin) required' });
    }
    if (!b.password || b.password.length < 8) return reply.code(400).send({ error: 'password (min 8 chars) required' });
    const email = b.email.toLowerCase().trim();
    if (userByEmail(db, email)) return reply.code(409).send({ error: 'email already exists' });
    const id = newUserId();
    db.prepare(`INSERT INTO users(id, email, name, role, password_hash, auth_source, active, created_at)
                VALUES (?, ?, ?, ?, ?, 'local', 1, ?)`)
      .run(id, email, b.name, b.role, hashPassword(b.password), Date.now());
    return { user: publicUser(userByEmail(db, email)!) };
  });

  app.patch('/api/users/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = req.body as { role?: Role; active?: boolean; approved?: boolean; password?: string; botToken?: string } | null;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    if (!user) return reply.code(404).send({ error: 'not found' });
    if (b?.role && ['viewer', 'operator', 'admin'].includes(b.role)) {
      db.prepare('UPDATE users SET role = ? WHERE id = ?').run(b.role, id);
    }
    if (typeof b?.approved === 'boolean') {
      db.prepare('UPDATE users SET approved = ? WHERE id = ?').run(b.approved ? 1 : 0, id);
      if (b.approved) db.prepare('INSERT INTO auth_log(at, user_id, event, detail) VALUES (?, ?, ?, ?)').run(Date.now(), id, 'approved', `by ${req.user?.name ?? 'admin'}`);
      return { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow) };
    }
    if (typeof b?.active === 'boolean') {
      if (user.id === 'usr_admin01' && b.active === false) return reply.code(400).send({ error: 'cannot deactivate the bootstrap admin' });
      db.prepare('UPDATE users SET active = ? WHERE id = ?').run(b.active ? 1 : 0, id);
      if (!b.active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id); // deactivate kills sessions
    }
    if (b?.password) {
      if (b.password.length < 8) return reply.code(400).send({ error: 'password min 8 chars' });
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(b.password), id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id); // reset forces re-login
    }
    if (typeof b?.botToken === 'string') {
      // issue/rotate a per-bot agent token (bot rows only) — the value is returned ONCE here
      if (user.role !== 'bot') return reply.code(400).send({ error: 'botToken applies to bot users only' });
      if (b.botToken.length < 8) return reply.code(400).send({ error: 'token min 8 chars' });
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(b.botToken), id);
      return { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow), botToken: `${user.name}-${b.botToken}` };
    }
    return { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow) };
  });
}

function publicUser(u: UserRow): Record<string, unknown> {
  return { id: u.id, email: u.email, name: u.name, role: u.role, auth_source: u.auth_source, active: !!u.active, approved: !!u.approved, last_login_at: u.last_login_at };
}
