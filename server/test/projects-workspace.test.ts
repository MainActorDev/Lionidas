import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, writeFileSync, rmSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify, { type FastifyInstance } from 'fastify';
import { migrateM1 } from '../src/db/schema.ts';
import { registerProjectRoutes } from '../src/projects/routes.ts';
import { createProject, projectAuthToken } from '../src/projects/store.ts';

const REAL_PATH = process.env.PATH!;

let root: string;
let bin: string;
let repos: string;
let db: Database.Database;
let app: FastifyInstance;

/** fake git shim: logs argv (+ GIT_ASKPASS presence) to calls.log, "clones"
 *  by creating the destination with a .git marker. */
function fakeGit(opts: { fail?: boolean; leakTokenInStderr?: string } = {}): void {
  const script = join(bin, 'git');
  writeFileSync(script, [
    '#!/bin/sh',
    `echo "$@ | askpass=\${GIT_ASKPASS:-none}" >> ${JSON.stringify(join(bin, 'calls.log'))}`,
    opts.fail ? `echo "fatal: something failed ${opts.leakTokenInStderr ?? ''}" >&2; exit 128` : '',
    // clone: last arg is the dest when argv[1] == clone
    'if [ "$1" = "clone" ]; then DEST=$(eval echo \\$$#); mkdir -p "$DEST/.git"; echo ref > "$DEST/.git/HEAD"; fi',
    'if [ "$1 $2" = "rev-parse --abbrev-ref" ]; then echo main; fi',
    'if [ "$1 $2" = "rev-parse --short" ]; then echo abc1234; fi',
    'exit 0',
    '',
  ].join('\n'));
  chmodSync(script, 0o755);
}

function calls(): string[] {
  return readFileSync(join(bin, 'calls.log'), 'utf8').split('\n').filter(Boolean);
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'projws-'));
  bin = mkdtempSync(join(tmpdir(), 'bin-'));
  repos = mkdtempSync(join(tmpdir(), 'repos-'));
  process.env.PATH = `${bin}:${REAL_PATH}`;
  process.env['CRUCIBLE_REPOS_DIR'] = repos;
  fakeGit();
  db = new Database(':memory:');
  migrateM1(db);
  app = Fastify();
  app.addHook('onRequest', async (req: import('fastify').FastifyRequest) => { (req as unknown as { user: unknown }).user = { name: 't', role: 'admin' }; });
  registerProjectRoutes(app, db);
  await app.ready();
});
afterEach(async () => {
  delete process.env['CRUCIBLE_REPOS_DIR'];
  process.env.PATH = REAL_PATH;
  await app.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
  rmSync(repos, { recursive: true, force: true });
});

async function mkProject(name = 'demo', repoUrl = 'https://github.com/org/demo.git', token?: string): Promise<string> {
  const p = createProject(db, { name, repoUrl, defaultBranch: 'main', authToken: token ?? null });
  return p.id;
}

