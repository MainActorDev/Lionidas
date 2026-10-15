/** Model management routes (plan 20261014T084923Z step 4): admin CRUD on the
 *  registry JSON file, secrets masked to env-var names + presence booleans.
 *  Writes call router.reload() — no restart, no silent staleness (PR3). */

import type { FastifyInstance } from 'fastify';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { requireRole } from '../auth/roles.ts';
import { parseRegistry, type Registry } from '@mainactordev/butler';
import type { AgentContext } from './context.ts';

function maskRegistry(reg: Registry, env: Record<string, string | undefined>): Record<string, unknown> {
  return {
    version: reg.version,
    defaultCombo: reg.defaultCombo,
    models: reg.models.map((m) => ({
      id: m.id, kind: m.kind, baseUrl: m.baseUrl ?? null, model: m.model,
      apiKeyEnv: m.apiKeyEnv, keyPresent: Boolean(env[m.apiKeyEnv]),
      priority: m.priority, enabled: m.enabled,
      ...(m.maxOutputTokens ? { maxOutputTokens: m.maxOutputTokens } : {}),
      ...(m.claude ? { claude: m.claude } : {}),
    })),
    combos: reg.combos,
  };
}

export function registerModelRoutes(app: FastifyInstance, ctx: AgentContext, modelsFilePath: string | undefined, env: Record<string, string | undefined>, gated = true): void {
  const readRegistry = (): Registry | null => {
    if (modelsFilePath) { try { return parseRegistry(readFileSync(modelsFilePath, 'utf8')); } catch { return null; } }
    return ctx.router ? ctx.router.registrySnapshot() : null;
  };

  const adminOpts = gated ? { preHandler: requireRole('admin') } : {};
  const operOpts = gated ? { preHandler: requireRole('operator') } : {};
  app.get('/api/agent/models', adminOpts, async () => {
    const reg = readRegistry();
    if (!reg) return { registry: null, source: modelsFilePath ? 'file' : 'none' };
    return { registry: maskRegistry(reg, env), source: modelsFilePath ? 'file' : 'env' };
  });

  app.put('/api/agent/models', adminOpts, async (req, reply) => {
    if (!modelsFilePath) return reply.code(409).send({ error: 'BUTLER_MODELS_FILE not configured — file-backed registry required for edits' });
    const body = req.body as { registry?: unknown } | null;
    if (!body?.registry) return reply.code(400).send({ error: 'registry required' });
    let reg: Registry;
    try { reg = parseRegistry(JSON.stringify(body.registry)); } catch (err) {
      return reply.code(422).send({ error: err instanceof Error ? err.message : String(err) });
    }
    // persist the RAW registry (env names only — parse already rejects surprises
    // via shape; the mask is for reads, the file keeps the canonical form)
    mkdirSync(dirname(modelsFilePath), { recursive: true });
    writeFileSync(modelsFilePath, JSON.stringify(reg, null, 2));
    // PR3: hot-reload — the NEXT turn uses the new registry
    ctx.router?.reload(reg);
    return { ok: true, registry: maskRegistry(reg, env) };
  });

  app.get('/api/agent/models/health', operOpts, async () => {
    const health = ctx.router?.health() ?? [];
    const reg = readRegistry();
    return {
      models: health,
      defaultCombo: reg?.defaultCombo ?? null,
      combos: reg?.combos.map((c) => ({ id: c.id, members: c.members })) ?? [],
    };
  });
}

/** identifier index admin: POST reindex (operator) — rebuild for one repo (or all) */
export function registerIdentifierRoutes(app: import('fastify').FastifyInstance, ctx: AgentContext, reposRoot: string, env: Record<string, string | undefined>): void {
  void env;
  app.post('/api/agent/identifiers/reindex', { preHandler: requireRole('operator') }, async (req) => {
    const { repo } = (req.body ?? {}) as { repo?: string };
    const { readdirSync } = await import('node:fs');
    const { join: pathJoin } = await import('node:path');
    const { reindexBundle } = await import('./identifier-index.ts');
    const { detectBundles } = await import('./repo-refs.ts');
    const repos = readdirSync(reposRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .filter((n) => !repo || n === repo);
    const out: Array<{ repo: string; bundles: Array<{ bundle: string; files: number; head: string }> }> = [];
    for (const r of repos) {
      const dir = pathJoin(reposRoot, r);
      const bundles = await detectBundles(dir);
      const rows: Array<{ bundle: string; files: number; head: string }> = [];
      for (const b of bundles) {
        const meta = reindexBundle(ctx.db, b, r, dir);
        rows.push({ bundle: b, files: meta.files, head: meta.headSha.slice(0, 8) });
      }
      out.push({ repo: r, bundles: rows });
    }
    return { reindexed: out };
  });
}

/** /implement-identifiers host flow: worktree lifecycle for the edit turns.
 *  create → (CLI edits inside it during a chat turn) → finish (commit/push/PR) → cleanup.
 *  All git host-owned; the model only ever edits files. */
export function registerImplementIdentifiersRoutes(app: import('fastify').FastifyInstance, ctx: AgentContext, reposRoot: string): void {
  void ctx;
  app.post('/api/agent/identifiers/worktree', { preHandler: requireRole('operator') }, async (req, reply) => {
    const { repo, slug } = (req.body ?? {}) as { repo?: string; slug?: string };
    if (!repo || !slug) return reply.code(400).send({ error: 'repo and slug required' });
    try {
      const { createWorktree } = await import('./worktree.ts');
      const wt = createWorktree(reposRoot, repo, slug);
      return { worktree: { repo: wt.repo, branch: wt.branch, path: wt.path } };
    } catch (err) {
      return reply.code(409).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/agent/identifiers/worktree/finish', { preHandler: requireRole('operator') }, async (req, reply) => {
    const { repo, slug, entries, title, body } = (req.body ?? {}) as { repo?: string; slug?: string; entries?: Array<{ identifier: string; screen?: string; caseId?: string }>; title?: string; body?: string };
    if (!repo || !slug) return reply.code(400).send({ error: 'repo and slug required' });
    try {
      const { commitEach, pushAndPr, removeWorktree } = await import('./worktree.ts');
      const wt = { repo, slug, path: join(reposRoot, '.wt', `${repo}-${slug}`), branch: `feat/identifiers-${slug}` };
      const messages = commitEach(wt, entries ?? []);
      const pr = pushAndPr(wt, { title: title ?? `feat(a11y): add ${entries?.length ?? 0} accessibility identifiers`, body: body ?? 'identifiers implemented via /implement-identifiers — CI compile check required before merge' });
      removeWorktree(reposRoot, wt);
      return { commits: messages, pr };
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/agent/identifiers/worktree/discard', { preHandler: requireRole('operator') }, async (req) => {
    const { repo, slug } = (req.body ?? {}) as { repo?: string; slug?: string };
    if (!repo || !slug) return { error: 'repo and slug required' };
    const { removeWorktree } = await import('./worktree.ts');
    removeWorktree(reposRoot, { repo, slug, path: join(reposRoot, '.wt', `${repo}-${slug}`), branch: `feat/identifiers-${slug}` });
    return { ok: true };
  });
}
