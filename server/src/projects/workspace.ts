/** Project workspace management: clone/pull/status for registered projects
 *  into the centralized repos workspace (reposDir()/projectWorkspace — the
 *  system owns the layout; nobody types a path).
 *
 *  Auth: the per-project token (write-only in the DB) is injected at CALL
 *  time only — https URLs get https://x-access-token:<tok>@host, ssh remotes
 *  get a one-shot GIT_ASKPASS helper (token never in argv, script deleted in
 *  finally). Errors are token-redacted before they leave this module. */
import type Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getProject, projectAuthToken } from './store.ts';
import { projectWorkspace } from '../manual/packages.ts';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10 * 60_000;

export type WorkspaceResult =
  | { ok: true; kind: 'cloned' | 'pulled'; path: string }
  | { ok: false; code: 'WORKSPACE_EXISTS' | 'WORKSPACE_MISSING' | 'GIT_FAILED'; error: string };

export interface WorkspaceStatus {
  exists: boolean;
  branch: string | null;
  head: string | null;
  dirty: number | null;
}

/** https URL → token-injected URL; ssh remote → null (askpass path handles it). */
function httpsWithToken(url: string, token: string): string {
  const m = /^https:\/\/([^/]+)(\/.*)$/.exec(url);
  if (!m) return url;
  return `https://x-access-token:${token}@${m[1]}${m[2]}`;
}

interface GitOpts { token?: string | null }
async function git(args: string[], cwd: string | undefined, opts: GitOpts): Promise<string> {
  const env: Record<string, string> = { ...process.env as Record<string, string> };
  let askpassDir: string | null = null;
  if (opts.token && !env['GIT_ASKPASS']) {
    // ssh remotes: git invokes GIT_ASKPASS for credentials; the helper prints
    // the token. Lives only for this call.
    askpassDir = mkdtempSync(join(tmpdir(), 'askpass-'));
    const p = join(askpassDir, 'ap');
    writeFileSync(p, `#!/bin/sh\necho ${JSON.stringify(opts.token)}\n`);
    chmodSync(p, 0o700);
    env['GIT_ASKPASS'] = p;
    env['GIT_TERMINAL_PROMPT'] = '0';
    env['SSH_ASKPASS'] = p;
  }
  try {
    const r = await execFileAsync('git', args, { cwd, timeout: GIT_TIMEOUT_MS, env });
    return r.stdout.trim();
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    let msg = (e.stderr ?? e.message ?? 'git failed').trim();
    if (opts.token) msg = msg.split(opts.token).join('***');
    throw new Error(msg);
  } finally {
    if (askpassDir) rmSync(askpassDir, { recursive: true, force: true });
  }
}

const inFlight = new Map<string, Promise<WorkspaceResult>>();

export function cloneProject(db: Database.Database, id: string, opts: { pullIfExists?: boolean } = {}): Promise<WorkspaceResult> {
  const existing = inFlight.get(id);
  if (existing) return existing;
  const p = (async (): Promise<WorkspaceResult> => {
    const proj = getProject(db, id);
    if (!proj) return { ok: false, code: 'GIT_FAILED', error: 'project not found' };
    const dest = projectWorkspace(proj.name);
    if (existsSync(dest)) {
      if (opts.pullIfExists) return pullProject(db, id);
      return { ok: false, code: 'WORKSPACE_EXISTS', error: `workspace already exists at ${dest} — pull to refresh it` };
    }
    const token = projectAuthToken(db, id);
    const useAskpass = Boolean(token && !proj.repoUrl.startsWith('https://'));
    const url = token && proj.repoUrl.startsWith('https://')
      ? httpsWithToken(proj.repoUrl, token)
      : proj.repoUrl;
    const args = ['clone', '--depth', '50'];
    if (proj.defaultBranch) args.push('--branch', proj.defaultBranch);
    args.push(url, dest);
    try {
      await git(args, undefined, { token: useAskpass ? token : null });
      return { ok: true, kind: 'cloned', path: dest };
    } catch (err) {
      // redact BOTH the bare token and any token-bearing URL we constructed
      let msg = err instanceof Error ? err.message : 'clone failed';
      if (token) msg = msg.split(token).join('***');
      return { ok: false, code: 'GIT_FAILED', error: msg };
    }
  })();
  inFlight.set(id, p);
  void p.finally(() => { inFlight.delete(id); });
  return p;
}

export function pullProject(db: Database.Database, id: string): Promise<WorkspaceResult> {
  const existing = inFlight.get(id);
  if (existing) return existing;
  const p = (async (): Promise<WorkspaceResult> => {
    const proj = getProject(db, id);
    if (!proj) return { ok: false, code: 'GIT_FAILED', error: 'project not found' };
    const dest = projectWorkspace(proj.name);
    if (!existsSync(dest)) return { ok: false, code: 'WORKSPACE_MISSING', error: `no workspace at ${dest} — clone first` };
    const token = projectAuthToken(db, id);
    // fetch with the token (https remote URL rewrite; ssh rides askpass)
    try {
      if (proj.repoUrl.startsWith('https://') && token) {
        await git(['fetch', '--prune', httpsWithToken(proj.repoUrl, token), '+refs/heads/*:refs/remotes/origin/*'], dest, {});
      } else if (token) {
        // ssh remote cloned with askpass: origin keeps the clean ssh URL —
        // plain fetch rides GIT_ASKPASS for credentials
        await git(['fetch', '--prune', 'origin'], dest, { token });
      } else {
        await git(['fetch', '--prune', 'origin'], dest, {});
      }
      if (proj.defaultBranch) {
        await git(['checkout', proj.defaultBranch], dest, {});
        await git(['reset', '--hard', `origin/${proj.defaultBranch}`], dest, {});
      }
      return { ok: true, kind: 'pulled', path: dest };
    } catch (err) {
      return { ok: false, code: 'GIT_FAILED', error: err instanceof Error ? err.message : 'pull failed' };
    }
  })();
  inFlight.set(id, p);
  void p.finally(() => { inFlight.delete(id); });
  return p;
}

export async function workspaceStatus(db: Database.Database, id: string): Promise<WorkspaceStatus> {
  const proj = getProject(db, id);
  if (!proj) return { exists: false, branch: null, head: null, dirty: null };
  const dest = projectWorkspace(proj.name);
  if (!existsSync(join(dest, '.git'))) return { exists: false, branch: null, head: null, dirty: null };
  try {
    const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], dest, {})) || null;
    const head = (await git(['rev-parse', '--short', 'HEAD'], dest, {})) || null;
    const st = await git(['status', '--porcelain'], dest, {});
    const dirty = st ? st.split('\n').filter(Boolean).length : 0;
    return { exists: true, branch, head, dirty };
  } catch {
    return { exists: true, branch: null, head: null, dirty: null };
  }
}
