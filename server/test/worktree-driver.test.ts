/** Worktree driver tests (Phase II step 6): real git in a temp repos root. */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import { createWorktree, commitEach, removeWorktree } from '../src/agent/worktree.ts';

let tmp: string;
let reposRoot: string;

function sh(cwd: string, cmd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf8' }).trim();
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'wt-driver-'));
  reposRoot = join(tmp, 'repos');
  mkdirSync(reposRoot);
  // a bare "origin" + a main clone (develop branch)
  mkdirSync(join(reposRoot, 'app'));
  const repo = join(reposRoot, 'app');
  sh(repo, 'git init -b develop');
  sh(repo, 'git config user.email t@t');
  sh(repo, 'git config user.name t');
  writeFileSync(join(repo, 'View.swift'), 'struct V {}\n');
  sh(repo, 'git add -A && git commit -m base');
});
afterAll(() => { rmSync(tmp, { recursive: true, force: true }); });

describe('worktree driver', () => {
  it('creates a worktree branched from develop, never touching the main checkout', () => {
    const wt = createWorktree(reposRoot, 'app', 'slug1');
    expect(wt.branch).toBe('feat/identifiers-slug1');
    expect(wt.path).toContain(join('.wt', 'app-slug1')); // PR3: derived .wt location
    expect(sh(wt.path, 'git branch --show-current')).toBe(wt.branch);
    expect(sh(wt.path, 'git log --oneline')).toContain('base'); // branched from develop
    // main checkout untouched
    expect(sh(join(reposRoot, 'app'), 'git status --porcelain')).toBe('');
    removeWorktree(reposRoot, wt);
    expect(sh(join(reposRoot, 'app'), 'git worktree list')).not.toContain('slug1');
  });

  it('commitEach: one commit per identifier with case linkage', () => {
    const wt = createWorktree(reposRoot, 'app', 'slug2');
    writeFileSync(join(wt.path, 'View.swift'), 'struct V { let x = "btn_pay" }\n');
    writeFileSync(join(wt.path, 'Other.swift'), 'struct O {}\n');
    const messages = commitEach(wt, [{ identifier: 'btn_pay', screen: 'account', caseId: 'tpl_123' }]);
    expect(messages.join('\n')).toContain('btn_pay');
    expect(messages.join('\n')).toContain('tpl_123');
    const log = sh(wt.path, 'git log --oneline develop..HEAD');
    expect(log.split('\n').length).toBeGreaterThanOrEqual(1);
    removeWorktree(reposRoot, wt);
  });

  it('REFUSES a dirty main checkout (user WIP protection)', () => {
    const repo = join(reposRoot, 'app');
    writeFileSync(join(repo, 'View.swift'), 'dirty\n');
    try {
      expect(() => createWorktree(reposRoot, 'app', 'slug3')).toThrow(/tracked changes/);
    } finally {
      sh(repo, 'git checkout -- View.swift');
    }
  });

  it('duplicate slug refused (worktree already exists)', () => {
    const wt = createWorktree(reposRoot, 'app', 'slug4');
    expect(() => createWorktree(reposRoot, 'app', 'slug4')).toThrow(/already exists/);
    removeWorktree(reposRoot, wt);
  });
});
