/** Worktree driver (plan 20261014T132710Z Phase II step 5): the HOST owns all
 *  git. The model (claude CLI) edits files inside a throwaway worktree; this
 *  module creates it from origin/develop, commits per identifier, pushes,
 *  opens a create-only PR, and removes the worktree. Merge stays human.
 *
 *  Guards (review PR3): worktrees under <reposRoot>/.wt/<repo>-<slug>; the
 *  sources walk skips dot-dirs so a worktree is never ingested; dirty main
 *  checkout refuses (protect user WIP); failure discards the worktree. */

import { execSync } from 'node:child_process';
import { existsSync, rmSync, cpSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface WorktreeHandle { repo: string; slug: string; path: string; branch: string }

import { execFileSync } from 'node:child_process';

function git(cwd: string, ...args: string[]): string {
  // arg-array exec (never string-join): commit messages contain parens/unicode
  // that /bin/sh would mangle — and no injection surface for file names
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

export function createWorktree(reposRootInput: string, repo: string, slug: string, baseRef = 'origin/develop'): WorktreeHandle {
  const reposRoot = resolve(reposRootInput); // ABSOLUTE — relative roots resolve against
  // whichever process cwd runs the route, nesting worktrees INSIDE the repo (drill catch)
  const repoDir = join(reposRoot, repo);
  if (!existsSync(join(repoDir, '.git'))) throw new Error(`not a repo: ${repoDir}`);
  // dirty main checkout → refuse (user WIP protection). UNTRACKED files can't
  // conflict with a worktree (they're not in any commit) — only TRACKED changes
  // (staged/modified) block; dev machines routinely carry build stamps.
  const tracked = git(repoDir, 'status', '--porcelain', '--untracked-files=no');
  if (tracked.length > 0) throw new Error(`main checkout of ${repo} has tracked changes (${tracked.split('\n').length} files) — commit or stash first`);
  try { git(repoDir, 'fetch', 'origin', '--quiet'); } catch { /* local fixture repos have no origin */ }
  const branch = `feat/identifiers-${slug}`;
  const path = join(reposRoot, '.wt', `${repo}-${slug}`);
  if (existsSync(path)) throw new Error(`worktree already exists: ${path}`);
  let ref = baseRef;
  try { git(repoDir, 'rev-parse', '--verify', baseRef); } catch {
    const local = baseRef.replace('origin/', '');
    git(repoDir, 'rev-parse', '--verify', local); // must exist locally
    ref = local;
  }
  git(repoDir, 'worktree', 'add', '-b', branch, path, ref);
  // BUILD-OVERLAY carry (compile gate): the main checkout's build recipe
  // (.lionidas/ — manifest, prepare scripts, automation xcconfigs) is typically
  // LOCAL-ONLY (.git/info/exclude) — worktrees do NOT inherit info/exclude, so a
  // worktree build would miss its recipe entirely (live drill: xcodegen failed on
  // a missing DevelopmentConfig.xcconfig). Copy it in; removeWorktree wipes the
  // worktree wholesale so the overlay never leaks into commits (it is untracked).
  const overlay = join(repoDir, '.lionidas');
  if (existsSync(overlay)) {
    cpSync(overlay, join(path, '.lionidas'), { recursive: true });
  }
  return { repo, slug, path, branch };
}

export interface CommitEntry { identifier: string; screen?: string; caseId?: string }

/** commit files touched in the worktree, ONE commit per identifier (message
 *  carries the case linkage). When files outnumber entries, leftovers get a
 *  single trailing commit so nothing is silently dropped. */
export function commitEach(wt: WorktreeHandle, entries: CommitEntry[]): string[] {
  git(wt.path, 'add', '-A');
  const changed = git(wt.path, 'diff', '--cached', '--name-only').split('\n').filter(Boolean);
  const messages: string[] = [];
  const per = Math.max(1, Math.ceil(changed.length / Math.max(1, entries.length)));
  const groups: string[][] = [];
  for (let i = 0; i < changed.length; i += per) groups.push(changed.slice(i, i + per));
  git(wt.path, 'reset', '--quiet'); // unstage the blanket add; stage per group instead
  entries.forEach((e, i) => {
    const files = groups[i] ?? [];
    for (const f of files) git(wt.path, 'add', '--', f);
    const msg = `feat(a11y): add identifier ${e.identifier}${e.screen ? ` (${e.screen})` : ''}${e.caseId ? ` — unblocks case ${e.caseId}` : ''}`;
    if (files.length) git(wt.path, 'commit', '-m', msg);
    messages.push(msg);
  });
  // any remaining changed files (rounding): one trailing commit
  const rest = git(wt.path, 'status', '--porcelain').split('\n').filter(Boolean);
  if (rest.length) {
    git(wt.path, 'add', '-A');
    git(wt.path, 'commit', '-m', 'feat(a11y): remaining identifier edits');
    messages.push('feat(a11y): remaining identifier edits');
  }
  return messages;
}

export interface PrResult { url: string; number: number }

/** push + create-only PR. CI compile check is the gate (no archive/export);
 *  the caller reports "CI pending" — this never merges. */
export function pushAndPr(wt: WorktreeHandle, opts: { title: string; body: string; base?: string; ghPath?: string }): PrResult {
  git(wt.path, 'push', '-u', 'origin', wt.branch);
  const gh = opts.ghPath ?? 'gh';
  const out = execFileSync(gh, ['pr', 'create',
    '--title', opts.title, '--body', opts.body,
    ...(opts.base ? ['--base', opts.base] : [])], { cwd: wt.path, encoding: 'utf8' }).trim();
  const m = /https:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/(\d+)/.exec(out);
  if (!m) throw new Error(`could not parse PR url from: ${out}`);
  return { url: m[0]!, number: Number(m[1]) };
}

export function removeWorktree(reposRoot: string, wt: WorktreeHandle): void {
  const repoDir = join(reposRoot, wt.repo);
  try { git(repoDir, 'worktree', 'remove', '--force', wt.path); } catch { rmSync(wt.path, { recursive: true, force: true }); }
  try { git(repoDir, 'branch', '-D', wt.branch); } catch { /* merged branches are gone */ }
}

/** compile-check status of the PR (read-only): returns check name→state */
export function prChecks(wt: WorktreeHandle, prNumber: number, ghPath = 'gh'): Record<string, string> {
  const out = execFileSync(ghPath, ['pr', 'checks', String(prNumber)], { cwd: wt.path, encoding: 'utf8' });
  const checks: Record<string, string> = {};
  for (const line of out.split('\n')) {
    const cols = line.split('\t').map((c) => c.trim());
    if (cols.length >= 2 && cols[0] && !cols[0].includes('name')) checks[cols[0]] = cols[1] ?? '?';
  }
  return checks;
}
