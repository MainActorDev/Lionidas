/** P3 rev 4 — chat-session metadata routes (operator-gated):
 *  - PATCH title (auto-titling from context, fix #8)
 *  - owner resolution (fix #7): butler sessions carry user_id; the directory
 *    enriches with name/role from the users table via the session creator.
 *  Mounted by pipeline-routes.ts beside the existing agent routes — no
 *  changes to butler or the conversation transport. */
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { AgentContext } from './context.ts';
import { requireRoleAtLeast } from '../auth/roles.ts';

export function registerChatMetaRoutes(app: FastifyInstance, ctx: AgentContext, db: Database.Database): void {
  // rename a chat (auto-title or user rename)
  app.patch('/api/agent/sessions/:id/title', { preHandler: requireRoleAtLeast('operator') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { title?: string };
    const title = (b.title ?? '').trim().slice(0, 80);
    if (!title) return reply.code(400).send({ error: 'title required' });
    const row = await ctx.storage.getSession(id);
    if (!row) return reply.code(404).send({ error: 'not found' });
    await ctx.storage.updateSession(id, { title });
    return { ok: true, title };
  });

  // sessions enriched with owner display names (fix #7: who started it)
  app.get('/api/agent/chats', { preHandler: requireRoleAtLeast('operator') }, async () => {
    const sessions = await ctx.storage.listSessions(200);
    const rows = db.prepare('SELECT id, name, role FROM users').all() as Array<{ id: string; name: string; role: string }>;
    const users = new Map(rows.map((u) => [u.id, u]));
    return {
      chats: sessions.map((s) => ({
        id: s.id,
        title: s.title,
        status: s.status,
        updatedAt: s.updated_at,
        owner: users.get(s.user_id ?? '')?.name ?? null,
        ownerRole: users.get(s.user_id ?? '')?.role ?? null,
      })),
    };
  });
}
