/** Auth (PLAN §16.3): PIN protects judgment/mutation actions; agent token
 *  authorizes programmatic run creation. Unset (dev default) = allow-all with
 *  a startup warning — production sets CRUCIBLE_PIN + CRUCIBLE_AGENT_TOKEN. */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { timingSafeEqual } from 'node:crypto';

function constantEq(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export interface AuthConfig {
  pin: string | null;
  agentToken: string | null;
}

export function authConfig(): AuthConfig {
  return {
    pin: process.env['CRUCIBLE_PIN'] || null,
    agentToken: process.env['CRUCIBLE_AGENT_TOKEN'] || null,
  };
}

function extract(req: FastifyRequest, kind: 'pin' | 'agent'): string | null {
  const h = req.headers;
  if (kind === 'pin') {
    const hp = h['x-crucible-pin'];
    if (typeof hp === 'string') return hp;
    const bp = (req.body as { pin?: unknown } | undefined)?.pin;
    return typeof bp === 'string' ? bp : null;
  }
  const ha = h['x-crucible-agent'];
  if (typeof ha === 'string') return ha;
  const auth = h['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer crucible-')) return auth.slice('Bearer crucible-'.length);
  return null;
}

/** PreHandler: require PIN (judgment/mutation surface). */
export function requirePin(): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (req, reply) => {
    const cfg = authConfig();
    if (!cfg.pin) return; // dev mode — unset
    const given = extract(req, 'pin');
    if (given && constantEq(given, cfg.pin)) return;
    await reply.code(401).send({ error: 'PIN required (x-crucible-pin header or body.pin)' });
  };
}

/** PreHandler: require PIN OR agent token (run creation). */
export function requirePinOrAgent(): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (req, reply) => {
    const cfg = authConfig();
    if (!cfg.pin && !cfg.agentToken) return; // dev mode
    const pin = extract(req, 'pin');
    if (cfg.pin && pin && constantEq(pin, cfg.pin)) return;
    const agent = extract(req, 'agent');
    if (cfg.agentToken && agent && constantEq(agent, cfg.agentToken)) return;
    await reply.code(401).send({ error: 'PIN or agent token required (x-crucible-pin / x-crucible-agent)' });
  };
}

export function registerAuthStatus(app: FastifyInstance): void {
  app.get('/api/auth/status', async () => {
    const cfg = authConfig();
    return { pinSet: cfg.pin !== null, agentTokenSet: cfg.agentToken !== null };
  });
}
