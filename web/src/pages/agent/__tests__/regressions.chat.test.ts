/** Regression locks (plan 20261013T160847Z Stage D — FIRST, before any refactor):
 *  each block encodes one incident from this session's ledger so the fixed
 *  behavior can never silently regress (lobe-chat's incident-named pattern). */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createRouter, createMemoryHistory } from 'vue-router';
import AgentChatPage from '../AgentChatPage.vue';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function jsonOk(body: unknown): Response {
  return { ok: true, json: async () => body } as unknown as Response;
}

let sessionPayload: unknown = { session: { title: 't' }, messages: [] };

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
    if (url === '/api/auth/me') return Promise.resolve(jsonOk({ user: { id: 'u1', name: 'Bayu', email: 'b@x', role: 'operator' } }));
    if (url === '/api/agent/sessions' && init?.method === 'POST') return Promise.resolve(jsonOk({ session: { id: 's_new' } }));
    if (url.startsWith('/api/agent/sessions/s')) return Promise.resolve(jsonOk(sessionPayload));
    if (url === '/api/agent/chats' || url === '/api/agent/sessions') return Promise.resolve(jsonOk({ chats: [], sessions: [] }));
    if (url.includes('/messages') && init?.method === 'POST') return Promise.resolve(jsonOk({ turn: { ok: true, answer: 'ok' } }));
    return Promise.resolve(jsonOk({}));
  });
});

async function mountPage(): Promise<ReturnType<typeof mount>> {
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/agent', name: 'agentChat', component: AgentChatPage },
    { path: '/', name: 'root', component: { template: '<div/>' } },
  ] });
  router.push('/agent');
  await router.isReady();
  const w = mount(AgentChatPage, { global: { plugins: [router] }, attachTo: document.body });
  await flushPromises();
  await new Promise((r) => setTimeout(r, 30));
  await flushPromises();
  return w;
}

describe('regression: resend-commands (9fc33a2)', () => {
  it('resend decomposes [cmds:]/[refs:] back into payloads — never literal prose', async () => {
    const w = await mountPage();
    const vm = w.vm as unknown as { resend: (m: unknown) => void; messages: Array<{ text: string }> };
    vm.messages = [{ role: 'user', text: 'do the thing [cmds: /author] [refs: jira:CUST-1]', aborted: true } as never];
    vm.resend(vm.messages[0]!);
    await flushPromises();
    const sent = fetchMock.mock.calls.find((c) => String(c[0]).includes('/messages') && String(c[1]?.method) === 'POST');
    expect(sent).toBeTruthy();
    const body = JSON.parse(String(sent![1]?.body)) as { content: string; commands?: string[] };
    expect(body.commands).toEqual(['/author']);      // the INTENT rides the payload (the lock)
    expect(body.content).not.toContain('jira:CUST-1'); // refs do NOT ride as prose
    w.unmount();
  });
});

describe('regression: false-abort (c9e153b + liveTurn)', () => {
  it('reload: trailing unanswered + liveTurn → NOT aborted (facts beat the heuristic)', async () => {
    sessionPayload = { session: { title: 't' }, messages: [{ role: 'user', content: 'hello?' }], liveTurn: { turnId: 't1', startedAt: Date.now() } };
    const w = await mountPage();
    const vm = w.vm as unknown as { openSession: (id: string) => Promise<void>; messages: Array<{ aborted?: boolean }> };
    await vm.openSession('s1');
    await flushPromises();
    expect(vm.messages[0]?.aborted).not.toBe(true);
    w.unmount();
  });
});

describe('regression: queue-displacement (9fc33a2 part 2)', () => {
  it('a displaced queued message is never silently deleted — it stays, marked displaced', async () => {
    const w = await mountPage();
    const vm = w.vm as unknown as { messages: Array<{ text: string; displaced?: boolean }>; send: (t: string, r: unknown, a: string, c?: string[]) => Promise<void> };
    vm.messages = [];
    // first send starts a turn that does NOT resolve (pending promise) → sending stays true
    let release: ((v: unknown) => void) | null = null;
    fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (url.includes('/messages') && init?.method === 'POST' && !release) { return new Promise((res) => { release = res; }); }
      if (url === '/api/auth/me') return Promise.resolve(jsonOk({ user: { id: 'u1', name: 'Bayu', email: 'b@x', role: 'operator' } }));
      if (url === '/api/agent/sessions' && init?.method === 'POST') return Promise.resolve(jsonOk({ session: { id: 's_new' } }));
      if (url.startsWith('/api/agent/sessions/s')) return Promise.resolve(jsonOk(sessionPayload));
      if (url === '/api/agent/chats' || url === '/api/agent/sessions') return Promise.resolve(jsonOk({ chats: [], sessions: [] }));
      return Promise.resolve(jsonOk({}));
    });
    void vm.send('in-flight ask', [], '');
    await flushPromises();
    // two more sends arrive while busy → both queue; second displaces first
    void vm.send('first queued', [], '');
    await flushPromises();
    void vm.send('second queued', [], '');
    await flushPromises();
    const first = vm.messages.find((m) => m.text.includes('first queued'));
    expect(first).toBeTruthy();
    expect(first?.displaced).toBe(true);
    release?.(jsonOk({ turn: { ok: true, answer: 'done' } }));
    await flushPromises();
    void release;
    w.unmount();
  });
});
