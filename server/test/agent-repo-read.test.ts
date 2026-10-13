/** Agent repo-reading tools (plan 20261013T063129Z, review RR1/RR2 applied):
 *  repo.read / repo.tree / repo.commit_files / repo.diff against live repo
 *  state. Hermetic: a fixture git repo; no network. */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ToolRegistry } from '@mainactordev/butler';
import { registerRepoTools } from '../src/agent/repo-refs.ts';
import { buildProfiles } from '../src/agent/profiles.ts';

let dir: string;
let repo: string;

function git(args: string[], cwd = repo): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'repo-read-'));
  repo = join(dir, 'fixture-repo');
  mkdirSync(join(repo, 'Features', 'Tracking'), { recursive: true });
  writeFileSync(join(repo, 'Features', 'Tracking', 'Stepper.swift'), 'import UIKit\n// milestone stepper\nclass Stepper {}\n');
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  writeFileSync(join(repo, 'blob.bin'), 'x\u0000y');
  git(['init', '-q']);
  git(['config', 'user.email', 't@t']); git(['config', 'user.name', 't']);
  git(['add', '.']); git(['commit', '-qm', 'feat: add stepper']);
  writeFileSync(join(repo, 'Features', 'Tracking', 'Stepper.swift'), 'import UIKit\n// milestone stepper v2 — driven by BE config\nclass Stepper { var milestones: [String] = [] }\n');
  git(['add', '.']); git(['commit', '-qm', 'feat: BE-driven milestones']);
});

afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

function tools() {
  const registry = new ToolRegistry();
  registerRepoTools(registry, { reposRoot: dir }, {});
  return registry;
}

async function call(registry: ToolRegistry, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const tool = registry.list().find((t) => t.name === name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return JSON.parse(await tool.execute(args, { sessionId: 'test', signal: undefined })) as Record<string, unknown>;
}

describe('repo.read', () => {
  it('reads a live file, line-numbered', async () => {
    const out = await call(tools(), 'repo.read', { project: 'fixture-repo', path: 'README.md' });
    expect(out['lines']).toContain('1\t# fixture');
    expect(out['totalLines']).toBe(2);
  });

  it('rejects traversal, absolute, and nested .. paths (review RR2)', async () => {
    const r = tools();
    for (const bad of ['../outside.txt', '/etc/passwd', 'Features/../../etc', 'a/../../..']) {
      const out = await call(r, 'repo.read', { project: 'fixture-repo', path: bad });
      expect(out['error']).toContain('traversal');
    }
  });

  it('binary detection + directory honesty', async () => {
    const r = tools();
    expect((await call(r, 'repo.read', { project: 'fixture-repo', path: 'blob.bin' }))['error']).toContain('binary');
    expect((await call(r, 'repo.read', { project: 'fixture-repo', path: 'Features' }))['error']).toContain('directory');
  });
});

describe('repo.tree', () => {
  it('lists the root: dirs + files with sizes', async () => {
    const out = await call(tools(), 'repo.tree', { project: 'fixture-repo' });
    const entries = out['entries'] as Array<{ name: string; kind: string; bytes: number }>;
    expect(entries.find((e) => e.name === 'Features')?.kind).toBe('dir');
    expect(entries.find((e) => e.name === 'README.md')?.bytes).toBeGreaterThan(0);
  });
  it('traversal rejected too', async () => {
    const out = await call(tools(), 'repo.tree', { project: 'fixture-repo', path: '..' });
    expect(out['error']).toContain('traversal');
  });
});

describe('repo.commit_files + repo.diff', () => {
  it('commit_files: status + paths, second commit touches only Stepper.swift', async () => {
    const out = await call(tools(), 'repo.commit_files', { project: 'fixture-repo', sha: 'HEAD' });
    const files = out['files'] as Array<{ status: string; path: string }>;
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toContain('Stepper.swift');
    expect(out['subject']).toContain('BE-driven');
  });

  it('diff: hunks include the new line; stat present; file filter works', async () => {
    const out = await call(tools(), 'repo.diff', { project: 'fixture-repo', sha: 'HEAD' });
    expect(String(out['stat'])).toContain('Stepper.swift');
    expect(String(out['patch'])).toContain('milestones');
    const filtered = await call(tools(), 'repo.diff', { project: 'fixture-repo', sha: 'HEAD', file: 'Features/Tracking/Stepper.swift' });
    expect(String(filtered['patch'])).toContain('milestones');
  });

  it('invalid sha + traversal in file rejected; unknown sha honest', async () => {
    const r = tools();
    expect((await call(r, 'repo.diff', { project: 'fixture-repo', sha: '!!' }))['error']).toContain('sha');
    expect((await call(r, 'repo.diff', { project: 'fixture-repo', sha: 'HEAD', file: '../x' }))['error']).toContain('traversal');
    expect((await call(r, 'repo.commit_files', { project: 'fixture-repo', sha: 'deadbeefdeadbeef' }))['error']).toContain('git failed');
  });
});

describe('allowlists (review RR1)', () => {
  it('planner + author profiles include all four read tools; chat policy path reaches them', async () => {
    const profiles = buildProfiles({}, { appBundle: 'app:x' });
    for (const p of [profiles.planner, profiles.author]) {
      for (const t of ['repo.read', 'repo.tree', 'repo.commit_files', 'repo.diff']) {
        expect(p.tools).toContain(t);
      }
    }
    // chat route builds from registry.list() filtered by permission — the tools are 'read'
    const registered = tools().list().filter((t) => t.name.startsWith('repo.'));
    expect(registered.map((t) => t.name).sort()).toEqual(['repo.apps', 'repo.branches', 'repo.commit_files', 'repo.commits', 'repo.diff', 'repo.list', 'repo.pulls', 'repo.read', 'repo.tree']);
  });
});

describe('sources.search staleness guard (Stage C)', () => {
  it('guard runs inside the real registry build: search returns a string, never throws, no repos dir is fine', async () => {
    const { buildToolRegistry } = await import('../src/agent/tools.ts');
    const { SqliteStorage } = await import('@mainactordev/butler');
    const { StorageRetriever } = await import('@mainactordev/butler');
    const db = (await import('better-sqlite3')).default(':memory:');
    const storage = new SqliteStorage(':memory:');
    void db;
    const retriever = new StorageRetriever(storage);
    const registry = buildToolRegistry({ db: null as never, storage, retriever, artifactsDir: dir });
    const search = registry.list().find((t) => t.name === 'sources.search');
    expect(search).toBeTruthy();
    const out = await search!.execute({ query: 'stepper' }, { sessionId: 't', signal: undefined });
    expect(typeof out).toBe('string'); // empty-store path with honest message, no throw
  });
});
