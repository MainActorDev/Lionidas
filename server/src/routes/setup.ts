/** Setup routes: first-run state + admin claim. Public ONLY while the setup
 *  window is open; both 404 after completion (and when the wizard is off).
 *  The claim POST requires the console-printed token (T1.5), is origin/JSON
 *  checked, rate-limited, and runs the claim in one transaction. */
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { needsSetup, setupModeOff, setupRateLimit, originAllowed, claimSetup, setupTokenValid } from '../auth/setup.ts';
import { requireRole } from '../auth/roles.ts';

export function registerSetupRoutes(app: FastifyInstance, db: Database.Database): void {
  const gate = (): boolean => !setupModeOff() && needsSetup(db);

  app.get('/api/setup/state', async (_req, reply) => {
    if (!gate()) return reply.code(404).send({ error: 'setup already complete' });
    return { needsSetup: true, reason: 'no_local_admin_password' };
  });

  app.post('/api/setup/admin', async (req, reply) => {
    if (!gate()) return reply.code(404).send({ error: 'setup already complete' });
    if (!setupRateLimit(req.ip)) return reply.code(429).send({ error: 'too many attempts — try again in a minute' });
    if (!originAllowed(req)) return reply.code(403).send({ error: 'cross-origin blocked' });
    const ct = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : '';
    if (!ct.includes('application/json')) return reply.code(415).send({ error: 'json content type required' });

    const b = req.body as { email?: string; name?: string; password?: string; token?: string } | null;
    if (!b?.email || !b?.password || !b?.token) {
      return reply.code(400).send({ error: 'email, password, and setup token (from the server console) required' });
    }
    const email = b.email.toLowerCase().trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return reply.code(400).send({ error: 'valid email required' });
    if (b.password.length < 8) return reply.code(400).send({ error: 'password must be at least 8 characters' });
    if (!setupTokenValid(db, b.token ?? '')) return reply.code(403).send({ error: 'invalid setup token — copy it from the server console output' });
    const r = claimSetup(db, email, (b.name ?? email.split('@')[0] ?? 'admin').trim() || 'admin', b.password);
    if (!r.ok) return reply.code(404).send({ error: 'setup already complete' });
    db.prepare('INSERT INTO auth_log(at, email, user_id, event, detail) VALUES (?, ?, ?, ?, ?)')
      .run(Date.now(), email, r.userId, 'setup_claimed', 'first-run setup completed via wizard');
    return { ok: true };
  });

  // readiness (T2): admin-gated checklist — re-runnable anytime from Settings
  app.get('/api/setup/readiness', { preHandler: requireRole('admin') }, async () => {
    const { readinessRows } = await import('../auth/setup.ts');
    return { rows: await readinessRows() };
  });
}
