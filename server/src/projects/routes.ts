/** Project registry routes — admin-only surface (brainstorm Q3). */
import type { FastifyInstance } from 'fastify';
import { auditWrite } from '../auth/audit.ts';
import type Database from 'better-sqlite3';
import { requireRole } from '../auth/roles.ts';
import { reposDir } from '../manual/packages.ts';
import { listProjects, getProject, createProject, updateProject, deleteProject, claimPackage, unclaimPackage } from './store.ts';
import { cloneProject, pullProject, workspaceStatus } from './workspace.ts';
import { detectRecipe } from './recipe-detect.ts';
import { activeRecipe, writeRecipeRevision, backfillFromColumns } from './recipes.ts';
import { readBuildManifest } from './manifest.ts';
import { discoverAppInputs, probeRepoShape } from './discovery.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { projectWorkspace } from '../manual/packages.ts';
import { secretStatus } from '../secrets.ts';
import { startBuild, listBuilds, getBuild, buildLog, logSize } from './builds.ts';

interface ProjectBody {
  name?: string;
  repoUrl?: string;
  localPath?: string | null;
  defaultBranch?: string | null;
  authToken?: string | null;
  clearAuth?: boolean;
  buildScheme?: string | null;
  buildConfiguration?: string | null;
  defaultSuiteId?: string | null;
  retention?: number | null;
}

function validUrlish(v: string): boolean {
  // git ssh remote, https URL, or an absolute local path — identity is "what
  // you'd clone"; we do not fetch it here
  return /^(git@|https?:\/\/|ssh:\/\/|\/)/.test(v) && v.length >= 3;
}

