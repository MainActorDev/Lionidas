/** rev23 F2/F3/F4: ref picker routes — attachments upload + jira/repo search.
 *  Operator-gated. Search routes call the SAME registry functions the agent's
 *  MCP tools use (one implementation, two transports). */
import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { requireRoleAtLeast } from '../auth/roles.ts';
import { ATTACHMENT_CAP_BYTES } from './attachments.ts';
import type { AgentContext } from './context.ts';

export async function registerRefRoutes(app: FastifyInstance, ctx: AgentContext): Promise<void> {
  await app.register(multipart, { limits: { fileSize: ATTACHMENT_CAP_BYTES }, throwFileSizeLimit: true });
  // ── F2: attachment upload (multipart; sha-deduped on save) ──
  app.post('/api/agent/attachments', { preHandler: requireRoleAtLeast('operator') }, async (req, reply) => {
    const parts = req.parts();
    for await (const part of parts) {
      if (part.type !== 'file') continue;
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of part.file) {
        total += (chunk as Buffer).byteLength;
        chunks.push(chunk as Buffer);
      }
      // busboy truncates the stream AT the cap (no error): truncated=true means
      // bytes were dropped — reject rather than save a silently-shortened file
      if (part.file.truncated || total > ATTACHMENT_CAP_BYTES) {
        return reply.code(413).send({ error: `attachment too large — cap ${ATTACHMENT_CAP_BYTES} bytes` });
      }
      const row = await ctx.attachments.save(part.filename || 'unnamed', Buffer.concat(chunks));
      return reply.send({ id: row.id, fileName: row.fileName, bytes: row.bytes, sha256: row.sha256 });
    }
    return reply.code(400).send({ error: 'multipart file part required' });
  });

  app.get('/api/agent/attachments/:id', { preHandler: requireRoleAtLeast('operator') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = ctx.attachments.get(id);
    if (!row) return reply.code(404).send({ error: 'no such attachment' });
    return reply.send(row);
  });

  // ── F3: jira search (env-gated; honest unconfigured state) ──
  app.get('/api/agent/refs/jira', { preHandler: requireRoleAtLeast('operator') }, async (req) => {
    const tool = ctx.registry.get('jira.search');
    if (!tool) return { configured: false, issues: [], reason: 'jira.search tool not registered' };
    const raw = await tool.execute({ query: String((req.query as { q?: string }).q ?? '') }, { signal: undefined, sessionId: 'refs-route' });
    return JSON.parse(raw) as object;
  });

  // ── F4: repos / branches / commits / pulls (gh-backed) ──
  app.get('/api/agent/refs/repos', { preHandler: requireRoleAtLeast('operator') }, async () => {
    const tool = ctx.registry.get('repo.list');
    if (!tool) return { repos: [] };
    return JSON.parse(await tool.execute({}, { signal: undefined, sessionId: 'refs-route' })) as object;
  });

  app.get('/api/agent/refs/repos/:project/branches', { preHandler: requireRoleAtLeast('operator') }, async (req) => {
    const { project } = req.params as { project: string };
    const tool = ctx.registry.get('repo.branches');
    if (!tool) return { branches: [] };
    const q = String((req.query as { q?: string }).q ?? '');
    return JSON.parse(await tool.execute({ project, ...(q ? { q } : {}) }, { signal: undefined, sessionId: 'refs-route' })) as object;
  });

  app.get('/api/agent/refs/repos/:project/commits', { preHandler: requireRoleAtLeast('operator') }, async (req) => {
    const { project } = req.params as { project: string };
    const q = req.query as { branch?: string };
    const tool = ctx.registry.get('repo.commits');
    if (!tool) return { rows: [] };
    return JSON.parse(await tool.execute({ project, ...(q.branch ? { branch: q.branch } : {}) }, { signal: undefined, sessionId: 'refs-route' })) as object;
  });

  app.get('/api/agent/refs/repos/:project/pulls', { preHandler: requireRoleAtLeast('operator') }, async (req) => {
    const { project } = req.params as { project: string };
    const tool = ctx.registry.get('repo.pulls');
    if (!tool) return { rows: [] };
    return JSON.parse(await tool.execute({ project }, { signal: undefined, sessionId: 'refs-route' })) as object;
  });
}
