/** Role guards + req.user middleware — replaces the PIN gates.
 *  Humans: cookie session. Machines: agent token resolves to a bot user.
 *  The old requirePin/requirePinOrAgent die with this module's adoption. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { timingSafeEqual } from 'node:crypto';
import { resolveSession, userForAgentToken, type Role, type UserRow } from './users.ts';

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
    if (token) {
      const cfgAgent = process.env['CRUCIBLE_AGENT_TOKEN'] || null;
      if (cfgAgent && constantEq(token, cfgAgent)) {
        const bot = userForAgentToken(db, token) ?? userForAgentToken(db, 'lioclaw');
        if (bot) req.user = bot;
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
