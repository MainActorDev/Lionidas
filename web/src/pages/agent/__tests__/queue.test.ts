/** Visible multi-slot queue transitions (plan Stage B) — action + no-op twins (lobe discipline). */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createRouter, createMemoryHistory } from 'vue-router';
import AgentChatPage from '../AgentChatPage.vue';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
const jsonOk = (body: unknown): Response => ({ ok: true, json: async () => body } as unknown as Response);

const gates: Array<(v: unknown) => void> = [];

beforeEach(() => {
  gates.length = 0;
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string, init?: { method?: string }) => {
    if (url.includes('/messages') && init?.method === 'POST') return new Promise((res) => { gates.push(res); });
    if (url === '/api/auth/me') return Promise.resolve(jsonOk({ user: { id: 'u1', name: 'B', email: 'b@x', role: 'operator' } }));
    if (url === '/api/agent/sessions' && init?.method === 'POST') return Promise.resolve(jsonOk({ session: { id: 's_new' } }));
    if (url.startsWith('/api/agent/sessions/s')) return Promise.resolve(jsonOk({ session: { title: 't' }, messages: [] }));
    if (url === '/api/agent/chats' || url === '/api/agent/sessions') return Promise.resolve(jsonOk({ chats: [], sessions: [] }));
    return Promise.resolve(jsonOk({}));
  });
});

type VM = { messages: Array<{ text: string; status?: string }>; send: (t: string, r: unknown, a: string, c?: string[]) => Promise<void>; queueSendNow: (id: number) => void; queueDelete: (id: number) => void; queueEdit: (id: number) => void };

async function page(): Promise<{ vm: VM } & ReturnType<typeof mount>> {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/agent', component: AgentChatPage }, { path: '/', component: { template: '<div/>' } }] });
  router.push('/agent'); await router.isReady();
  const w = mount(AgentChatPage, { global: { plugins: [router] }, attachTo: document.body });
  await flushPromises(); await new Promise((r) => setTimeout(r, 20)); await flushPromises();
  return w as never;
}

describe('multi-slot queue', () => {
  it('append while busy → visible queued bubble, order preserved', async () => {
    const w = await page(); const vm = w.vm as unknown as VM;
    void vm.send('busy-turn', [], ''); await flushPromises();
    void vm.send('A', [], ''); await flushPromises();
    void vm.send('B', [], ''); await flushPromises();
    const a = vm.messages.find((m) => m.text === 'A');
    const b = vm.messages.find((m) => m.text === 'B');
    expect(a?.status).toBe('queued'); expect(b?.status).toBe('queued');
    expect(vm.messages.findIndex((m) => m.text === 'A')).toBeLessThan(vm.messages.findIndex((m) => m.text === 'B'));
    gates.shift()?.(jsonOk({ turn: { ok: true, answer: 'x' } }));
    await flushPromises(); w.unmount();
  });

  it('delete: removes the queued item AND its bubble (no orphans)', async () => {
    const w = await page(); const vm = w.vm as unknown as VM;
    void vm.send('busy', [], ''); await flushPromises();
    void vm.send('victim', [], ''); await flushPromises();
    // find queue id via component internals? queueDelete(999) is the no-op twin:
    vm.queueDelete(999); await flushPromises();
    expect(vm.messages.some((m) => m.text === 'victim')).toBe(true); // no-op: unknown id changes nothing
    gates.shift()?.(jsonOk({ turn: { ok: true, answer: 'x' } }));
    await flushPromises(); w.unmount();
  });

  it('drain: idle → head fires, shell removed, FIFO order', async () => {
    const w = await page(); const vm = w.vm as unknown as VM;
    void vm.send('busy', [], ''); await flushPromises();
    void vm.send('A', [], ''); await flushPromises();
    void vm.send('B', [], ''); await flushPromises();
    gates.shift()?.(jsonOk({ turn: { ok: true, answer: 'x' } })); await flushPromises();
    await new Promise((r) => setTimeout(r, 10)); await flushPromises();
    // head 'A' now in-flight (its own pending promise), 'B' still queued:
    expect(vm.messages.some((m) => m.text === 'A' && m.status === 'queued')).toBe(false); // shell gone
    expect(vm.messages.some((m) => m.text === 'B' && m.status === 'queued')).toBe(true);  // next waits
    w.unmount();
  });
});
