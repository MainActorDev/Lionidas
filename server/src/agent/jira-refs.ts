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
  // Jira Cloud API tokens authenticate with Basic (email:token); Bearer only
  // suits server-side PATs. Honor whichever pairing is configured.
  const email = env['JIRA_EMAIL'];
  const auth = email
    ? `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`
    : `Bearer ${token}`;
  const q = query.trim();
  if (!q) return { configured: true, issues: [] };
  const jql = /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(q)
    ? `key = "${q}"`
    : `text ~ "${q.replace(/"/g, '\\"')}" ORDER BY updated DESC`;
  const res = await fetchImpl(
    `${baseUrl.replace(/\/+$/, '')}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=${MAX_ROWS}&fields=summary,issuetype`,
    { headers: { authorization: auth, accept: 'application/json' } },
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

/** full issue fetch — summary, description, status, comments (read class) */
export async function jiraGet(key: string, env: Record<string, string | undefined>, fetchImpl: typeof fetch = fetch): Promise<string> {
  const token = env['JIRA_TOKEN'];
  const baseUrl = env['JIRA_BASE_URL'];
  if (!token || !baseUrl) return `[jira ${key}] not configured — set JIRA_TOKEN and JIRA_BASE_URL on the server`;
  if (!/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(key)) return `[jira ${key}] not a valid ticket key`;
  const email = env['JIRA_EMAIL'];
  const auth = email
    ? `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`
    : `Bearer ${token}`;
  const res = await fetchImpl(
    `${baseUrl.replace(/\/+$/, '')}/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description,status,issuetype,comment,assignee,reporter,subtasks,issuelinks`,
    { headers: { authorization: auth, accept: 'application/json' } },
  ).catch(() => null);
  if (!res) return `[jira ${key}] unreachable — network error`;
  if (res.status === 401 || res.status === 403) return `[jira ${key}] rejected the token (401/403)`;
  if (res.status === 404) return `[jira ${key}] not found`;
  if (!res.ok) return `[jira ${key}] fetch failed (${res.status})`;
  const issue = (await res.json().catch(() => null)) as {
    key: string;
    fields: {
      summary?: string; description?: unknown; status?: { name?: string }; issuetype?: { name?: string };
      assignee?: { displayName?: string } | null; reporter?: { displayName?: string };
      comment?: { comments?: Array<{ author?: { displayName?: string }; body?: unknown }> };
      subtasks?: Array<{ key: string; fields?: { summary?: string; status?: { name?: string } } }>;
      issuelinks?: Array<{ outwardIssue?: { key: string; fields?: { summary?: string } }; inwardIssue?: { key: string; fields?: { summary?: string } } }>;
    };
  } | null;
  if (!issue) return `[jira ${key}] unparseable response`;
  const f = issue.fields;
  const lines = [
    `KEY: ${issue.key}`,
    `SUMMARY: ${f.summary ?? ''}`,
    `TYPE: ${f.issuetype?.name ?? ''} · STATUS: ${f.status?.name ?? ''}`,
    `ASSIGNEE: ${f.assignee?.displayName ?? 'unassigned'} · REPORTER: ${f.reporter?.displayName ?? '?'}`,
    `DESCRIPTION: ${renderJiraDoc(f.description)}`,
    ...(f.subtasks ?? []).map((st) => `SUBTASK: ${st.key} ${st.fields?.summary ?? ''} (${st.fields?.status?.name ?? ''})`),
    ...(f.issuelinks ?? []).map((l) => `LINK: ${l.outwardIssue ? `${issue.key} → ${l.outwardIssue.key} ${l.outwardIssue.fields?.summary ?? ''}` : `${l.inwardIssue?.key ?? '?'} → ${issue.key} ${l.inwardIssue?.fields?.summary ?? ''}`}`),
    ...(f.comment?.comments ?? []).slice(-10).map((c) => `COMMENT (${c.author?.displayName ?? '?'}): ${renderJiraDoc(c.body)}`),
  ];
  return lines.join('\n').slice(0, 12000);
}

/** Jira Cloud ADF (Atlassian Document Format) → plain text, best effort */
function renderJiraDoc(node: unknown): string {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(renderJiraDoc).join('\n');
  if (typeof node === 'object') {
    const n = node as { type?: string; text?: string; content?: unknown };
    if (n.type === 'text' && n.text) return n.text;
    if (n.content) return renderJiraDoc(n.content);
  }
  return '';
}

/** registers the jira tools on the lionidas registry (read class) — exposed via
 *  the MCP mount like every other registry tool */
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
  registry.register({
    name: 'jira.get',
    description: 'read one Jira ticket in full — summary, description (ADF→text), status, subtasks, links, last 10 comments',
    permission: 'read',
    parameters: { type: 'object', properties: { key: { type: 'string', description: 'ticket key, e.g. CUST-6001' } }, required: ['key'] },
    async execute(args) {
      return jiraGet(String(args['key'] ?? ''), env);
    },
  });
}
