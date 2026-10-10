/** Role guards + req.user middleware — replaces the PIN gates.
 *  Humans: cookie session. Machines: agent token resolves to a bot user.
 *  The old requirePin/requirePinOrAgent die with this module's adoption. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { resolveSession, userForAgentToken, verifyPassword, roleAtLeast, type Role, type UserRow } from './users.ts';
import { resolvePat } from '../routes/auth-cli.ts';

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
    // PAT (plan 20260930T092035Z F1): Bearer lion_<hex> resolves to the
    // CREATING user (a person, not a bot) — checked BEFORE agent/bot tokens
    // and never falls through to bot paths. The lion_ prefix disambiguates
    // from the existing Bearer crucible-… bot tokens.
    const authHeader = req.headers['authorization'];
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer lion_')) {
      const pat = resolvePat(db, authHeader.slice('Bearer '.length)) as UserRow | null;
      if (pat) {
        req.user = pat;
        return;
      }
      // unknown/revoked PAT: fall to anonymous (401 by route gates) — never bot
      return;
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

/** Hierarchy gate (RBAC round): the caller's human role must be at least
 *  `min` in ROLE_HIERARCHY (viewer < operator < supervisor < admin). Bots
 *  NEVER pass a hierarchy check — the existing requireRole bot rule
 *  (bot counts as operator) only applies to the explicit-list form.
 *  Admin passes everything (mirrors requireRole's implicit admin allow). */
export function requireRoleAtLeast(min: Role): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (req, reply) => {
    // open-read transition mode (CRUCIBLE_REQUIRE_AUTH=0): no auth context at
    // all → routes stay open, matching the app's global contract. Prod (auth
    // on) always resolves req.user; a missing user there still 401s below.
    // EFFECTIVE env (buildApp param) wins over process.env via the decorator.
    const effEnv = (req.server as unknown as { crucibleEnv?: Record<string, string | undefined> }).crucibleEnv;
    const requireAuth = effEnv?.['CRUCIBLE_REQUIRE_AUTH'] ?? process.env['CRUCIBLE_REQUIRE_AUTH'] ?? '1';
    if (!req.user && requireAuth === '0') return;
    if (!req.user) { await reply.code(401).send({ error: 'sign in required' }); return; }
    if (req.user.role === 'admin') return;
    if (roleAtLeast(req.user.role, min)) return;
    await reply.code(403).send({ error: `requires role: ${min} or above` });
  };
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
    // RBAC (plan 20261009T102032Z T2): hierarchy semantics — a human role in
    // the list admits every role at or above it, so requireRole('operator')
    // now passes supervisor too (the matrix's "QA work or above"). Admin
    // still passes everything; bots still count as operators (pipelines).
    for (const listed of roles) {
      if (roleAtLeast(req.user.role, listed)) return;
    }
    if (req.user.role === 'bot' && roles.includes('operator')) return;
    await reply.code(403).send({ error: `requires role: ${roles.join(' or ')}` });
  };
}

export { COOKIE as SESSION_COOKIE };
