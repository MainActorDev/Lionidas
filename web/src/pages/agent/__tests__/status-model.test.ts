/** Transition tests with no-op twins (lobe-chat discipline, plan Stage A):
 *  every derivation branch + its precondition-absent twin. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createRouter, createMemoryHistory } from 'vue-router';
import AgentChatPage from '../AgentChatPage.vue';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
const jsonOk = (body: unknown): Response => ({ ok: true, json: async () => body } as unknown as Response);

let sessionPayload: unknown = { session: { title: 't' }, messages: [] };

beforeEach(() => {
  sessionPayload = { session: { title: 't' }, messages: [] };
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
    if (url === '/api/auth/me') return Promise.resolve(jsonOk({ user: { id: 'u1', name: 'B', email: 'b@x', role: 'operator' } }));
    if (url === '/api/agent/sessions' && init?.method === 'POST') return Promise.resolve(jsonOk({ session: { id: 's_new' } }));
    if (url.startsWith('/api/agent/sessions/s')) return Promise.resolve(jsonOk(sessionPayload));
    if (url === '/api/agent/chats' || url === '/api/agent/sessions') return Promise.resolve(jsonOk({ chats: [], sessions: [] }));
    return Promise.resolve(jsonOk({}));
  });
});

async function opened(): Promise<{ vm: { messages: Array<{ text: string; status?: string; aborted?: boolean }> } & ReturnType<typeof mount>['vm'] }> {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/agent', component: AgentChatPage }, { path: '/', component: { template: '<div/>' } }] });
  router.push('/agent'); await router.isReady();
  const w = mount(AgentChatPage, { global: { plugins: [router] }, attachTo: document.body });
  await flushPromises(); await new Promise((r) => setTimeout(r, 20)); await flushPromises();
  await (w.vm as unknown as { openSession: (id: string) => Promise<void> }).openSession('s1');
  await flushPromises();
  return { vm: w.vm as never } as never;
}

describe('retry collapse (the triple-bubble round, sess_e2e40228)', () => {
  it('three identical asks + one answer → ONE user bubble, attempt count, no dupes', async () => {
    sessionPayload = { session: { title: 't' }, messages: [
      { role: 'assistant', content: 'prior answer' },
      { role: 'user', content: 'do the thing [cmds: /author]' },
      { role: 'user', content: 'do the thing [cmds: /author]' },
      { role: 'user', content: 'do the thing [cmds: /author]' },
      { role: 'assistant', content: '## Blocker first — no tools' },
    ] };
    const { vm } = await opened();
    const users = vm.messages.filter((m) => m.role === 'user');
    expect(users.length).toBe(1); // collapsed
    expect(users[0]?.text).toContain('do the thing');
    expect(vm.messages.length).toBe(3); // prior assistant + 1 user + final assistant
  });

  it('identical trailing unanswered asks → one bubble, never-sent tries label', async () => {
    sessionPayload = { session: { title: 't' }, messages: [
      { role: 'user', content: 'again [cmds: /author]' },
      { role: 'user', content: 'again [cmds: /author]' },
    ] };
    const { vm } = await opened();
    const users = vm.messages.filter((m) => m.role === 'user');
    expect(users.length).toBe(1);
    expect(users[0]?.status).toBe('unsent');
  });

  it('no-op twin: DISTINCT consecutive asks never collapse', async () => {
    sessionPayload = { session: { title: 't' }, messages: [
      { role: 'user', content: 'question A' },
      { role: 'user', content: 'question B' },
      { role: 'assistant', content: 'answering B' },
    ] };
    const { vm } = await opened();
    const users = vm.messages.filter((m) => m.role === 'user');
    expect(users.length).toBe(2);
    expect(users[0]?.aborted).toBe(true); // A died mid-history — still honest
  });
});

describe('status derivation (reload)', () => {
  it('answered pair → NO status flags (the no-op twin)', async () => {
    sessionPayload = { session: { title: 't' }, messages: [
      { role: 'user', content: 'q' }, { role: 'assistant', content: 'a' },
    ] };
    const { vm } = await opened();
    expect(vm.messages[0]?.status ?? null).toBeNull(); expect(vm.messages[0]?.aborted ?? null).toBeNull();
  });

  it('trailing unanswered + liveTurn → in_flight', async () => {
    sessionPayload = { session: { title: 't' }, messages: [{ role: 'user', content: 'q' }], liveTurn: { turnId: 't1', startedAt: 1 } };
    const { vm } = await opened();
    expect(vm.messages[0]?.status).toBe('in_flight'); expect(vm.messages[0]?.aborted ?? null).toBeNull();
  });

  it('trailing unanswered + NO liveTurn → unsent (never failed)', async () => {
    sessionPayload = { session: { title: 't' }, messages: [{ role: 'user', content: 'q' }] };
    const { vm } = await opened();
    expect(vm.messages[0]?.status).toBe('unsent'); expect(vm.messages[0]?.aborted ?? null).toBeNull();
  });

  it('MID-history gap → aborted (real abort, not unsent)', async () => {
    sessionPayload = { session: { title: 't' }, messages: [
      { role: 'user', content: 'q1 (died)' }, { role: 'user', content: 'q2' }, { role: 'assistant', content: 'a2' },
    ] };
    const { vm } = await opened();
    expect(vm.messages[0]?.aborted).toBe(true); expect(vm.messages[0]?.status ?? null).toBeNull();
    expect(vm.messages[1]?.aborted ?? null).toBeNull(); expect(vm.messages[1]?.status ?? null).toBeNull();
  });

  it('assistant rows never carry user statuses (no-op twin)', async () => {
    sessionPayload = { session: { title: 't' }, messages: [{ role: 'assistant', content: 'solo' }] };
    const { vm } = await opened();
    expect(vm.messages[0]?.role).toBe('assistant'); expect(vm.messages[0]?.status ?? null).toBeNull();
  });
});
