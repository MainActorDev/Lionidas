/** rev23 F4: repo refs — gh-backed tools + registry registration.
 *  repo.list (registered repos on disk), repo.branches (top-3 active seed +
 *  searchable), repo.commits (branch-scoped), repo.pulls.
 *  Fixed argv, timeouts, output caps; gh errors surface as honest row data. */
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolRegistry } from '@mainactordev/butler';

const exec = promisify(execFile);
const GH_TIMEOUT_MS = 15_000;
const MAX_ROWS = 30;

export interface RepoRefRow { id: string; title: string; meta: string; sub?: string }

/** reposRoot: directory holding workspace clones (server/repos) */
export interface RepoToolsDeps { reposRoot: string }

async function gh(args: string[], env: Record<string, string | undefined>): Promise<{ ok: true; out: string } | { ok: false; error: string }> {
  // auth precedence: CRUCIBLE_GITHUB_TOKEN (server env, secrets policy) → GH_TOKEN →
  // keyring fallback. An EMPTY CRUCIBLE_GITHUB_TOKEN must NOT override a working
  // GH_TOKEN/keyring (drill bug: empty var exported → gh "Bad credentials").
  const childEnv: Record<string, string> = {};
  const crucible = (env['CRUCIBLE_GITHUB_TOKEN'] ?? '').trim();
  if (crucible) childEnv['GH_TOKEN'] = crucible;
  try {
    const { stdout } = await exec('gh', args, { timeout: GH_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, ...childEnv } });
    return { ok: true, out: stdout };
  } catch (e) {
    const err = e as { stderr?: string; message?: string; code?: string };
    if (err.code === 'ENOENT') return { ok: false, error: 'gh CLI not installed on the server' };
    const detail = (err.stderr ?? err.message ?? '').split('\n')[0]?.slice(0, 160) ?? 'gh failed';
    return { ok: false, error: detail };
  }
}

/** registered repos = directories under reposRoot containing .git */
export async function listRepos(reposRoot: string): Promise<string[]> {
  const entries = await readdir(reposRoot, { withFileTypes: true }).catch(() => []);
  const repos: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const hasGit = await readdir(path.join(reposRoot, e.name)).then((s) => s.includes('.git')).catch(() => false);
    if (hasGit) repos.push(e.name);
  }
  return repos.sort();
}

/** branch list (F4, user decision): top-3 ACTIVE seed (recent PR head-refs +
 *  default branch) — a full branch list is 3.7k rows in ios-consumer; search
 *  covers everything via ls-remote. Injectable gh/git runners for tests. */
export interface BranchRunners { ghRun?: typeof gh; gitRun?: (args: string[], cwd: string) => Promise<{ ok: true; out: string } | { ok: false; error: string }> }

