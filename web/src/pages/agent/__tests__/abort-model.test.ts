/** Abort/fail transitions (plan Stage C) — action + no-op twins. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createRouter, createMemoryHistory } from 'vue-router';
import AgentChatPage from '../AgentChatPage.vue';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
const jsonOk = (body: unknown): Response => ({ ok: true, json: async () => body } as unknown as Response);

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string) => {
    if (url === '/api/auth/me') return Promise.resolve(jsonOk({ user: { id: 'u1', name: 'B', email: 'b@x', role: 'operator' } }));
    if (url.startsWith('/api/agent/sessions/s')) return Promise.resolve(jsonOk({ session: { title: 't' }, messages: [] }));
    if (url === '/api/agent/chats' || url === '/api/agent/sessions') return Promise.resolve(jsonOk({ chats: [], sessions: [] }));
    return Promise.resolve(jsonOk({}));
  });
});

type VM = { messages: Array<{ text: string; aborted?: boolean; role: string }>; markAborted: (i: number) => void };

async function page(): Promise<VM> {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/agent', component: AgentChatPage }, { path: '/', component: { template: '<div/>' } }] });
  router.push('/agent'); await router.isReady();
  const w = mount(AgentChatPage, { global: { plugins: [router] }, attachTo: document.body });
  await flushPromises(); await new Promise((r) => setTimeout(r, 20)); await flushPromises();
  return w.vm as unknown as VM;
}

describe('markAborted transitions', () => {
  it('marks a user row aborted', async () => {
    const vm = await page();
    vm.messages = [{ role: 'user', text: 'q' }];
    vm.markAborted(0);
    expect(vm.messages[0]?.aborted).toBe(true);
  });

  it('no-op twin: assistant rows NEVER marked aborted', async () => {
    const vm = await page();
    vm.messages = [{ role: 'assistant', text: 'a' }];
    vm.markAborted(0);
    expect(vm.messages[0]?.aborted ?? null).toBeNull();
  });

  it('no-op twin: out-of-range index changes nothing', async () => {
    const vm = await page();
    vm.messages = [{ role: 'user', text: 'q' }];
    vm.markAborted(9);
    expect(vm.messages[0]?.aborted ?? null).toBeNull();
  });
});
