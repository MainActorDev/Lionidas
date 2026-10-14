/** StatusPage render tests: master-detail variant C, state dots, cached badge. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createRouter, createMemoryHistory } from 'vue-router';
import StatusPage from '../StatusPage.vue';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const PAYLOAD = {
  checkedAt: Date.now(),
  cached: false,
  systems: [
    { id: 'server', name: 'server', state: 'ok', summary: 'up 4h · v0.1.0', detail: { uptime: '4h' } },
    { id: 'agent-core', name: 'agent core', state: 'degraded', summary: '1 live turn · 24h: 41 ✓ / 3 ✕', detail: { 'zombie candidates': 't_x (idle 22m)' } },
    { id: 'data-freshness', name: 'data freshness', state: 'unknown', summary: 'run 2d ago', detail: {} },
  ],
};

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, json: async () => PAYLOAD } as unknown as Response);
});

async function page() {
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/status', name: 'status', component: StatusPage },
    { path: '/', component: { template: '<div/>' } },
  ] });
  router.push('/status');
  await router.isReady();
  const w = mount(StatusPage, { global: { plugins: [router] }, attachTo: document.body });
  await flushPromises();
  await new Promise((r) => setTimeout(r, 10));
  return w;
}

describe('StatusPage (variant C master-detail)', () => {
  it('renders the subsystem list with state dots + right-edge counts', async () => {
    const w = await page();
    const items = w.findAll('.item');
    expect(items.length).toBe(3);
    expect(items[1]!.text()).toContain('agent core');
    expect(items[1]!.text()).toContain('1 live turn');
    w.unmount();
  });

  it('overall = degraded when any card is degraded', async () => {
    const w = await page();
    expect(w.find('.overall').text()).toContain('degraded');
    w.unmount();
  });

  it('detail pane shows selected card kv + thresholds footer (PR4)', async () => {
    const w = await page();
    // select the degraded card
    await w.findAll('.item')[1]!.trigger('click');
    await flushPromises();
    expect(w.find('.detail').text()).toContain('zombie candidates');
    expect(w.find('.thr').text()).toContain('zombie 15m');
    expect(w.find('.thr').text()).toContain('run 7d');
    w.unmount();
  });

  it('cached badge renders when payload cached', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ...PAYLOAD, cached: true }) } as unknown as Response);
    const w = await page();
    expect(w.find('.meta').text()).toContain('cached');
    w.unmount();
  });
});
