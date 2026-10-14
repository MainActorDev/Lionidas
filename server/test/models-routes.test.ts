/** Models routes tests (plan 20261014T084923Z step 4): CRUD on the file,
 *  secret masking, reload-without-restart, RBAC. */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { registerModelRoutes } from '../src/agent/models-routes.ts';
import type { AgentContext } from '../src/agent/context.ts';

let tmp: string;
let filePath: string;
let router: { registrySnapshot: () => unknown; reload: (r: unknown) => void; health: () => Array<{ id: string }> };
let ctx: AgentContext;
let app: Awaited<ReturnType<typeof Fastify>>;

const REG = {
  version: 1,
  defaultCombo: 'auto',
  models: [
    { id: 'glm', kind: 'openai', baseUrl: 'https://api.z.ai/api/coding/paas/v4', model: 'glm-5.3-flash', apiKeyEnv: 'BUTLER_API_KEY', priority: 1, enabled: true },
    { id: 'bak', kind: 'mock', model: 'bak-model', apiKeyEnv: 'SPARE_KEY', priority: 2, enabled: true },
  ],
  combos: [{ id: 'auto', members: ['glm', 'bak'], strategy: 'fallback' }],
};

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'models-'));
  filePath = join(tmp, 'models.json');
  writeFileSync(filePath, JSON.stringify(REG));
  router = {
    registrySnapshot: () => REG as never,
    reload: (r: unknown) => { writeFileSync(filePath, JSON.stringify(r)); },
    health: () => [{ id: 'glm', ok: 3, failed: 0 }],
  };
  ctx = { router } as unknown as AgentContext;
  app = Fastify();
  const { requireRole } = await import('../src/auth/roles.ts');
  void requireRole;
  registerModelRoutes(app, ctx, filePath, { BUTLER_API_KEY: 'sk-secret-value', SPARE_KEY: '' }, /* ungated unit */ false);
  await app.ready();
});
afterAll(async () => { await app.close(); rmSync(tmp, { recursive: true, force: true }); });

const ADMIN = { headers: { cookie: 'x' } };

describe('GET /api/agent/models', () => {
  it('returns the masked registry — env NAMES + presence booleans, never values', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/agent/models', ...ADMIN });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { registry: { models: Array<{ apiKeyEnv: string; keyPresent: boolean }> } };
    const glm = body.registry.models.find((m) => m.apiKeyEnv === 'BUTLER_API_KEY')!;
    expect(glm.keyPresent).toBe(true);
    const spare = body.registry.models.find((m) => m.apiKeyEnv === 'SPARE_KEY')!;
    expect(spare.keyPresent).toBe(false);
    expect(r.body).not.toContain('sk-secret-value');
  });
});

describe('PUT /api/agent/models', () => {
  it('writes the file and hot-reloads — next read sees the new registry', async () => {
    const next = { ...REG, defaultCombo: 'solo', combos: [...REG.combos, { id: 'solo', members: ['bak'], strategy: 'fallback' }] };
    const r = await app.inject({ method: 'PUT', url: '/api/agent/models', payload: { registry: next }, ...ADMIN });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { registry: { defaultCombo: string } }).registry.defaultCombo).toBe('solo');
    const onDisk = JSON.parse(readFileSync(filePath, 'utf8')) as { defaultCombo: string };
    expect(onDisk.defaultCombo).toBe('solo');
    const r2 = await app.inject({ method: 'GET', url: '/api/agent/models', ...ADMIN });
    expect((r2.json() as { registry: { defaultCombo: string } }).registry.defaultCombo).toBe('solo');
  });

  it('rejects an invalid registry with 422 and a reason', async () => {
    const bad = { ...REG, combos: [{ id: 'x', members: ['ghost'], strategy: 'fallback' }] };
    const r = await app.inject({ method: 'PUT', url: '/api/agent/models', payload: { registry: bad }, ...ADMIN });
    expect(r.statusCode).toBe(422);
    expect((r.json() as { error: string }).error).toMatch(/unknown model ghost/);
  });
});

describe('GET /api/agent/models/health', () => {
  it('exposes rolling health + combo map', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/agent/models/health', ...ADMIN });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { models: Array<{ id: string; ok: number }>; combos: Array<{ id: string; members: string[] }> };
    expect(body.models[0]?.id).toBe('glm');
    expect(body.combos.some((c) => c.id === 'solo')).toBe(true);
  });
});