export async function listBranches(repoDir: string, ownerName: string, q: string, runners: BranchRunners = {}): Promise<{ branches: Array<{ name: string; lastCommit: string }>; error?: string }> {
  const ghRun = runners.ghRun ?? gh;
  const gitRun = runners.gitRun ?? (async (args, cwd) => {
    try {
      const { stdout } = await exec('git', ['-C', cwd, ...args], { timeout: GH_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
      return { ok: true as const, out: stdout };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message.split('\n')[0]?.slice(0, 160) ?? 'git failed' };
    }
  });

  const query = q.trim().toLowerCase();
  // SEARCH: git/matching-refs — PREFIX match, sub-second, one API call.
  // (Branches are deleted on merge in this org; a query with no hits is a
  // legitimate empty result, not an error.)
  if (query) {
    const r = await ghRun(['api', `repos/${ownerName}/git/matching-refs/heads/${encodeURIComponent(q.trim())}`, '--method', 'GET'], process.env as Record<string, string | undefined>);
    if (!r.ok) return { branches: [], error: r.error };
    try {
      const refs = JSON.parse(r.out) as Array<{ ref: string; object?: { sha?: string } }>;
      return { branches: refs.slice(0, MAX_ROWS).map((x) => ({ name: x.ref.replace(/^refs\/heads\//, ''), lastCommit: x.object?.sha?.slice(0, 7) ?? '' })) };
    } catch {
      return { branches: [], error: 'gh returned an unparseable ref list' };
    }
  }
  void gitRun;

  // SEED: default branch + head-refs of the 3 most-recently-updated open PRs
  const branches: Array<{ name: string; lastCommit: string }> = [];
  const seen = new Set<string>();
  const repo = await ghRun(['api', `repos/${ownerName}`, '--method', 'GET'], process.env as Record<string, string | undefined>);
  if (repo.ok) {
    const def = (JSON.parse(repo.out) as { default_branch?: string }).default_branch;
    if (def) { branches.push({ name: def, lastCommit: 'default' }); seen.add(def); }
  }
  const prs = await ghRun(['pr', 'list', '-R', ownerName, '--state', 'open', '--limit', '10', '--json', 'headRefName,updatedAt'], process.env as Record<string, string | undefined>);
  if (prs.ok) {
    const rows = JSON.parse(prs.out) as Array<{ headRefName: string; updatedAt: string }>;
    rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    for (const r of rows) {
      if (branches.length >= 4) break; // default + 3 active PR head-refs
      if (!r.headRefName || seen.has(r.headRefName)) continue;
      branches.push({ name: r.headRefName, lastCommit: r.updatedAt.slice(0, 10) });
      seen.add(r.headRefName);
    }
  }
  return { branches };
}

/** commits on a branch (default: repo default branch) */
export async function listCommits(repoDir: string, ownerName: string, branch: string | undefined): Promise<{ rows: RepoRefRow[]; error?: string }> {
  const args = ['api', `repos/${ownerName}/commits`, '--method', 'GET', '-f', `per_page=${MAX_ROWS}`];
  if (branch) args.push('-f', `sha=${branch}`);
  const r = await gh(args, process.env as Record<string, string | undefined>);
  if (!r.ok) return { rows: [], error: r.error };
  try {
    const data = JSON.parse(r.out) as Array<{ sha: string; commit?: { message?: string; author?: { name?: string; date?: string } }; author?: { login?: string } }>;
    return {
      rows: data.map((c) => ({
        id: c.sha.slice(0, 7),
        title: c.sha.slice(0, 7),
        meta: `${c.author?.login ?? (c.commit?.author?.name ?? '')} · ${c.commit?.author?.date?.slice(0, 10) ?? ''}`,
        sub: (c.commit?.message ?? '').split('\n')[0]?.slice(0, 72) ?? '',
      })),
    };
  } catch {
    return { rows: [], error: 'gh returned an unparseable commit list' };
  }
}

/** PRs — CLOSED list (merged + closed), newest first; merged/closed state shown */
export async function listPulls(ownerName: string): Promise<{ rows: RepoRefRow[]; error?: string }> {
  const r = await gh(['api', `repos/${ownerName}/pulls`, '--method', 'GET', '-f', `per_page=${MAX_ROWS}`, '-f', 'state=closed', '-f', 'sort=updated', '-f', 'direction=desc'], process.env as Record<string, string | undefined>);
  if (!r.ok) return { rows: [], error: r.error };
  try {
    const data = JSON.parse(r.out) as Array<{ number: number; title: string; user?: { login?: string }; head?: { ref?: string }; merged_at?: string | null; closed_at?: string | null }>;
    return {
      rows: data.map((p) => ({
        id: `PR-${p.number}`,
        title: `PR-${p.number}`,
        meta: `${p.merged_at ? 'merged' : 'closed'} ${((p.merged_at ?? p.closed_at ?? '').slice(0, 10))} · ${p.user?.login ?? ''}${p.head?.ref ? ` · ${p.head.ref}` : ''}`,
        sub: p.title.slice(0, 72),
      })),
    };
  } catch {
    return { rows: [], error: 'gh returned an unparseable PR list' };
  }
}

/** detect the app bundle ids a repo builds — project.yml bundleIdPrefix +
 *  pbxproj PRODUCT_BUNDLE_IDENTIFIER lines, deduped, sorted by frequency. */
export async function detectBundles(repoDir: string): Promise<string[]> {
  const found = new Map<string, number>();
  const bump = (b: string) => { if (b && /^[a-z][a-z0-9.]*$/i.test(b)) found.set(b, (found.get(b) ?? 0) + 1); };
  const readFileSafe = async (f: string): Promise<string | null> => {
    try { return await (await import('node:fs/promises')).readFile(f, 'utf8'); } catch { return null; }
  };
  // xcodegen: bundleIdPrefix + target name is the convention, plus explicit settings
  const yml = await readFileSafe(path.join(repoDir, 'project.yml'));
  if (yml) {
    const prefix = /^\s*bundleIdPrefix:\s*['"]?([\w.]+)['"]?/m.exec(yml)?.[1];
    if (prefix) {
      for (const m of yml.matchAll(/^\s{2}(\w[\w-]*):\s*$/gm)) bump(`${prefix}.${m[1]}`);
    }
    for (const m of yml.matchAll(/PRODUCT_BUNDLE_IDENTIFIER:\s*([\w.]+)/g)) bump(m[1] ?? '');
  }
  // pbxproj fallback (pinned ids win — they are what actually ships)
  const pbx = await readFileSafe(path.join(repoDir, 'LionParcelLogistics.xcodeproj', 'project.pbxproj'))
    ?? await readFileSafe(path.join(repoDir, 'App.xcodeproj', 'project.pbxproj'))
    ?? null;
  if (pbx) for (const m of pbx.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([\w.]+);/g)) bump(m[1] ?? '');
  // main app first: prefer ids WITHOUT main-target/test/extension suffixes; tests+extensions demoted
  const order = (b: string): number =>
    /(Tests?|LogicTests|UITests)$/i.test(b.split('.').pop() ?? '') ? 2 :
    /(NotificationService|NotificationContent|Firebase|GoogleSignIn|RecaptchaEnterprise|Widget|Share)$/i.test(b) ? 1 : 0;
  return [...found.entries()]
    .sort((a, b) => order(a[0]) - order(b[0]) || b[1] - a[1])
    .map(([b]) => b)
    .slice(0, 8);
}

/** map a registered repo dir name to its GitHub owner/name via the local remote */
export async function remoteOwnerName(repoDir: string): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['-C', repoDir, 'remote', 'get-url', 'origin'], { timeout: 5000 });
    const url = stdout.trim();
    const m = /github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?$/.exec(url);
    return m ? `${m[1]}/${m[2]}` : null;
  } catch {
    return null;
  }
}

/** registers the four repo tools (read class) */
export function registerRepoTools(registry: ToolRegistry, deps: RepoToolsDeps, env: Record<string, string | undefined> = process.env as Record<string, string | undefined>): void {
  const repoDir = (project: string): string => {
    if (!/^[A-Za-z0-9._-]+$/.test(project)) throw new Error(`invalid project name "${project}"`);
    return path.join(deps.reposRoot, project);
  };
  const safeDir = (project: string): string | null => {
    try { return repoDir(project); } catch { return null; }
  };

  registry.register({
    name: 'repo.apps',
    description: 'app bundle ids a registered repo builds (project.yml + pbxproj)',
    permission: 'read',
    parameters: { type: 'object', properties: { project: { type: 'string' } }, required: ['project'] },
    async execute(args) {
      const dir = safeDir(String(args['project'] ?? ''));
      if (!dir) return JSON.stringify({ bundles: [], error: 'invalid project name' });
      return JSON.stringify({ bundles: await detectBundles(dir) });
    },
  });

  registry.register({
    name: 'repo.list',
    description: 'list repos registered in lionidas (workspace clones)',
    permission: 'read',
    parameters: { type: 'object', properties: {} },
    async execute() { return JSON.stringify({ repos: await listRepos(deps.reposRoot) }); },
  });

  registry.register({
    name: 'repo.branches',
    description: 'list branches for a registered repo — top-3 active seed, or all matching a query',
    permission: 'read',
    parameters: { type: 'object', properties: { project: { type: 'string' }, q: { type: 'string' } }, required: ['project'] },
    async execute(args) {
      const dir = safeDir(String(args['project'] ?? ''));
      if (!dir) return JSON.stringify({ branches: [], error: 'invalid project name' });
      const owner = await remoteOwnerName(dir);
      if (!owner) return JSON.stringify({ branches: [], error: 'repo has no github origin remote' });
      return JSON.stringify(await listBranches(dir, owner, String(args['q'] ?? '')));
    },
  });

  registry.register({
    name: 'repo.commits',
    description: 'recent commits for a registered repo (branch-scoped; default branch when omitted)',
    permission: 'read',
    parameters: { type: 'object', properties: { project: { type: 'string' }, branch: { type: 'string' } }, required: ['project'] },
    async execute(args) {
      const dir = safeDir(String(args['project'] ?? ''));
      if (!dir) return JSON.stringify({ rows: [], error: 'invalid project name' });
      const owner = await remoteOwnerName(dir);
      if (!owner) return JSON.stringify({ rows: [], error: 'repo has no github origin remote' });
      return JSON.stringify(await listCommits(dir, owner, typeof args['branch'] === 'string' && args['branch'] ? args['branch'] : undefined));
    },
  });

  registry.register({
    name: 'repo.pulls',
    description: 'open PRs for a registered repo',
    permission: 'read',
    parameters: { type: 'object', properties: { project: { type: 'string' } }, required: ['project'] },
    async execute(args) {
      const dir = safeDir(String(args['project'] ?? ''));
      if (!dir) return JSON.stringify({ rows: [], error: 'invalid project name' });
      const owner = await remoteOwnerName(dir);
      if (!owner) return JSON.stringify({ rows: [], error: 'repo has no github origin remote' });
      return JSON.stringify(await listPulls(owner));
    },
  });

  // ── live repo reading (agent-repo-reading plan; review RR2 containment) ──
  const READ_CAP = 12_000; // matches the chunk-cap policy (1e79223)
  /** containment: resolved path must stay inside repoDir; no .., no absolute */
  const safeSub = (project: string, sub: string): string | null => {
    const root = safeDir(project);
    if (!root) return null;
    if (path.isAbsolute(sub) || sub.split(/[\\/]/).includes('..')) return null;
    const resolved = path.resolve(root, sub);
    const r = path.resolve(root);
    if (resolved !== r && !resolved.startsWith(r + path.sep)) return null;
    return resolved;
  };
  const cap = (text: string): { text: string; truncated: boolean } =>
    text.length > READ_CAP ? { text: text.slice(0, READ_CAP), truncated: true } : { text, truncated: false };

  registry.register({
    name: 'repo.read',
    description: 'read a file from a registered repo (live, line-numbered; use offset/limit for large files)',
    permission: 'read',
    parameters: { type: 'object', properties: { project: { type: 'string' }, path: { type: 'string', description: 'repo-relative path' }, offset: { type: 'number', description: '1-based start line' }, limit: { type: 'number', description: 'max lines' } }, required: ['project', 'path'] },
    async execute(args) {
      const file = safeSub(String(args['project'] ?? ''), String(args['path'] ?? ''));
      if (!file) return JSON.stringify({ error: 'invalid project or path (traversal rejected)' });
      try {
        const st = await stat(file);
        if (st.isDirectory()) return JSON.stringify({ error: 'path is a directory — use repo.tree' });
        if (st.size > 2 * 1024 * 1024) return JSON.stringify({ error: `file too large (${st.size} bytes) — read via offset/limit is not supported above 2MB` });
        const raw = await readFile(file, 'utf8');
        if (raw.includes('\u0000')) return JSON.stringify({ error: 'binary file — not readable' });
        const all = raw.split('\n');
        const offset = Math.max(1, Number(args['offset'] ?? 1) || 1);
        const limit = Math.min(Math.max(1, Number(args['limit'] ?? 400) || 400), 1000);
        const slice = all.slice(offset - 1, offset - 1 + limit);
        const numbered = slice.map((l, i) => `${offset + i}\t${l}`).join('\n');
        const { text, truncated } = cap(numbered);
        return JSON.stringify({ path: String(args['path']), offset, totalLines: all.length, lines: text, ...(truncated ? { truncated: true, note: `capped at ${READ_CAP} chars — narrow with offset/limit` } : {}) });
      } catch { return JSON.stringify({ error: 'path not found' }); }
    },
  });

  registry.register({
    name: 'repo.tree',
    description: 'list a directory of a registered repo (names, kinds, sizes)',
    permission: 'read',
    parameters: { type: 'object', properties: { project: { type: 'string' }, path: { type: 'string', description: 'repo-relative dir (default root)' } }, required: ['project'] },
    async execute(args) {
      const root = safeDir(String(args['project'] ?? ''));
      if (!root) return JSON.stringify({ error: 'invalid project name' });
      const sub = String(args['path'] ?? '');
      const dir = sub ? safeSub(String(args['project'] ?? ''), sub) : path.resolve(root);
      if (!dir) return JSON.stringify({ error: 'invalid path (traversal rejected)' });
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        const rows = [];
        for (const e of entries.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 500)) {
          let bytes = 0;
          try { if (e.isFile()) bytes = (await stat(path.join(dir, e.name))).size; } catch { /* gone */ }
          rows.push({ name: e.name, kind: e.isDirectory() ? 'dir' : 'file', bytes });
        }
        return JSON.stringify({ path: sub || '.', entries: rows, ...(entries.length > 500 ? { truncated: true } : {}) });
      } catch { return JSON.stringify({ error: 'directory not found' }); }
    },
  });

  registry.register({
    name: 'repo.commit_files',
    description: 'files changed by a commit (status + adds/dels), local git',
    permission: 'read',
    parameters: { type: 'object', properties: { project: { type: 'string' }, sha: { type: 'string' } }, required: ['project', 'sha'] },
    async execute(args) {
      const root = safeDir(String(args['project'] ?? ''));
      if (!root) return JSON.stringify({ error: 'invalid project name' });
      const sha = String(args['sha'] ?? '').trim();
      if (!/^[A-Za-z0-9._\/^-]{3,64}$/.test(sha) || sha.includes('..')) return JSON.stringify({ error: 'invalid sha' });
      try {
        const { stdout } = await exec('git', ['show', '--no-color', '--name-status', '--format=%H%n%s', sha], { cwd: root, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
        const lines = stdout.split('\n');
        const full = lines[0] ?? '';
        const subject = lines[1] ?? '';
        const files = lines.slice(2).filter((l) => l.trim()).map((l) => {
          const m = /^(\w)\t+(.+)$/.exec(l.trim());
          return m ? { status: m[1], path: m[2] } : { status: '?', path: l.trim() };
        });
        return JSON.stringify({ sha: full.slice(0, 12), subject, files: files.slice(0, 200), ...(files.length > 200 ? { truncated: true, fileCount: files.length } : {}) });
      } catch (e) { return JSON.stringify({ error: `git failed — ${(e as Error).message.split('\n')[0]?.slice(0, 120)}` }); }
    },
  });

  registry.register({
    name: 'repo.diff',
    description: 'diff of a commit: per-file stat + hunks (truncated; filter by file, then repo.read for full content)',
    permission: 'read',
    parameters: { type: 'object', properties: { project: { type: 'string' }, sha: { type: 'string' }, file: { type: 'string', description: 'only this file' }, maxChars: { type: 'number', description: `cap (default ${12_000}, max 24000)` } }, required: ['project', 'sha'] },
    async execute(args) {
      const root = safeDir(String(args['project'] ?? ''));
      if (!root) return JSON.stringify({ error: 'invalid project name' });
      const sha = String(args['sha'] ?? '').trim();
      if (!/^[A-Za-z0-9._\/^-]{3,64}$/.test(sha) || sha.includes('..')) return JSON.stringify({ error: 'invalid sha' });
      const fileArg = typeof args['file'] === 'string' && args['file'] ? String(args['file']) : null;
      if (fileArg && !safeSub(String(args['project'] ?? ''), fileArg)) return JSON.stringify({ error: 'invalid file (traversal rejected)' });
      const maxChars = Math.min(Math.max(2_000, Number(args['maxChars'] ?? READ_CAP) || READ_CAP), 24_000);
      try {
        const gitArgs = ['show', '--no-color', '--format=%H %s', '--stat', '--stat-width=200', '-p', '--diff-merges=first-parent'];
        if (fileArg) gitArgs.push('--', fileArg);
        gitArgs.push(sha);
        const { stdout } = await exec('git', gitArgs, { cwd: root, timeout: 20_000, maxBuffer: 12 * 1024 * 1024 });
        // actual git shape: '<sha> <subject>\n--\n<statlines>\n\n<patch from diff --git…>'
        const diffAt = stdout.indexOf('diff --git');
        const statPart = diffAt === -1 ? stdout.slice(stdout.indexOf('\n') + 1) : stdout.slice(stdout.indexOf('\n--\n') + 4, diffAt).trim();
        let patch = diffAt === -1 ? '' : stdout.slice(diffAt);
        if (fileArg) {
          // with --, output still carries stat + full patch for that file
          patch = patch.slice(patch.indexOf('\n@@') >= 0 ? patch.indexOf('\n@@') : 0);
        }
        const budget = maxChars - Math.min(statPart.length, maxChars / 2);
        const { text, truncated } = patch.length > budget ? { text: patch.slice(0, budget), truncated: true } : { text: patch, truncated: false };
        return JSON.stringify({ sha: sha.slice(0, 12), stat: statPart.slice(0, Math.floor(maxChars / 2)), ...(truncated ? { truncated: true, note: 'hunks truncated — filter by file, then repo.read' } : {}), patch: text });
      } catch (e) { return JSON.stringify({ error: `git failed — ${(e as Error).message.split('\n')[0]?.slice(0, 120)}` }); }
    },
  });

  void env;
}
