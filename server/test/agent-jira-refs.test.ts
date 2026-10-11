/** rev23 F3 tests — jira.search: configured flag, JQL shapes, sad paths (hermetic, injected fetch). */
import { describe, expect, it } from 'vitest';
import { jiraSearch, registerJiraTools } from '../src/agent/jira-refs.ts';
import { ToolRegistry } from '@mainactordev/butler';

function res(issues: Array<{ key: string; summary: string; type: string }>, status = 200): Response {
  return new Response(JSON.stringify({ issues: issues.map((i) => ({ key: i.key, fields: { summary: i.summary, issuetype: { name: i.type } } })) }), { status });
}

describe('jiraSearch (hermetic)', () => {
  const env = { JIRA_TOKEN: 't', JIRA_BASE_URL: 'https://x.atlassian.net' };

  it('unconfigured → honest configured:false with the env hint', async () => {
    const out = await jiraSearch('login', {});
    expect(out).toEqual({ configured: false, issues: [], reason: expect.stringContaining('JIRA_TOKEN') });
  });

  it('text query → text ~ JQL; rows carry key/title/type', async () => {
    let seenUrl = '';
    const out = await jiraSearch('login validation', env, async (u: string | URL | Request) => {
      seenUrl = String(u);
      return res([{ key: 'LP-1042', summary: 'Add QR login', type: 'Story' }]);
    });
    expect(seenUrl).toContain(encodeURIComponent('text ~ "login validation"'));
    expect(out.configured).toBe(true);
    if (out.configured && 'issues' in out) expect(out.issues[0]).toMatchObject({ key: 'LP-1042', type: 'Story' });
  });

  it('exact key query → key = JQL', async () => {
    let seenUrl = '';
    await jiraSearch('LP-1042', env, async (u) => { seenUrl = String(u); return res([]); });
    expect(seenUrl).toContain(encodeURIComponent('key = "LP-1042"'));
  });

  it('quotes are escaped in JQL (no injection)', async () => {
    let seenUrl = '';
    await jiraSearch('x" OR 1=1', env, async (u) => { seenUrl = String(u); return res([]); });
    expect(seenUrl).toContain(encodeURIComponent('x\\" OR 1=1'));
  });

  it('401 → honest token error', async () => {
    const out = await jiraSearch('x', env, async () => new Response('nope', { status: 401 }));
    expect(out.configured).toBe(true);
    if (out.configured && !('reason' in out) && 'error' in out) expect(out.error).toMatch(/401/);
  });

  it('network failure → unreachable error (not a throw)', async () => {
    const out = await jiraSearch('x', env, async () => { throw new Error('boom'); });
    expect(out.configured).toBe(true);
    if (out.configured && !('reason' in out) && 'error' in out) expect(out.error).toMatch(/unreachable/);
  });

  it('empty query → empty issues, no fetch', async () => {
    let called = false;
    const out = await jiraSearch('  ', env, async () => { called = true; return res([]); });
    expect(called).toBe(false);
    expect(out).toEqual({ configured: true, issues: [] });
  });
});

describe('jira.search registry tool', () => {
  it('executes and returns the JSON payload (unconfigured env in this test)', async () => {
    const reg = new ToolRegistry();
    registerJiraTools(reg, {});
    const out = await reg.execute('jira.search', { query: 'login' }, { signal: undefined, sessionId: 't' }, { name: 'test', allows: 'read', permits: () => true } as never);
    const parsed = JSON.parse(out) as { configured: boolean };
    expect(parsed.configured).toBe(false); // honest unconfigured state
  });
});
