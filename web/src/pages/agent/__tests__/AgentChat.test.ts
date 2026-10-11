/** P3 agent-chat component tests (plan C7): page mounts + theme vars,
 *  sidebar search, composer deterministic rule, panel question → answer,
 *  collapse + pill. Mocked fetch; no server. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createRouter, createMemoryHistory } from 'vue-router';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

import AgentChatPage from '../AgentChatPage.vue';

function jsonOk(body: unknown): Response {
  return { ok: true, json: async () => body } as unknown as Response;
}

function me(role: string): { user: { id: string; name: string; email: string; role: string } } {
  return { user: { id: 'u1', name: 'Bayu', email: 'b@x', role } };
}

async function mountPage(role = 'operator'): Promise<ReturnType<typeof mount>> {
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/agent', name: 'agentChat', component: AgentChatPage },
    { path: '/', name: 'root', component: { template: '<div/>' } },
  ] });
  router.push('/agent');
  await router.isReady();
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
    if (url === '/api/auth/me') return Promise.resolve(jsonOk(me(role)));
    if (url === '/api/agent/sessions' && init?.method === 'POST') return Promise.resolve(jsonOk({ session: { id: 's_new' } }));
    if (url === '/api/agent/chats') return Promise.resolve(jsonOk({ chats: [
      { id: 's1', title: 'DEMO-101 cases', status: 'active', updatedAt: Date.now() - 60_000, owner: 'Bayu', ownerRole: 'operator' },
      { id: 's2', title: 'payments sweep', status: 'ended', updatedAt: Date.now() - 3_600_000, owner: 'Bayu', ownerRole: 'operator' },
    ] }));
    if (url === '/api/agent/sessions') return Promise.resolve(jsonOk({ sessions: [
      { id: 's1', title: 'DEMO-101 cases', user_id: 'u1', status: 'active', created_at: 1, updated_at: Date.now() - 60_000 },
      { id: 's2', title: 'payments sweep', user_id: 'u1', status: 'ended', created_at: 1, updated_at: Date.now() - 3_600_000 },
    ] }));
    if (url === '/api/agent/sessions/s1') return Promise.resolve(jsonOk({ session: { title: 'DEMO-101 cases' }, messages: [
      { role: 'user', content: 'draft cases' },
      { role: 'assistant', content: 'on it' },
    ] }));
    if (url.includes('/messages')) return Promise.resolve(jsonOk({ turn: { ok: true, answer: 'mock reply' } }));
    if (url.includes('/api/agent/refs/jira')) return Promise.resolve(jsonOk({ configured: true, issues: [{ key: 'LP-1042', title: 'Add QR login', type: 'Story' }] }));
    if (url.includes('/api/apps/bundles')) return Promise.resolve(jsonOk({ bundles: ['com.lionparcel.dev'] }));
    if (url === '/api/agent/pipeline') return Promise.resolve(jsonOk({ runId: 'wfr_new', status: 'done', stages: [] }));
    return Promise.resolve(jsonOk({}));
  });
  const w = mount(AgentChatPage, { global: { plugins: [router] } });
  await flushPromises();
  return w;
}

describe('agent chat page', () => {
  beforeEach(() => { localStorage.clear(); });

  it('mounts for an operator with the scoped warm theme (canvas + ink vars)', async () => {
    const w = await mountPage('operator');
    const root = w.find('.ag-root');
    expect(root.exists()).toBe(true);
    // theme vars present on the scoped root (from agent-theme.css)
    expect(root.attributes('class')).toContain('ag-root');
    expect(w.find('.sb').exists()).toBe(true);
    expect(w.find('.new').text()).toContain('new chat');
  });

  it('viewer sees the operator-required state, not the chat', async () => {
    const w = await mountPage('viewer');
    expect(w.find('.denied').exists()).toBe(true);
    expect(w.text()).toContain('operator role required');
  });

  it('sidebar lists conversations and search filters them', async () => {
    const w = await mountPage('operator');
    expect(w.text()).toContain('DEMO-101 cases');
    expect(w.text()).toContain('payments sweep');
    const input = w.find('input.search');
    await input.setValue('payments');
    expect(w.text()).toContain('payments sweep');
    expect(w.text()).not.toContain('DEMO-101 cases');
  });

  it('selecting a conversation loads its thread', async () => {
    const w = await mountPage('operator');
    await w.findAll('.conv')[0]!.trigger('click');
    await flushPromises();
    expect(w.text()).toContain('on it');
  });

  it('composer: no refs → send posts a chat turn only (no pipeline call)', async () => {
    const w = await mountPage('operator');
    await w.find('textarea').setValue('hello');
    await w.find('.send').trigger('click');
    await flushPromises();
    const calls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes('/api/agent/pipeline'))).toBe(false);
    expect(calls.some((u) => u.includes('/api/agent/sessions/') && u.includes('/messages'))).toBe(true);
  });

  it('composer: refs attached ⇒ send starts the pipeline (deterministic rule)', async () => {
    const w = await mountPage('operator');
    // rev23: @-mention flow — type @, pick jira, search returns fixture rows
    await w.find('textarea').setValue('@');
    await flushPromises();
    await w.findAll('.slash-row')[0]!.trigger('mousedown'); // @jira (row 0)
    await flushPromises();
    await w.find('textarea').setValue('login');
    await new Promise((r) => setTimeout(r, 450)); // debounce 300ms + fetch
    await flushPromises();
    await w.findAll('.slash-row')[0]!.trigger('mousedown'); // LP-1042 fixture row
    await flushPromises();
    await w.find('textarea').setValue('');
    const sel = w.find('.bundle');
    await sel.setValue('com.lionparcel.dev');
    await w.find('textarea').setValue('draft cases');
    await w.find('.send').trigger('click');
    await flushPromises();
    const pipe = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/agent/pipeline'));
    expect(pipe).toBeTruthy();
    const body = JSON.parse(String(pipe![1]!.body)) as { appBundle: string; refs: Array<{ kind: string; locator: string }> };
    expect(body.appBundle).toBe('com.lionparcel.dev');
    expect(body.refs[0]).toMatchObject({ kind: 'jira', locator: 'LP-1042' });
  });

  it('run panel: question card answers via the answer+resume endpoints', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/agent/pipeline/wfr_1') && !url.includes('answer') && !url.includes('resume')) {
        return Promise.resolve(jsonOk({ run: { id: 'wfr_1', status: 'awaiting_answer', currentStage: 'plan' }, stages: [
          { id: 'plan', status: 'paused', attempt: 1, question: { questions: [{ id: 'q1', text: 'Face ID and passcode?' }] } },
          { id: 'breakdown', status: 'pending', attempt: 0 },
        ] }));
      }
      if (url.includes('/api/agent/artifacts')) return Promise.resolve(jsonOk({ artifacts: [] }));
      return Promise.resolve(jsonOk({}));
    });
    const RunPanel = (await import('../components/RunPanel.vue')).default;
    const pw = mount(RunPanel, { props: { runId: 'wfr_1' } });
    await flushPromises();
    await flushPromises();
    expect(pw.text()).toContain('Face ID and passcode?');
    await pw.find('.q textarea').setValue('both');
    await pw.find('.q .primary').trigger('click');
    await flushPromises();
    const answered = fetchMock.mock.calls.find((c) => String(c[0]).includes('/answer'));
    const resumed = fetchMock.mock.calls.find((c) => String(c[0]).includes('/resume'));
    expect(answered).toBeTruthy();
    expect(resumed).toBeTruthy();
  });

  it('panel collapse » → floating pill appears; click reopens', async () => {
    const w = await mountPage('operator');
    expect(w.find('.reopen').exists()).toBe(false);
    await w.find('.x').trigger('click');
    expect(w.find('.panel').classes()).toContain('closed');
    expect(w.find('.reopen').exists()).toBe(true);
    await w.find('.reopen').trigger('click');
    expect(w.find('.panel').classes()).not.toContain('closed');
  });
});
