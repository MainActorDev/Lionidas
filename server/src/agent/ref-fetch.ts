/** rev23 F5: external ref fetchers for the pipeline — jira tickets and github commits/PRs
 *  resolve to text at compile time. Jira: env token (JIRA_TOKEN/JIRA_BASE_URL). GitHub: gh CLI
 *  (same auth precedence as repo-refs). Honest error strings, never silent empties. */
import type { PipelineRef } from './knowledge.ts';
import { jiraSearch } from './jira-refs.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

async function jiraText(locator: string, env: Record<string, string | undefined>): Promise<string> {
  const res = await jiraSearch(locator, env);
  if (!res.configured) return `[jira ${locator}] not fetched — ${res.reason}`;
  if ('error' in res && res.error) return `[jira ${locator}] fetch failed — ${res.error}`;
  const issue = res.issues.find((i) => i.key === locator) ?? res.issues[0];
  if (!issue) return `[jira ${locator}] not found`;
  return `[jira ${issue.key}] ${issue.type} — ${issue.title}`;
}

async function ghJson(args: string[], env: Record<string, string | undefined>): Promise<unknown> {
  const childEnv: Record<string, string> = {};
  const crucible = (env['CRUCIBLE_GITHUB_TOKEN'] ?? '').trim();
  if (crucible) childEnv['GH_TOKEN'] = crucible;
  const { stdout } = await exec('gh', args, { timeout: 15_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, ...childEnv } });
  return JSON.parse(stdout);
}

function parseRepoLocator(locator: string): { owner: string; repo: string; kind: 'pr' | 'commit'; n: string } | null {
  // accepts: https://github.com/Owner/repo/pull/123 | Owner/repo#PR-123 | Owner/repo/abc1234
  const m1 = /github\.com\/([^/]+)\/([^/]+)\/(?:pull|pulls)\/(\d+)/.exec(locator);
  if (m1?.[1] && m1[2] && m1[3]) return { owner: m1[1], repo: m1[2], kind: 'pr', n: m1[3] };
  const m2 = /^([^/\s]+)\/([^/\s#]+)#(?:PR-)?(\d+)$/i.exec(locator);
  if (m2?.[1] && m2[2] && m2[3]) return { owner: m2[1], repo: m2[2], kind: 'pr', n: m2[3] };
  const m3 = /^([^/\s]+)\/([^/\s]+)\/([0-9a-f]{7,40})$/.exec(locator);
  if (m3?.[1] && m3[2] && m3[3]) return { owner: m3[1], repo: m3[2], kind: 'commit', n: m3[3] };
  return null;
}

export async function fetchExternalText(ref: PipelineRef, env: Record<string, string | undefined>): Promise<string> {
  if (ref.kind === 'jira') return jiraText(ref.locator, env);
  if (ref.kind === 'github-pr' || ref.kind === 'github-commit') {
    const parsed = parseRepoLocator(ref.locator);
    if (!parsed) return `[${ref.kind} ${ref.locator}] unrecognized locator`;
    try {
      if (parsed.kind === 'pr') {
        const pr = (await ghJson(['api', `repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.n}`, '--method', 'GET'], env)) as { title?: string; body?: string; user?: { login?: string }; merged_at?: string | null };
        return `[PR ${parsed.owner}/${parsed.repo}#${parsed.n}] ${pr.title ?? ''}\nby ${pr.user?.login ?? '?'}${pr.merged_at ? ` · merged ${pr.merged_at.slice(0, 10)}` : ''}\n${(pr.body ?? '').slice(0, 4000)}`;
      }
      const c = (await ghJson(['api', `repos/${parsed.owner}/${parsed.repo}/commits/${parsed.n}`, '--method', 'GET'], env)) as { commit?: { message?: string; author?: { name?: string; date?: string } } };
      return `[commit ${parsed.owner}/${parsed.repo}@${parsed.n.slice(0, 7)}] ${(c.commit?.message ?? '').split('\n')[0]}\nby ${c.commit?.author?.name ?? '?'} · ${c.commit?.author?.date?.slice(0, 10) ?? ''}`;
    } catch (e) {
      return `[${ref.kind} ${ref.locator}] fetch failed — ${(e as Error).message.split('\n')[0]?.slice(0, 140)}`;
    }
  }
  return `[${ref.kind} ${ref.locator}] no external fetcher for this kind`;
}