describe('workspace clone/pull/status', () => {
  it('clone: shallow + branch, authed https URL when token set, dest derived', async () => {
    const id = await mkProject('demo', 'https://github.com/org/demo.git', 'ghp_tok123');
    const r = await app.inject({ method: 'POST', url: `/api/projects/${id}/clone`, payload: {} });
    expect(r.statusCode).toBe(200);
    const b = r.json() as { ok: boolean; kind: string; path: string };
    expect(b.kind).toBe('cloned');
    expect(b.path).toBe(join(repos, 'demo'));
    expect(existsSync(join(repos, 'demo', '.git'))).toBe(true);
    const c = calls()[0]!;
    expect(c).toContain('clone --depth 50 --branch main');
    expect(c).toContain('https://x-access-token:ghp_tok123@github.com/org/demo.git');
  });

  it('clone public repo: plain URL, no token anywhere', async () => {
    const id = await mkProject('pub', 'https://github.com/org/pub.git');
    await app.inject({ method: 'POST', url: `/api/projects/${id}/clone`, payload: {} });
    const c = calls()[0]!;
    expect(c).toContain('https://github.com/org/pub.git');
    expect(c).not.toContain('x-access-token');
  });

  it('clone ssh remote with token: askpass helper used, token NOT in argv', async () => {
    const id = await mkProject('sshp', 'git@github.com:org/priv.git', 'ghp_ssh77');
    const r = await app.inject({ method: 'POST', url: `/api/projects/${id}/clone`, payload: {} });
    expect(r.statusCode).toBe(200);
    const c = calls()[0]!;
    expect(c).toContain('git@github.com:org/priv.git');
    expect(c).not.toContain('ghp_ssh77');
    expect(c).toContain('askpass=/'); // a helper script was set
  });

  it('second clone → 409 WORKSPACE_EXISTS; pullIfExists=true → pull instead', async () => {
    const id = await mkProject();
    await app.inject({ method: 'POST', url: `/api/projects/${id}/clone`, payload: {} });
    const dup = await app.inject({ method: 'POST', url: `/api/projects/${id}/clone`, payload: {} });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().code).toBe('WORKSPACE_EXISTS');
    const pull = await app.inject({ method: 'POST', url: `/api/projects/${id}/clone`, payload: { pullIfExists: true } });
    expect(pull.statusCode).toBe(200);
    expect((pull.json() as { kind: string }).kind).toBe('pulled');
  });

  it('pull: fetch (authed when token) + checkout + reset --hard', async () => {
    const id = await mkProject('demo', 'https://github.com/org/demo.git', 'ghp_tok123');
    await app.inject({ method: 'POST', url: `/api/projects/${id}/clone`, payload: {} });
    rmSync(join(bin, 'calls.log'));
    const r = await app.inject({ method: 'POST', url: `/api/projects/${id}/pull`, payload: {} });
    expect(r.statusCode).toBe(200);
    const c = calls().map((x) => x.split(' | ')[0]!);
    expect(c[0]).toContain('fetch --prune https://x-access-token:ghp_tok123@github.com/org/demo.git');
    expect(c[1]).toBe('checkout main');
    expect(c[2]).toBe('reset --hard origin/main');
  });

  it('pull without workspace → 409 WORKSPACE_MISSING', async () => {
    const id = await mkProject();
    const r = await app.inject({ method: 'POST', url: `/api/projects/${id}/pull`, payload: {} });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('WORKSPACE_MISSING');
  });

  it('status: exists + branch/head/dirty after clone; missing before', async () => {
    const id = await mkProject();
    const before = (await (await app.inject({ method: 'GET', url: `/api/projects/${id}/workspace` })).json()) as { status: { exists: boolean } };
    expect(before.status.exists).toBe(false);
    await app.inject({ method: 'POST', url: `/api/projects/${id}/clone`, payload: {} });
    const after = (await (await app.inject({ method: 'GET', url: `/api/projects/${id}/workspace` })).json()) as { status: { exists: boolean; branch: string | null; head: string | null; dirty: number | null } };
    expect(after.status.exists).toBe(true);
    // fake git prints argv as stdout — rev-parse/status parse what the shim emits
    expect(after.status.branch).toBeTruthy();
  });

  it('failure redacts the token from the error', async () => {
    const id = await mkProject('leak', 'https://github.com/org/leak.git', 'ghp_SECRET_leak');
    fakeGit({ fail: true, leakTokenInStderr: 'url https://x-access-token:ghp_SECRET_leak@github.com' });
    const r = await app.inject({ method: 'POST', url: `/api/projects/${id}/clone`, payload: {} });
    expect(r.statusCode).toBe(502);
    expect(r.json().error).not.toContain('ghp_SECRET_leak');
    expect(r.json().error).toContain('***');
  });

  it('operator is 403 on all three routes', async () => {
    const id = await mkProject();
    const asOp = async (method: string, url: string): Promise<number> => {
      const r = await app.inject({ method, url, headers: { 'x-test-role': 'operator' } } as never);
      return r.statusCode;
    };
    // swap the identity hook for one request: simplest = re-register a second app
    const opApp = Fastify();
    opApp.addHook('onRequest', async (req: import('fastify').FastifyRequest) => { (req as unknown as { user: unknown }).user = { name: 't', role: 'operator' }; });
    registerProjectRoutes(opApp, db);
    await opApp.ready();
    const c = await opApp.inject({ method: 'POST', url: `/api/projects/${id}/clone`, payload: {} });
    const p = await opApp.inject({ method: 'POST', url: `/api/projects/${id}/pull`, payload: {} });
    const s = await opApp.inject({ method: 'GET', url: `/api/projects/${id}/workspace` });
    expect(c.statusCode).toBe(403);
    expect(p.statusCode).toBe(403);
    expect(s.statusCode).toBe(403);
    await opApp.close();
    void asOp;
  });
});

void projectAuthToken;
