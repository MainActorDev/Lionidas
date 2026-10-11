/** rev23 F3: Jira ref search — one implementation behind the registry tool
 *  (jira.search); the HTTP route calls the same tool. Env-gated via JIRA_TOKEN
 *  (+ JIRA_BASE_URL, JIRA_PROJECT): unconfigured → honest configured:false,
 *  never a spinner. Injectable fetch for hermetic tests. */
import type { ToolRegistry } from '@mainactordev/butler';

export interface JiraSearchRow { key: string; title: string; type: string }
export type JiraSearchResult =
  | { configured: true; issues: JiraSearchRow[] }
  | { configured: false; issues: []; reason: string }
  | { configured: true; issues: []; error: string };

const MAX_ROWS = 20;

/** JQL text-search + key-prefix resolution against Jira cloud REST (API v3). */
export async function jiraSearch(query: string, env: Record<string, string | undefined>, fetchImpl: typeof fetch = fetch): Promise<JiraSearchResult> {
  const token = env['JIRA_TOKEN'];
  const baseUrl = env['JIRA_BASE_URL'];
  if (!token || !baseUrl) {
    return { configured: false, issues: [], reason: 'Jira not configured — set JIRA_TOKEN and JIRA_BASE_URL on the server' };
  }
  const q = query.trim();
  if (!q) return { configured: true, issues: [] };
  const jql = /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(q)
    ? `key = "${q}"`
    : `text ~ "${q.replace(/"/g, '\\"')}" ORDER BY updated DESC`;
  const res = await fetchImpl(
    `${baseUrl.replace(/\/+$/, '')}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=${MAX_ROWS}&fields=summary,issuetype`,
    { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } },
  ).catch(() => null);
  if (!res) return { configured: true, issues: [], error: 'Jira unreachable — network error' };
  if (res.status === 401 || res.status === 403) return { configured: true, issues: [], error: 'Jira rejected the token (401/403) — check JIRA_TOKEN' };
  if (res.status === 429) return { configured: true, issues: [], error: 'Jira rate-limited (429) — try again shortly' };
  if (!res.ok) return { configured: true, issues: [], error: `Jira search failed (${res.status})` };
  const body = (await res.json().catch(() => null)) as { issues?: Array<{ key: string; fields: { summary?: string; issuetype?: { name?: string } } }> } | null;
  if (!body) return { configured: true, issues: [], error: 'Jira returned an unparseable body' };
  return {
    configured: true,
    issues: (body.issues ?? []).map((i) => ({ key: i.key, title: i.fields.summary ?? '', type: i.fields.issuetype?.name ?? 'Issue' })),
  };
}

/** registers jira.search on the lionidas registry (read class) */
export function registerJiraTools(registry: ToolRegistry, env: Record<string, string | undefined>): void {
  registry.register({
    name: 'jira.search',
    description: 'search Jira tickets by text or exact key (KEY-123) — returns key, title, issue type',
    permission: 'read',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'search text or ticket key' } }, required: ['query'] },
    async execute(args) {
      return JSON.stringify(await jiraSearch(String(args['query'] ?? ''), env));
    },
  });
}
