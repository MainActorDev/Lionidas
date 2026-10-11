/** rev23 F4 tests — repo refs: hermetic via injected gh/git runners + tmp repo dirs. */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ToolRegistry } from '@mainactordev/butler';
import { listRepos, listBranches, registerRepoTools, type BranchRunners } from '../src/agent/repo-refs.ts';
import { buildAgentContext } from '../src/agent/context.ts';

const exec = promisify(execFile);
let root: string;
let db: Database.Database;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'repo-refs-'));
  // fake registered repo with a github-like remote
  const repoDir = path.join(root, 'demo-app');
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(path.join(repoDir, 'README'), 'demo');
  db = new Database(':memory:');
});
afterAll(() => { rmSync(root, { recursive: true, force: true }); db.close(); });

describe('listRepos', () => {
  it('lists directories that are git repos, skipping plain dirs', async () => {
    mkdirSync(path.join(root, 'plain-dir'), { recursive: true });
    const repoDir = path.join(root, 'demo-app');
    await exec('git', ['init', '-q', repoDir]);
    await exec('git', ['-C', repoDir, 'remote', 'add', 'origin', 'git@github.com:Acme/demo-app.git']);
    const repos = await listRepos(root);
    expect(repos).toContain('demo-app');
    expect(repos).not.toContain('plain-dir');
  });
});

describe('listBranches (injected runners)', () => {
  const fakeGh = async (args: string[]) => {
    const joined = args.join(' ');
    if (joined.includes('matching-refs')) {
      return { ok: true as const, out: JSON.stringify([{ ref: 'refs/heads/feat/demo-x', object: { sha: 'abcd1234' } }]) };
    }
    if (joined.startsWith('api repos/Acme/demo-app ')) {
      return { ok: true as const, out: JSON.stringify({ default_branch: 'main' }) };
    }
    if (joined.includes('pr list')) {
      return { ok: true as const, out: JSON.stringify([
        { headRefName: 'feat/one', updatedAt: '2026-10-10T00:00:00Z' },
        { headRefName: 'main', updatedAt: '2026-10-09T00:00:00Z' }, // dup of default — skipped
        { headRefName: 'feat/two', updatedAt: '2026-10-08T00:00:00Z' },
        { headRefName: 'feat/three', updatedAt: '2026-10-07T00:00:00Z' },
        { headRefName: 'feat/four', updatedAt: '2026-10-06T00:00:00Z' }, // beyond seed 3
      ]) };
    }
    return { ok: false as const, error: 'unexpected gh call' };
  };
  const runners: BranchRunners = { ghRun: fakeGh as never };

  it('seed = default branch + 3 most-recently-updated PR head-refs (dedup)', async () => {
    const out = await listBranches(path.join(root, 'demo-app'), 'Acme/demo-app', '', runners);
    expect(out.branches.map((b) => b.name)).toEqual(['main', 'feat/one', 'feat/two', 'feat/three']);
  });

  it('search = matching-refs prefix lookup with short sha', async () => {
    const out = await listBranches(path.join(root, 'demo-app'), 'Acme/demo-app', 'feat/demo', runners);
    expect(out.branches).toEqual([{ name: 'feat/demo-x', lastCommit: 'abcd123' }]);
  });

  it('gh failure → honest error', async () => {
    const failing: BranchRunners = { ghRun: (async () => ({ ok: false, error: 'gh: Bad credentials (HTTP 401)' })) as never };
    const out = await listBranches(path.join(root, 'demo-app'), 'Acme/demo-app', 'x', failing);
    expect(out.error).toMatch(/Bad credentials/);
  });
});

describe('repo tools on the registry', () => {
  it('four tools registered, read class, honest empty states', async () => {
    const ctx = buildAgentContext(db, { dbPath: ':memory:', artifactsDir: root, env: { CRUCIBLE_REPOS_ROOT: root } });
    for (const name of ['repo.list', 'repo.branches', 'repo.commits', 'repo.pulls']) {
      expect(ctx.registry.get(name)).toBeTruthy();
    }
    const out = await ctx.registry.execute('repo.branches', { project: 'demo-app', q: '' }, { signal: undefined, sessionId: 't' }, ctx.policy);
    // no gh in the test env → default+PR seeding degrade to [] or error; never a throw
    const parsed = JSON.parse(out) as { branches?: unknown[]; error?: string };
    expect(parsed.branches ?? []).toEqual([]);
  });

  it('invalid project name is rejected (path traversal guard)', async () => {
    const ctx = buildAgentContext(db, { dbPath: ':memory:', artifactsDir: root, env: { CRUCIBLE_REPOS_ROOT: root } });
    const out = await ctx.registry.execute('repo.commits', { project: '../secrets' }, { signal: undefined, sessionId: 't' }, ctx.policy);
    expect(out).toMatch(/invalid project name/);
  });
});

describe('registerRepoTools direct', () => {
  it('repo.list returns the tmp repos', async () => {
    const reg = new ToolRegistry();
    registerRepoTools(reg, { reposRoot: root });
    const out = await reg.execute('repo.list', {}, { signal: undefined, sessionId: 't' }, { name: 't', allows: 'read', permits: () => true } as never);
    expect(JSON.parse(out).repos).toContain('demo-app');
  });
});
