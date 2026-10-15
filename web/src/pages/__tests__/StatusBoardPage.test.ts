/** StatusBoardPage render tests: Factory board (sketch 038-C), tiles,
 *  severity-first selection, cached age, poll lifecycle, error honesty. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createRouter, createMemoryHistory } from 'vue-router';
import StatusBoardPage from '../StatusBoardPage.vue';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const PAYLOAD = {
  checkedAt: Date.now(),
  cached: false,
  systems: [
    { id: 'server', name: 'server', state: 'ok', summary: 'up 4h · v0.1.0', signal: 'both databases readable', rule: 'DB read fails → down', detail: { uptime: '4h' } },
    { id: 'agent-core', name: 'agent core', state: 'degraded', summary: '1 live turn', signal: 'zombie 22m · outbox 2', rule: 'zombie idle >15m · outbox backlog >0', detail: { 'zombie candidates': 't_x (idle 22m)', 'outbox backlog': '2 effects', zero: 0, flag: false, empty: null } },
    { id: 'data-freshness', name: 'data freshness', state: 'unknown', summary: 'run 2d ago', signal: 'all checks within thresholds', rule: 'run 7d · ingest 7d · diag 14d', detail: {} },
  ],
};

function routerPush() {
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/status', name: 'status', component: StatusBoardPage },
    { path: '/', component: { template: '<div/>' } },
  ] });
  router.push('/status');
  return router.isReady();
}

async function page() {
  const routerReady = routerPush();
  const w = mount(StatusBoardPage, { global: { plugins: [] } });
  await routerReady;
  await flushPromises();
  await vi.advanceTimersByTimeAsync(10); // let the settled-timeout tick under fake timers
  await flushPromises();
  return w;
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => PAYLOAD } as unknown as Response);
  vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); });

describe('StatusBoardPage (Factory board 038-C)', () => {
  it('renders one tile per system with name, state, summary, signal', async () => {
    const w = await page();
    const tiles = w.findAll('.tile');
    expect(tiles.length).toBe(3);
    expect(tiles[1]!.text()).toContain('agent core');
    expect(tiles[1]!.text()).toContain('zombie 22m · outbox 2');
    expect(tiles[1]!.attributes('aria-pressed')).toBe('true');
    w.unmount();
  });

  it('selects the degraded system first, not the first card', async () => {
    const w = await page();
    expect(w.find('.detail-head h3').text()).toBe('agent core');
    w.unmount();
  });

  it('overall = degraded when any card is degraded; attention count shown', async () => {
    const w = await page();
    expect(w.find('.overall').text()).toContain('degraded');
    expect(w.find('.summary').text()).toContain('1 system needs attention');
    w.unmount();
  });

  it('detail shows full kv pairs (0/false/null preserved), rule below', async () => {
    const w = await page();
    const text = w.find('.detail').text();
    expect(text).toContain('zombie candidates');
    expect(text).toContain('2 effects');
    expect(text).toContain('0');
    expect(text).toContain('false');
    expect(text).toContain('—'); // null → em dash
    expect(w.find('.rule').text()).toContain('zombie idle >15m');
    w.unmount();
  });

  it('cached payload labels the stamp', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ...PAYLOAD, cached: true }) } as unknown as Response);
    const w = await page();
    expect(w.find('.stamp').text()).toContain('cached');
    w.unmount();
  });

  it('403 clears prior data and shows operator-only message', async () => {
    const w = await page();
    fetchMock.mockResolvedValue({ ok: false, status: 403 } as unknown as Response);
    await vi.advanceTimersByTimeAsync(15_000);
    await flushPromises();
    expect(w.find('.err').text()).toBe('operator only');
    expect(w.find('.tile').exists()).toBe(false);
    w.unmount();
  });

  it('network failure after success keeps data but marks it stale with an alert', async () => {
    const w = await page();
    fetchMock.mockRejectedValue(new Error('net down'));
    await vi.advanceTimersByTimeAsync(15_000);
    await flushPromises();
    expect(w.find('[role="alert"]').exists()).toBe(true);
    expect(w.find('.tile').exists()).toBe(true); // last known data retained
    w.unmount();
  });

  it('polls only while visible; reloads immediately on tab return', async () => {
    const w = await page();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // hidden tab: no poll
    let visible = false;
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => (visible ? 'visible' : 'hidden'));
    visible = false;
    await vi.advanceTimersByTimeAsync(30_000);
    const hiddenCount = fetchMock.mock.calls.length;
    expect(hiddenCount).toBe(2);
    // returning visible fires an immediate reload
    visible = true;
    document.dispatchEvent(new Event('visibilitychange'));
    await flushPromises();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(hiddenCount);
    w.unmount();
  });

  it('a late older response cannot overwrite a newer one', async () => {
    let resolveOld!: (v: Response) => void;
    fetchMock.mockReset();
    fetchMock.mockImplementationOnce(() => new Promise<Response>((res) => { resolveOld = res; }));
    fetchMock.mockImplementationOnce(async () => ({ ok: true, status: 200, json: async () => PAYLOAD } as unknown as Response));
    const w = await page(); // request 1 pending
    await vi.advanceTimersByTimeAsync(15_000); // request 2 fires, resolves
    await flushPromises();
    resolveOld({ ok: true, status: 200, json: async () => ({ ...PAYLOAD, systems: PAYLOAD.systems.slice(0, 1) }) } as unknown as Response);
    await flushPromises();
    expect(w.findAll('.tile').length).toBe(3); // newer 3-tile payload survived
    w.unmount();
  });

  it('selected id disappearing on refresh falls back by severity', async () => {
    const w = await page();
    expect(w.find('.detail-head h3').text()).toBe('agent core');
    fetchMock.mockImplementationOnce(async () => ({
      ok: true, status: 200,
      json: async () => ({
        ...PAYLOAD,
        systems: [
          { id: 'server', name: 'server', state: 'ok', summary: 'up', signal: 'ok', rule: 'r', detail: {} },
          { id: 'engine', name: 'engine', state: 'degraded', summary: 'orphan', signal: '1 orphan session', rule: 'r', detail: {} },
        ],
      }),
    } as unknown as Response));
    await vi.advanceTimersByTimeAsync(15_000);
    await flushPromises();
    expect(w.find('.detail-head h3').text()).toBe('engine');
    expect(w.findAll('.tile')[1]!.attributes('aria-pressed')).toBe('true');
    w.unmount();
  });

  it('empty systems array renders an honest neutral state', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ checkedAt: Date.now(), cached: false, systems: [] }) } as unknown as Response);
    const w = await page();
    expect(w.find('.tile').exists()).toBe(false);
    expect(w.find('.empty').text()).toContain('no subsystems reported');
    w.unmount();
  });

  it('selection survives a poll that keeps the id', async () => {
    const w = await page();
    await w.findAll('.tile')[0]!.trigger('click');
    expect(w.find('.detail-head h3').text()).toBe('server');
    fetchMock.mockImplementationOnce(async () => ({ ok: true, status: 200, json: async () => ({ ...PAYLOAD, checkedAt: Date.now() }) } as unknown as Response));
    await vi.advanceTimersByTimeAsync(15_000);
    await flushPromises();
    expect(w.find('.detail-head h3').text()).toBe('server');
    w.unmount();
  });
});
