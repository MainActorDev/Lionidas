/** Model management routes (plan 20261014T084923Z step 4): admin CRUD on the
 *  registry JSON file, secrets masked to env-var names + presence booleans.
 *  Writes call router.reload() — no restart, no silent staleness (PR3). */

import type { FastifyInstance } from 'fastify';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { requireRole } from '../auth/roles.ts';
import { parseRegistry, type ModelRouter, type Registry } from '@mainactordev/butler';
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
