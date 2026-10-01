/** PAT (personal access token) routes — the CLI's auth (plan 20260930T092035Z
 *  stage 1, review F1). Tokens: lion_<hex>, stored SCRYPT-HASHED, plaintext
 *  shown exactly once. Three minting/review surfaces:
 *   - POST /api/auth/token       paste-flow mint (operator session) — CI boxes
 *   - POST /api/auth/cli/start|approve|exchange   device-approval flow:
 *     the user approves in the WEB UI where they're already logged in
 *   - GET/DELETE /api/auth/tokens[/id]  list (metadata only) / revoke
 *  Bearer resolution lives in auth/roles.ts (ordered: cookie → PAT → bots). */
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { requireRole } from '../auth/roles.ts';

type UserRow = { id: string; email: string; name: string; role: string };

interface PendingApproval { code: string; created_at: number; approved_user_id: string | null }
const pending = new Map<string, PendingApproval>();

export function hashToken(plain: string): string {
  const salt = randomBytes(16);
  const dk = scryptSync(plain, salt, 32);
  return `${salt.toString('hex')}:${dk.toString('hex')}`;
}

export function verifyToken(plain: string, stored: string): boolean {
  const [saltHex, dkHex] = stored.split(':');
  if (!saltHex || !dkHex) return false;
  const dk = scryptSync(plain, Buffer.from(saltHex, 'hex'), 32);
  return timingSafeEqual(dk, Buffer.from(dkHex, 'hex'));
}

/** resolve a lion_ token to its FULL user row — the roles hook assigns
 *  req.user directly (shape parity with session resolution). */
export function resolvePat(db: Database.Database, token: string): unknown | null {
  type Row = { id: string; token_hash: string };
  const rows = db.prepare('SELECT t.id, t.token_hash FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.revoked_at IS NULL AND u.active = 1').all() as Array<Row>;
  for (const row of rows) {
    if (verifyToken(token, row.token_hash)) {
      // throttled last_used touch (1/min) — no write storm per request
      db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)').run(Date.now(), row.id, Date.now() - 60_000);
      const user = db.prepare('SELECT * FROM users WHERE id = (SELECT user_id FROM api_tokens WHERE id = ?)').get(row.id);
      return user ?? null;
    }
  }
  return null;
}

function mint(db: Database.Database, user: { id: string }, name: string): { id: string; token: string } {
  const id = `tok_${randomBytes(6).toString('hex')}`;
  const token = `lion_${randomBytes(24).toString('hex')}`;
  db.prepare('INSERT INTO api_tokens(id, user_id, name, token_hash, created_at, last_used_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL, NULL)')
    .run(id, user.id, name, hashToken(token), Date.now());
  return { id, token };
}

export function registerAuthCliRoutes(app: FastifyInstance, db: Database.Database): void {
  app.post('/api/auth/token', { preHandler: requireRole('operator') }, async (req, reply) => {
    const b = (req.body ?? {}) as { name?: string };
    const name = (b.name ?? '').trim() || 'cli';
    const { id, token } = mint(db, req.user as { id: string }, name.slice(0, 64));
    // plaintext shown ONCE — the row only ever holds the hash
    return { id, token, note: 'store this token now — it cannot be shown again' };
  });

  app.post('/api/auth/cli/start', async () => {
    const code = randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
    pending.set(code, { code, created_at: Date.now(), approved_user_id: null });
    // GC stale entries (>10 min)
    for (const [k, v] of pending) if (Date.now() - v.created_at > 10 * 60_000) pending.delete(k);
    return { code, url: `/settings/cli-approve?code=${code}`, expires_in_ms: 10 * 60_000 };
  });

  app.post('/api/auth/cli/approve', { preHandler: requireRole('operator') }, async (req, reply) => {
    const { code } = (req.body ?? {}) as { code?: string };
    if (!code) return reply.code(400).send({ error: 'code required' });
    const entry = pending.get(code);
    if (!entry) return reply.code(404).send({ error: 'unknown or expired code' });
    if (entry.approved_user_id) return reply.code(409).send({ error: 'already approved' });
    entry.approved_user_id = (req.user as { id: string }).id;
    return { ok: true };
  });

  app.post('/api/auth/cli/exchange', async (req, reply) => {
    const { code } = (req.body ?? {}) as { code?: string };
    if (!code) return reply.code(400).send({ error: 'code required' });
    const entry = pending.get(code);
    if (!entry) return reply.code(404).send({ error: 'unknown or expired code' });
    if (entry.approved_user_id === null || entry.approved_user_id === undefined) return reply.code(403).send({ error: 'not approved yet — approve in the web UI' });
    const approver: string = entry.approved_user_id;
    const { id, token } = mint(db, { id: approver }, `cli-${new Date().toISOString().slice(0, 10)}`);
    pending.delete(code); // single-use
    return { id, token };
  });

  app.get('/api/auth/tokens', { preHandler: requireRole('operator') }, async (req) => {
    const uid = (req.user as { id: string }).id;
    return db.prepare('SELECT id, name, created_at, last_used_at, revoked_at FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC').all(uid);
  });

  app.delete('/api/auth/tokens/:id', { preHandler: requireRole('operator') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = db.prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL').run(Date.now(), id, (req.user as { id: string }).id);
    if (r.changes === 0) return reply.code(404).send({ error: 'no such token' });
    return { ok: true };
  });
}
