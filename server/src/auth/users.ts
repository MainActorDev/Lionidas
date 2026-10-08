/** Auth domain: users, sessions, scrypt password hashing, seeding.
 *  Local users are admin-provisioned (no self-registration); Jira SSO
 *  auto-creates viewers on first login; bots are seeded rows the agent
 *  token resolves to. Sessions are server-side rows keyed by an httpOnly
 *  cookie value. */
import type Database from 'better-sqlite3';
import { randomBytes, scryptSync, timingSafeEqual, randomUUID } from 'node:crypto';

export type Role = 'viewer' | 'operator' | 'admin' | 'bot';

export interface UserRow {
  approved: number;
  id: string; email: string; name: string; role: Role;
  password_hash: string | null; auth_source: string; jira_subject: string | null;
  active: number; created_at: number; last_login_at: number | null;
}

// ── passwords: scrypt (node:crypto, zero deps). Format: salt$hash, both hex. ──
export function hashPassword(plain: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(plain, salt, 64);
  return `${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split('$');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(plain, Buffer.from(saltHex, 'hex'), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// ── seeding: idempotent, on every boot ──
export function seedUsers(db: Database.Database, adminBootstrapPassword: string | null): void {
  const now = Date.now();
  const upsert = db.prepare(`INSERT INTO users(id, email, name, role, password_hash, auth_source, active, approved, created_at)
                             VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?)
                             ON CONFLICT(email) DO NOTHING`);
  upsert.run('usr_admin01', 'admin@lionparcel.com', 'admin', 'admin', adminBootstrapPassword ? hashPassword(adminBootstrapPassword) : null, 'local', now);
  upsert.run('usr_botlioc', 'lioclaw@bot.local', 'lioclaw', 'bot', null, 'bot', now);
  upsert.run('usr_botguvn', 'guvnor@bot.local', 'guvnor', 'bot', null, 'bot', now);
  if (!adminBootstrapPassword) {
    // Wizard-aware seeding (setup-wizard round): in the wizard era (default)
    // the generate-and-print fallback NEVER fires — an unclaimed instance
    // keeps the window open (boot prints the claim token), a claimed one has
    // its admin already; locked-out recovery is the reset-password CLI, not a
    // printed credential. Legacy generate-and-print only when explicitly
    // disabled via CRUCIBLE_SETUP_MODE=off (headless/legacy installs).
    if (process.env['CRUCIBLE_SETUP_MODE'] !== 'off') return;
    // no PIN env: generate a one-time password ONLY when admin has no password
    // yet (first boot). Later boots keep the existing hash — regenerating every
    // restart would silently invalidate the credential mid-stream (found live:
    // tsx-watch restarts cycled passwords while the row survived).
    const admin = db.prepare("SELECT password_hash FROM users WHERE email = 'admin@lionparcel.com'").get() as { password_hash: string | null } | undefined;
    if (admin && !admin.password_hash) {
      const generated = randomBytes(9).toString('base64url');
      db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(hashPassword(generated), 'admin@lionparcel.com');
      console.warn(`[auth] seeded admin@lionparcel.com with generated password (shown once): ${generated}`);
    }
  }
}

// ── lookups ──
export function userByEmail(db: Database.Database, email: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email) as UserRow | undefined;
}

export function userById(db: Database.Database, id: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
}

export function userByJiraSubject(db: Database.Database, subject: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE jira_subject = ?').get(subject) as UserRow | undefined;
}

// ── sessions (cookie value = sessions.id) ──
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export function createSession(db: Database.Database, userId: string): { cookie: string; expiresAt: number } {
  const id = randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare('INSERT INTO sessions(id, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)').run(id, userId, now, now + SESSION_TTL_MS, now);
  return { cookie: id, expiresAt: now + SESSION_TTL_MS };
}

/** Validate + slide. Returns the user when the session is live and active. */
export function resolveSession(db: Database.Database, cookie: string): UserRow | undefined {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(cookie) as
    | { id: string; user_id: string; expires_at: number; last_seen_at: number }
    | undefined;
  if (!row) return undefined;
  const now = Date.now();
  if (row.expires_at < now) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(cookie);
    return undefined;
  }
  const user = userById(db, row.user_id);
  if (!user || !user.active || !user.approved) return undefined; // pending users have no valid session
  // sliding expiry: touching keeps you in; idle 12h drops you
  db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?').run(now, now + SESSION_TTL_MS, cookie);
  return user;
}

export function destroySession(db: Database.Database, cookie: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(cookie);
}

/** Bot resolution for the agent token: the configured token maps to its bot
 *  user so machine actions get a real identity in audit columns. */
export function userForAgentToken(db: Database.Database, agentToken: string | null): UserRow | undefined {
  if (!agentToken) return undefined;
  // token format: <botname>-<secret> — the prefix names the bot user
  const botName = agentToken.split('-')[0];
  const row = db.prepare("SELECT * FROM users WHERE role = 'bot' AND name = ? AND active = 1").get(botName) as UserRow | undefined;
  return row; // caller still constant-time-compares the token itself (gate.ts)
}

export function jiraConfigured(): boolean {
  return Boolean(process.env['CRUCIBLE_JIRA_CLIENT_ID'] && process.env['CRUCIBLE_JIRA_CLIENT_SECRET']);
}

export function newUserId(): string {
  return `usr_${randomUUID().slice(0, 8)}`;
}
