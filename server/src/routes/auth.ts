/** Auth routes: local login, Jira SSO, session introspection, admin user CRUD. */
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { createSession, destroySession, hashPassword, jiraConfigured, newUserId, userByEmail, userByJiraSubject, verifyPassword, type Role, type UserRow } from '../auth/users.ts';
import { requireRole, SESSION_COOKIE } from '../auth/roles.ts';

export function registerAuthRoutes(app: FastifyInstance, db: Database.Database): void {
  app.post('/api/auth/login', async (req, reply) => {
    const b = req.body as { email?: string; password?: string } | null;
    if (!b?.email || !b?.password) return reply.code(400).send({ error: 'email and password required' });
    const user = userByEmail(db, b.email.toLowerCase().trim());
    // uniform failure: never reveal whether the email exists
    if (!user || user.auth_source === 'bot' || !user.password_hash || !user.active || !verifyPassword(b.password, user.password_hash)) {
      return reply.code(401).send({ error: 'invalid email or password' });
    }
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(Date.now(), user.id);
    const s = createSession(db, user.id);
    reply.header('set-cookie', `${SESSION_COOKIE}=${s.cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${12 * 60 * 60}`);
    return { user: publicUser(user) };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const cookieHeader = req.headers['cookie'];
    const cookie = typeof cookieHeader === 'string' ? cookieHeader : '';
    const m = /(?:^|;\s*)crucible_session=([a-f0-9]{64})/.exec(cookie);
    if (m?.[1]) destroySession(db, m[1]);
    reply.header('set-cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    return { user: req.user ? publicUser(req.user) : null, jiraConfigured: jiraConfigured() };
  });

  // ── Jira SSO (env-gated; 503-honest when unconfigured) ──
  app.get('/api/auth/jira/start', async (_req, reply) => {
    if (!jiraConfigured()) return reply.code(503).send({ error: 'Jira SSO not configured (CRUCIBLE_JIRA_CLIENT_ID/SECRET)' });
    const clientId = process.env['CRUCIBLE_JIRA_CLIENT_ID']!;
    const redirect = `http://${process.env['CRUCIBLE_HOST'] ?? '127.0.0.1:9230'}/api/auth/jira/callback`;
    const url = `https://auth.atlassian.com/authorize?audience=api.atlassian.com&client_id=${clientId}&scope=read%3ame%20read%3ajira-user&redirect_uri=${encodeURIComponent(redirect)}&state=${Math.random().toString(36).slice(2)}&response_type=code&prompt=consent`;
    return reply.redirect(url);
  });

  app.get('/api/auth/jira/callback', async (req, reply) => {
    if (!jiraConfigured()) return reply.code(503).send({ error: 'Jira SSO not configured' });
    const q = req.query as { code?: string };
    if (!q.code) return reply.code(400).send({ error: 'missing code' });
    try {
      const redirect = `http://${process.env['CRUCIBLE_HOST'] ?? '127.0.0.1:9230'}/api/auth/jira/callback`;
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
      if (!user) {
        const id = newUserId();
        db.prepare(`INSERT INTO users(id, email, name, role, auth_source, jira_subject, active, created_at)
                    VALUES (?, ?, ?, 'viewer', 'jira', ?, 1, ?)`)
          .run(id, me.email.toLowerCase(), me.name ?? me.email.split('@')[0], me.account_id, Date.now());
        user = userByEmail(db, me.email.toLowerCase())!;
      } else if (user.jira_subject !== me.account_id) {
        db.prepare('UPDATE users SET jira_subject = ? WHERE id = ?').run(me.account_id, user.id);
      }
      if (!user.active) return reply.code(403).send({ error: 'account deactivated' });
      db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(Date.now(), user.id);
      const s = createSession(db, user.id);
      reply.header('set-cookie', `${SESSION_COOKIE}=${s.cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${12 * 60 * 60}`);
      return reply.redirect('/');
    } catch (err) {
      return reply.code(502).send({ error: `jira login failed: ${err instanceof Error ? err.message : 'unknown'}` });
    }
  });

  // ── user management (admin) ──
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
    const b = req.body as { role?: Role; active?: boolean; password?: string } | null;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    if (!user) return reply.code(404).send({ error: 'not found' });
    if (b?.role && ['viewer', 'operator', 'admin'].includes(b.role)) {
      db.prepare('UPDATE users SET role = ? WHERE id = ?').run(b.role, id);
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
    return { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow) };
  });
}

function publicUser(u: UserRow): Record<string, unknown> {
  return { id: u.id, email: u.email, name: u.name, role: u.role, auth_source: u.auth_source, active: !!u.active, last_login_at: u.last_login_at };
}