export function registerProjectRoutes(app: FastifyInstance, db: Database.Database): void {
  // settings the projects surface consumes: the centralized repos workspace
  // root (display-only derivation — nobody types clone paths)
  // Phase 2 T3: env-field secret status — presence booleans + key names ONLY
  // (values never cross the wire; the mirror tells the operator what to set)
  app.get('/api/settings/secrets', { preHandler: requireRole('admin') }, async () => secretStatus());

  app.get('/api/settings/repos-dir', { preHandler: requireRole('admin') }, async () => {
    return { dir: reposDir() };
  });

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
      ...(b.buildScheme !== undefined ? { buildScheme: b.buildScheme || null } : {}),
      ...(b.buildConfiguration !== undefined ? { buildConfiguration: b.buildConfiguration || null } : {}),
      ...(b.defaultSuiteId !== undefined ? { defaultSuiteId: b.defaultSuiteId || null } : {}),
      ...(b.retention !== undefined
        ? (typeof b.retention === 'number' && b.retention >= 0 ? { retention: b.retention } : b.retention === null ? { retention: null } : reply.code(422).send({ error: 'retention must be a number >= 0 or null' }))
        : {}),
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

  // ── workspace management (admin): clone / pull / status ──
  app.post('/api/projects/:id/clone', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { pullIfExists?: boolean };
    const r = await cloneProject(db, id, { pullIfExists: b.pullIfExists === true });
    if (!r.ok) {
      const code = r.code === 'WORKSPACE_EXISTS' ? 409 : 502;
      return reply.code(code).send({ error: r.error, code: r.code });
    }
    // recipe onboarding gate (plan 20261015T021000Z S3, review R3a): detection runs
    // the MOMENT a workspace exists — the response carries the honest three-state
    // report; state persisted on the project row for the Projects page + canary
    const detection = detectRecipe(r.path);
    const recipeState = detection.state === 'found' ? `found:${detection.source}${detection.legacy ? ':legacy' : ''}` : detection.state;
    try {
      db.prepare('UPDATE projects SET recipe_state = ?, recipe_report_json = ?, updated_at = ? WHERE id = ?')
        .run(recipeState, JSON.stringify(detection), Date.now(), id);
    } catch { /* columns absent on legacy fixtures — report still returned */ }
    return { ok: true, kind: r.kind, path: r.path, recipe: detection };
  });

  // R3b: on-demand re-detection (projects registered before this change; post-pull)
  app.post('/api/projects/:id/recipe/detect', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const proj = getProject(db, id);
    if (!proj) return reply.code(404).send({ error: 'project not found' });
    const ws = projectWorkspace(proj.name);
    const detection = detectRecipe(ws);
    const recipeState = detection.state === 'found' ? `found:${detection.source}${detection.legacy ? ':legacy' : ''}` : detection.state;
    try {
      db.prepare('UPDATE projects SET recipe_state = ?, recipe_report_json = ?, updated_at = ? WHERE id = ?')
        .run(recipeState, JSON.stringify(detection), Date.now(), id);
    } catch { /* legacy fixtures */ }
    return { recipe: detection };
  });

  // the ONLY sanctioned path from discovery to a recipe (never silent): user
  // derives — writes a generated row flagged for review, verify-build proves it
  app.post('/api/projects/:id/recipe/derive', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const proj = getProject(db, id);
    if (!proj) return reply.code(404).send({ error: 'project not found' });
    const ws = projectWorkspace(proj.name);
    const detection = detectRecipe(ws);
    if (detection.state !== 'derivable') {
      return reply.code(409).send({ error: `recipe not derivable (${detection.state})`, detection });
    }
    const row = writeRecipeRevision(db, {
      projectId: id,
      transport: detection.recipe.transport,
      scheme: detection.recipe.scheme,
      configuration: detection.recipe.configuration,
      prepare: detection.recipe.prepare,
      generated: true,
      provenance: { by: 'derive', at: Date.now(), source: 'detectRecipe (derivable)', evidence: detection.notes },
    });
    return { ok: true, recipe: row };
  });

  // read the active recipe (with lazy R1 backfill from deprecated columns)
  app.get('/api/projects/:id/recipe', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const proj = getProject(db, id);
    if (!proj) return reply.code(404).send({ error: 'project not found' });
    const row = activeRecipe(db, id) ?? backfillFromColumns(db, { id, build_scheme: (proj as { buildScheme?: string | null }).buildScheme ?? null, build_configuration: (proj as { buildConfiguration?: string | null }).buildConfiguration ?? null });
    return { recipe: row };
  });

  app.post('/api/projects/:id/pull', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = await pullProject(db, id);
    if (!r.ok) {
      const code = r.code === 'WORKSPACE_MISSING' ? 409 : 502;
      return reply.code(code).send({ error: r.error, code: r.code });
    }
    return { ok: true, kind: r.kind, path: r.path };
  });

  app.get('/api/projects/:id/workspace', { preHandler: requireRole('admin') }, async (req) => {
    const { id } = req.params as { id: string };
    return { status: await workspaceStatus(db, id) };
  });

  // build-inputs: discovery + pinned values + manifest — feeds the pickers
  // (plan 20261007T164500Z T5). Resolution preview shows what a build WOULD
  // use: manifest > registry > discovery.
  app.get('/api/projects/:id/build-inputs', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const proj = getProject(db, id);
    if (!proj) return reply.code(404).send({ error: 'project not found' });
    const ws = projectWorkspace(proj.name);
    if (!existsSync(join(ws, '.git'))) return reply.code(409).send({ error: 'no workspace — clone first', code: 'CLONE_FIRST' });
    let manifest: { scheme: string | null; configuration: string | null } | null = null;
    let manifestError: string | null = null;
    try { manifest = readBuildManifest(ws); } catch (e) { manifestError = e instanceof Error ? e.message : String(e); }
    let appSchemes: string[] = [];
    let configurations: string[] = [];
    let repoShape: string | null = proj.repoShape;
    try {
      const d = discoverAppInputs(ws);
      appSchemes = d.appSchemes;
      configurations = d.configurations;
      if (!repoShape) {
        repoShape = probeRepoShape(ws);
        db.prepare('UPDATE projects SET repo_shape = ? WHERE id = ?').run(repoShape, id); // lazy backfill (review R5)
      }
    } catch { /* not generated yet — pickers show empty */ }
    const scheme = manifest?.scheme ?? proj.buildScheme ?? (appSchemes.length === 1 ? appSchemes[0]! : null);
    const schemeResolution = manifest?.scheme ? 'manifest' : proj.buildScheme ? 'registry' : scheme ? 'discovered' : (appSchemes.length > 1 ? 'ambiguous' : null);
    const configuration = manifest?.configuration ?? proj.buildConfiguration ?? (configurations.includes('Debug') ? 'Debug' : configurations[0] ?? null);
    const configurationResolution = manifest?.configuration ? 'manifest' : proj.buildConfiguration ? 'registry' : configuration ? 'discovered' : null;
    return {
      appSchemes, configurations,
      pinned: { scheme: proj.buildScheme, configuration: proj.buildConfiguration },
      manifest, manifestError,
      effective: { scheme, configuration, schemeResolution, configurationResolution },
      repoShape,
    };
  });

  // ── CI builds (admin) ──
  app.post('/api/projects/:id/builds', { preHandler: requireRole('admin') }, async (req, reply) => {
    auditWrite(db, req, 'build_trigger', `project ${(req.params as { id: string }).id}`);
    const { id } = req.params as { id: string };
    const r = startBuild(db, id);
    if (!r.ok) {
      const code = r.code === 'BUILD_RUNNING' ? 409 : r.code === 'CLONE_FIRST' ? 409 : 404;
      return reply.code(code).send({ error: r.error, code: r.code });
    }
    return { ok: true, build: r.build };
  });

  app.get('/api/builds', async (req) => { /* RBAC matrix: builds READ is overview-class (viewer ok); TRIGGER stays gated */
    const q = req.query as { project?: string };
    return { builds: listBuilds(db, q.project) };
  });

  app.get('/api/builds/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = getBuild(db, id);
    if (!b) return reply.code(404).send({ error: 'build not found' });
    return { build: b, logBytes: logSize(id) };
  });

  app.get('/api/builds/:id/log', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = getBuild(db, id);
    if (!b) return reply.code(404).send({ error: 'build not found' });
    const q = req.query as { from?: string };
    const from = Number(q.from ?? '0') || 0;
    reply.header('content-type', 'text/plain; charset=utf-8');
    reply.header('x-log-size', String(logSize(id)));
    return buildLog(id, from);
  });
}
