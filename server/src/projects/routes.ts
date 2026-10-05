/** Project registry routes — admin-only surface (brainstorm Q3). */
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { requireRole } from '../auth/roles.ts';
import { listProjects, getProject, createProject, updateProject, deleteProject, claimPackage, unclaimPackage } from './store.ts';

interface ProjectBody {
  name?: string;
  repoUrl?: string;
  localPath?: string | null;
  defaultBranch?: string | null;
  authToken?: string | null;
  clearAuth?: boolean;
}

function validUrlish(v: string): boolean {
  // git ssh remote, https URL, or an absolute local path — identity is "what
  // you'd clone"; we do not fetch it here
  return /^(git@|https?:\/\/|ssh:\/\/|\/)/.test(v) && v.length >= 3;
}

export function registerProjectRoutes(app: FastifyInstance, db: Database.Database): void {
  app.get('/api/projects', { preHandler: requireRole('admin') }, async () => {
    return { projects: listProjects(db) };
  });

  app.post('/api/projects', { preHandler: requireRole('admin') }, async (req, reply) => {
    const b = (req.body ?? {}) as ProjectBody;
    if (!b.name?.trim()) return reply.code(422).send({ error: 'name required' });
    if (!b.repoUrl?.trim() || !validUrlish(b.repoUrl.trim())) return reply.code(422).send({ error: 'repoUrl required (git remote or absolute path)' });
    try {
      const p = createProject(db, {
        name: b.name.trim(),
        repoUrl: b.repoUrl.trim(),
        localPath: b.localPath?.trim() || null,
        defaultBranch: b.defaultBranch?.trim() || null,
        authToken: b.authToken?.trim() || null,
      });
      return { ok: true, project: p };
    } catch (err) {
      if ((err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') return reply.code(409).send({ error: `a project named ${b.name} already exists` });
      return reply.code(500).send({ error: err instanceof Error ? err.message : 'create failed' });
    }
  });

  app.get('/api/projects/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = getProject(db, id);
    if (!p) return reply.code(404).send({ error: 'project not found' });
    return { project: p };
  });

  app.put('/api/projects/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as ProjectBody;
    if (b.repoUrl !== undefined && !validUrlish(b.repoUrl.trim())) return reply.code(422).send({ error: 'repoUrl must be a git remote or absolute path' });
    const p = updateProject(db, id, {
      ...(b.name !== undefined ? { name: b.name.trim() } : {}),
      ...(b.repoUrl !== undefined ? { repoUrl: b.repoUrl.trim() } : {}),
      ...(b.localPath !== undefined ? { localPath: b.localPath || null } : {}),
      ...(b.defaultBranch !== undefined ? { defaultBranch: b.defaultBranch || null } : {}),
      // blank keeps (env-page pattern); clearAuth or explicit empty clears
      ...(b.clearAuth ? { authToken: '' } : b.authToken !== undefined ? { authToken: b.authToken || '' } : {}),
    });
    if (!p) return reply.code(404).send({ error: 'project not found' });
    return { ok: true, project: p };
  });

  app.delete('/api/projects/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!deleteProject(db, id)) return reply.code(404).send({ error: 'project not found' });
    return { ok: true };
  });

  // ── package attribution (admin) ──
  app.post('/api/packages/claim', { preHandler: requireRole('admin') }, async (req, reply) => {
    const b = (req.body ?? {}) as { packagePath?: string; projectId?: string | null };
    if (!b.packagePath) return reply.code(422).send({ error: 'packagePath required' });
    if (b.projectId == null || b.projectId === '') { unclaimPackage(db, b.packagePath); return { ok: true }; }
    if (!claimPackage(db, b.packagePath, b.projectId)) return reply.code(404).send({ error: 'project not found' });
    return { ok: true };
  });
}
