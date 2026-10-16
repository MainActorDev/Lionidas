/** AgentTimelinePage (v2 shell) tests — Phase 5 step 4 slice 2.
 *  Mocked fetch/WS-free: projection load, snapshot REPLACE semantics (the
 *  coalescer contract), queue gating on live, send → reload. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createRouter, createMemoryHistory } from 'vue-router';

const fetchMock = vi.fn();
window.fetch = fetchMock as unknown as typeof fetch;

import AgentTimelinePage from '../AgentTimelinePage.vue';
import type { TurnItem } from '../components/timelineTypes';

const item = (over: Record<string, unknown> & { id: string; kind: string }): TurnItem =>
  ({ sessionId: 'sess_1', turnId: 't1', ordinal: 1, status: 'completed', startedAt: 0, completedAt: 0, ...over } as TurnItem);

function timelineBody(items: TurnItem[], liveTurn?: { turnId: string; startedAt: number }): string {
  return JSON.stringify({ items, ...(liveTurn ? { liveTurn } : {}) });
}

function meBody(ok = true): string {
  return ok ? JSON.stringify({ user: { id: 'u1', name: 'op', email: 'op@x', role: 'operator' } }) : JSON.stringify({});
}

function stub(): void {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => {
    const u = String(url);
    if (u === '/api/auth/me') return { ok: true, json: async () => JSON.parse(meBody()) } as Response;
    if (u === '/api/agent/models/health' || u === '/api/agent/models') return { ok: false, json: async () => ({}) } as Response;
    if (u.endsWith('/timeline')) return { ok: true, json: async () => JSON.parse(timelineBody([item({ id: 'm1', kind: 'message', role: 'user', streaming: false, text: 'hello' })])) } as Response;
    return { ok: true, json: async () => ({}) } as Response;
  });
}

const mountPage = async (): Promise<ReturnType<typeof mount>> => {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/agent-v2', component: AgentTimelinePage }] });
  const w = mount(AgentTimelinePage, { global: { plugins: [router] } });
  await flushPromises();
  return w;
};

describe('AgentTimelinePage (v2)', () => {
  beforeEach(() => { stub(); localStorage.clear(); });

  it('loads the projection for the restored session and renders items', async () => {
    localStorage.setItem('agent.lastSession', 'sess_1');
    const w = await mountPage();
    expect(w.text()).toContain('hello');
    expect(w.find('[role="log"]').exists()).toBe(true);
  });

  it('liveTurn from the server shows the live pill', async () => {
    localStorage.setItem('agent.lastSession', 'sess_1');
    fetchMock.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u === '/api/auth/me') return { ok: true, json: async () => JSON.parse(meBody()) } as Response;
      if (u.endsWith('/timeline')) return { ok: true, json: async () => JSON.parse(timelineBody([item({ id: 'm1', kind: 'message', role: 'user', streaming: false, text: 'hi' })], { turnId: 't9', startedAt: Date.now() })) } as Response;
      return { ok: false, json: async () => ({}) } as Response;
    });
    const w = await mountPage();
    expect(w.find('.pill.live').exists()).toBe(true);
  });

  it('snapshot REPLACE: existing message text is replaced, not appended', async () => {
    localStorage.setItem('agent.lastSession', 'sess_1');
    const w = await mountPage();
    // find the component instance and drive applySnapshot directly (WS-free)
    const vm = w.vm as unknown as { applySnapshot(id: string, text: string, done: boolean): void };
    vm.applySnapshot('m1', 'replaced text', false);
    await flushPromises();
    expect(w.text()).toContain('replaced text');
    expect(w.text()).not.toContain('hello');
  });

  it('snapshot first-sighting creates a streaming assistant message', async () => {
    localStorage.setItem('agent.lastSession', 'sess_1');
    const w = await mountPage();
    const vm = w.vm as unknown as { applySnapshot(id: string, text: string, done: boolean): void };
    vm.applySnapshot('msg-a-t77', 'streaming…', false);
    await flushPromises();
    expect(w.find('.cursor').exists()).toBe(true);
    expect(w.text()).toContain('streaming…');
  });

  it('send during a live turn queues visibly (nothing displaced)', async () => {
    localStorage.setItem('agent.lastSession', 'sess_1');
    const w = await mountPage();
    const vm = w.vm as unknown as { live: boolean; send(t: string, r: [], a: string, c: string[]): Promise<void> };
    // force live via liveTurn state
    (w.vm as unknown as { liveTurn: { turnId: string; startedAt: number } | null }).liveTurn = { turnId: 't9', startedAt: Date.now() };
    await vm.send('queued ask', [], '', []);
    await flushPromises();
    expect(w.find('.queue').exists()).toBe(true);
    expect(w.text()).toContain('queued ask');
  });

  it('send when idle POSTs then reloads the projection (no local bubble math)', async () => {
    localStorage.setItem('agent.lastSession', 'sess_1');
    let posted = '';
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u === '/api/auth/me') return { ok: true, json: async () => JSON.parse(meBody()) } as Response;
      if (u.endsWith('/messages') && init?.method === 'POST') { posted = String(init.body); return { ok: true, json: async () => ({ turn: { ok: true } }) } as Response; }
      if (u.endsWith('/timeline')) return { ok: true, json: async () => JSON.parse(timelineBody([item({ id: 'm1', kind: 'message', role: 'user', streaming: false, text: 'hello' }), item({ id: 'm2', kind: 'message', role: 'assistant', streaming: false, text: 'the answer' })])) } as Response;
      return { ok: false, json: async () => ({}) } as Response;
    });
    const w = await mountPage();
    const vm = w.vm as unknown as { send(t: string, r: [], a: string, c: string[]): Promise<void> };
    await vm.send('fresh ask', [], '', []);
    await flushPromises();
    expect(posted).toContain('fresh ask');
    // timeline reloaded at least twice (mount + post-send)
    const tlCalls = fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/timeline')).length;
    expect(tlCalls).toBeGreaterThanOrEqual(2);
  });
});
