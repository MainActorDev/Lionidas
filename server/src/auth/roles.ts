/** Role guards + req.user middleware — replaces the PIN gates.
 *  Humans: cookie session. Machines: agent token resolves to a bot user.
 *  The old requirePin/requirePinOrAgent die with this module's adoption. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { resolveSession, userForAgentToken, verifyPassword, type Role, type UserRow } from './users.ts';

declare module 'fastify' {
  interface FastifyRequest {
    user?: UserRow;
  }
}

const COOKIE = 'crucible_session';

function constantEq(a: string, b: string): boolean {
  const ba = Buffer.from(a); const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function extractAgentToken(req: FastifyRequest): string | null {
  const h = req.headers;
  const ha = h['x-crucible-agent'];
  if (typeof ha === 'string') return ha;
  const auth = h['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer crucible-')) return auth.slice('Bearer crucible-'.length);
  return null;
}

/** onRequest: resolve req.user from cookie session OR agent token (bot). */
/** Internal service token: minted once per boot, lets server-side self-calls
 *  (playback stream gate, stream relay) pass the auth gate as the lioclaw bot.
 *  Random per process; never persisted, never leaves localhost. */
const BOOT_SECRET = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
export function internalAuthHeaders(): Record<string, string> {
  return { 'x-crucible-agent': `crucible-${BOOT_SECRET}` };
}
export function isInternalToken(token: string | undefined): boolean {
  return token === `crucible-${BOOT_SECRET}`;
}

export function registerUserResolution(app: FastifyInstance, db: Database.Database): void {
  app.addHook('onRequest', async (req) => {
    const cookieHeader = req.headers['cookie'];
    const cookie = typeof cookieHeader === 'string' ? cookieHeader : cookieHeader?.[0] ?? '';
    const m = /(?:^|;\s*)crucible_session=([a-f0-9]{64})/.exec(cookie);
    if (m) {
      const user = m[1] ? resolveSession(db, m[1]) : undefined;
      if (user) {
        req.user = user;
        return;
      }
    }
    const token = extractAgentToken(req);
    if (token && isInternalToken(token)) {
      const svc = db.prepare("SELECT * FROM users WHERE role = 'bot' AND active = 1 AND approved = 1 AND name = 'lioclaw'").get() as UserRow | undefined;
      if (svc) req.user = svc; // internal self-call rides as lioclaw
      return;
    }
    if (token) {
      // per-bot tokens first: each bot's own secret (stored scrypt in its row).
      // token format: <botname>-<secret> so we know which row to check.
      const botName = token.split('-')[0] ?? '';
      const bot = db.prepare("SELECT * FROM users WHERE role = 'bot' AND active = 1 AND (name = ? OR email = ?)").get(botName, `${botName}@bot.local`) as import('./users.ts').UserRow | undefined;
      if (bot?.password_hash && verifyPassword(token.slice(botName.length + 1), bot.password_hash)) {
        req.user = bot;
      } else {
        // legacy shared token (transition) — maps to its prefix bot, else lioclaw,
        // else any active bot (minimal DBs may seed only one machine identity).
        const cfgAgent = process.env['CRUCIBLE_AGENT_TOKEN'] || null;
        if (cfgAgent && constantEq(token, cfgAgent)) {
          const fallback = userForAgentToken(db, token) ?? userForAgentToken(db, 'lioclaw')
            ?? db.prepare("SELECT * FROM users WHERE role = 'bot' AND active = 1 AND approved = 1 ORDER BY name LIMIT 1").get() as UserRow | undefined;
          if (fallback) req.user = fallback;
        }
      }
    }
  });
}

/** Any authenticated user (human or bot). */
export function requireUser(): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (req, reply) => {
    if (req.user) return;
    await reply.code(401).send({ error: 'sign in required' });
  };
}

/** One of the given roles. Bots count as operators for pipeline routes. */
export function requireRole(...roles: Role[]): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (req, reply) => {
    if (!req.user) return void (await reply.code(401).send({ error: 'sign in required' }));
    if (roles.includes(req.user.role)) return;
    // bot sessions pass operator-tier routes (they ARE the pipelines)
    if (req.user.role === 'bot' && roles.includes('operator')) return;
    await reply.code(403).send({ error: `requires role: ${roles.join(' or ')}` });
  };
}

export { COOKIE as SESSION_COOKIE };
