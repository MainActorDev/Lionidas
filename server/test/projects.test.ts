import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify, { type FastifyInstance } from 'fastify';
import { migrateM1 } from '../src/db/schema.ts';
import { registerProjectRoutes } from '../src/projects/routes.ts';
import { projectAuthToken } from '../src/projects/store.ts';

let db: Database.Database;
let app: FastifyInstance;
let root: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'projects-'));
  db = new Database(':memory:');
  migrateM1(db);
  app = Fastify();
  // unit scope: identities injected per-test (admin OR operator) — auth
  // itself is covered by the auth suites
  app.addHook('onRequest', async (req: import('fastify').FastifyRequest, reply) => {
    const role = (req.headers['x-test-role'] as string) || 'admin';
    if (role === 'anon') { (req as unknown as { user: unknown }).user = null; return; }
    (req as unknown as { user: unknown }).user = { name: 't', role };
  });
  registerProjectRoutes(app, db);
  await app.ready();
});
afterEach(async () => {
  await app.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const admin = { headers: { 'x-test-role': 'admin' } };
const operator = { headers: { 'x-test-role': 'operator' } };

async function createProjectAsync(name = 'intl', repoUrl = 'git@github.com:MainActorDev/Intl.git'): Promise<{ project: { id: string } }> {
  const r = await app.inject({ method: 'POST', url: '/api/projects', ...admin, payload: { name, repoUrl, defaultBranch: 'develop' } });
  expect(r.statusCode).toBe(200);
  return r.json() as { project: { id: string } };
}

describe('project registry routes', () => {
  it('CRUD round-trip', async () => {
    const { project } = await createProjectAsync();
    const list = (await (await app.inject({ method: 'GET', url: '/api/projects', ...admin })).json()) as { projects: Array<{ id: string; name: string; repoUrl: string; defaultBranch: string | null }> };
    expect(list.projects).toHaveLength(1);
    expect(list.projects[0]!.name).toBe('intl');
    expect(list.projects[0]!.repoUrl).toBe('git@github.com:MainActorDev/Intl.git');
    expect(list.projects[0]!.defaultBranch).toBe('develop');
    const upd = await app.inject({ method: 'PUT', url: `/api/projects/${project.id}`, ...admin, payload: { defaultBranch: 'main' } });
    expect(upd.statusCode).toBe(200);
    expect(((await upd.json()) as { project: { defaultBranch: string } }).project.defaultBranch).toBe('main');
    const del = await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}`, ...admin });
    expect(del.statusCode).toBe(200);
    expect(((await (await app.inject({ method: 'GET', url: '/api/projects', ...admin })).json()) as { projects: unknown[] }).projects).toHaveLength(0);
  });

  it('admin-only: operator and anon get 403/401', async () => {
    await createProjectAsync();
    const rOp = await app.inject({ method: 'GET', url: '/api/projects', ...operator });
    expect(rOp.statusCode).toBe(403);
    const rAnon = await app.inject({ method: 'GET', url: '/api/projects', headers: { 'x-test-role': 'anon' } });
    expect([401, 403]).toContain(rAnon.statusCode);
  });

  it('duplicate name → 409; bad repoUrl → 422; missing name → 422', async () => {
    await createProjectAsync();
    const dup = await app.inject({ method: 'POST', url: '/api/projects', ...admin, payload: { name: 'intl', repoUrl: 'git@x:y.git' } });
    expect(dup.statusCode).toBe(409);
    const bad = await app.inject({ method: 'POST', url: '/api/projects', ...admin, payload: { name: 'ok', repoUrl: 'not a remote' } });
    expect(bad.statusCode).toBe(422);
    const missing = await app.inject({ method: 'POST', url: '/api/projects', ...admin, payload: { repoUrl: 'git@x:y.git' } });
    expect(missing.statusCode).toBe(422);
  });

  it('auth token is write-only: never in JSON, blank keeps, clearAuth clears', async () => {
    const { project } = await createProjectAsync();
    const tok = 'ghp_secret123';
    await app.inject({ method: 'PUT', url: `/api/projects/${project.id}`, ...admin, payload: { authToken: tok } });
    const got = await (await app.inject({ method: 'GET', url: `/api/projects/${project.id}`, ...admin })).json() as { project: Record<string, unknown> };
    expect(JSON.stringify(got)).not.toContain('ghp_secret123');
    expect(got.project['authSet']).toBe(true);
    expect(projectAuthToken(db, project.id)).toBe(tok); // server-side reads the value
    // blank update KEEPS the token
    await app.inject({ method: 'PUT', url: `/api/projects/${project.id}`, ...admin, payload: { name: 'intl2' } });
    expect(projectAuthToken(db, project.id)).toBe(tok);
    expect(((await (await app.inject({ method: 'GET', url: `/api/projects/${project.id}`, ...admin })).json()) as { project: { name: string } }).project.name).toBe('intl2');
    // clearAuth clears
    await app.inject({ method: 'PUT', url: `/api/projects/${project.id}`, ...admin, payload: { clearAuth: true } });
    expect(projectAuthToken(db, project.id)).toBeNull();
    expect(((await (await app.inject({ method: 'GET', url: `/api/projects/${project.id}`, ...admin })).json()) as { project: { authSet: boolean } }).project.authSet).toBe(false);
  });

  it('package claim + unclaim; deleting the project clears its claims', async () => {
    const { project } = await createProjectAsync();
    const path = join(root, 'x.ipa');
    const claim = await app.inject({ method: 'POST', url: '/api/packages/claim', ...admin, payload: { packagePath: path, projectId: project.id } });
    expect(claim.statusCode).toBe(200);
    const badClaim = await app.inject({ method: 'POST', url: '/api/packages/claim', ...admin, payload: { packagePath: path, projectId: 'prj_nope' } });
    expect(badClaim.statusCode).toBe(404);
    // claim is operator-blocked
    const opClaim = await app.inject({ method: 'POST', url: '/api/packages/claim', ...operator, payload: { packagePath: path, projectId: project.id } });
    expect(opClaim.statusCode).toBe(403);
    // delete project → claim gone (cascade)
    await app.inject({ method: 'DELETE', url: `/api/projects/${project.id}`, ...admin });
    const rows = db.prepare('SELECT count(*) c FROM package_owner').get() as { c: number };
    expect(rows.c).toBe(0);
    // unclaim on an unclaimed path is a no-op ok
    const un = await app.inject({ method: 'POST', url: '/api/packages/claim', ...admin, payload: { packagePath: path, projectId: null } });
    expect(un.statusCode).toBe(200);
  });
});
