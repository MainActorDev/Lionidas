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
import { auditWrite, auditDenial } from '../auth/audit.ts';

async function agentDbDeleteSession(agentDbPath: string, id: string): Promise<void> {
  // direct SQL on the butler DB: the Storage contract is append-only by
  // design (knowledge), so chat deletion lives here, at the route layer.
  const { default: Database } = await import('better-sqlite3');
  const adb = new Database(agentDbPath);
  try {
    adb.pragma('foreign_keys = ON');
    const tx = adb.transaction(() => {
      adb.prepare('DELETE FROM butler_messages WHERE session_id = ?').run(id);
      adb.prepare('DELETE FROM butler_sessions WHERE id = ?').run(id);
    });
    tx();
  } finally {
    adb.close();
  }
}

export function registerChatMetaRoutes(app: FastifyInstance, ctx: AgentContext, db: Database.Database, agentDbPath: string): void {
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

  // AI title: the model names the chat from its first exchange (rev5 #5).
  // One extra provider call, capped at 40 chars, falls back to client regex.
  app.post('/api/agent/sessions/:id/ai-title', { preHandler: requireRoleAtLeast('operator') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { force?: boolean };
    const row = await ctx.storage.getSession(id);
    if (!row) return reply.code(404).send({ error: 'not found' });
    // the client persists a regex placeholder immediately (so reloads keep a
    // name); the settle call passes force to let the MODEL's better name win.
    if (row.title && !b.force) return { ok: true, title: row.title, cached: true };
    const msgs = await ctx.storage.sessionMessages(id);
    const firstUser = [...msgs].reverse().find((m) => m.role === 'user');
    if (!firstUser) return reply.code(400).send({ error: 'no user message to title from' });
    // rev18: no model call — the claude-cli provider is STATEFUL (--resume),
    // so a titling turn inherits the conversation and echoes answer text.
    // Regex-derived title (mirrors the client) is instant and good enough.
    let title: string | null = null;
    if (!title) {
      const t = (firstUser.content ?? '')
        .replace(/^\s*(please\s+)?(draft|write|create|make|generate|prepare)\s+/i, '')
        .replace(/\s+(test|check|verification)\s+cases?\s*$/i, '')
        .replace(/\s+(for|of|from|about)\s+/i, ' ')
        .trim().slice(0, 40);
      if (t) title = t.charAt(0).toUpperCase() + t.slice(1);
    }
    if (!title) return reply.code(422).send({ error: 'could not derive a title' });
    await ctx.storage.updateSession(id, { title });
    return { ok: true, title };
  });

  // delete a chat (rev5 #7). IMPACT (documented in the reply): messages are
  // cascade-deleted from the agent DB; notes/artifacts/runs are NOT — they are
  // knowledge and pipeline state, keyed by scope/run id, not by chat. Audit row
  // records title+owner for forensics. Only the owner or an admin may delete.
  app.delete('/api/agent/sessions/:id', { preHandler: requireRoleAtLeast('operator') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await ctx.storage.getSession(id);
    if (!row) return reply.code(404).send({ error: 'not found' });
    if (row.user_id && row.user_id !== req.user?.id && req.user?.role !== 'admin') {
      auditDenial(db, req, 'DELETE /api/agent/sessions/:id', 'not chat owner');
      return reply.code(403).send({ error: 'only the chat owner or an admin can delete this chat' });
    }
    await agentDbDeleteSession(agentDbPath, id);
    auditWrite(db, req, 'chat_deleted', `chat "${row.title ?? id}" (${id}) deleted — messages cascade-deleted; notes/artifacts/runs retained`);
    return { ok: true, deleted: id };
  });

  // rev23: bulk delete — every chat session owned by the caller (admins: all).
  // Same impact contract as the single delete: messages+session rows go;
  // notes/artifacts/runs are retained (knowledge and pipeline state).
  app.delete('/api/agent/sessions', { preHandler: requireRoleAtLeast('operator') }, async (req) => {
    const sessions = await ctx.storage.listSessions(1000);
    const mine = req.user?.role === 'admin'
      ? sessions
      : sessions.filter((s) => !s.user_id || s.user_id === req.user?.id);
    for (const s of mine) await agentDbDeleteSession(agentDbPath, s.id);
    auditWrite(db, req, 'chat_deleted', `bulk: ${mine.length} chat(s) deleted by ${req.user?.role === 'admin' ? 'admin (all owners)' : 'owner'} — messages cascade-deleted; notes/artifacts/runs retained`);
    return { ok: true, deleted: mine.length };
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
