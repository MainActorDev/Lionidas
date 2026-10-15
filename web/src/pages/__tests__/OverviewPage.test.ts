/** OverviewPage tests (041-A band verdict): band render, coverage strip,
 *  latest-runs 5-row cap, attention navigation, plan chips. Structural
 *  assertions only — no exact ago-strings (they rot with the clock). */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createRouter, createMemoryHistory } from 'vue-router';
import OverviewPage from '../OverviewPage.vue';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

/* stub the live-events store: connect/release/watch no-ops */
vi.mock('../../stores/live.ts', () => ({
  useLiveEvents: () => ({ connect: () => {}, release: () => {}, events: [] as unknown[] }),
}));

const NOW = Date.now();
const OVERVIEW = {
  health: { status: 'failed', passed: 18, failed: 2, blocked: 1, running: 3, passRate: 0.86, delta: 0.04, previousBatch: 'b-7741', buildLabel: '382', lastRunAt: NOW - 7_200_000, lastSuccessfulAt: NOW - 93_600_000 },
  attention: [
    { kind: 'new_failure', templateId: 'checkout-flow', runId: 'r-2', variantId: null, status: 'failed', appVersion: '382', batchId: 'b-7741', templateName: 'checkout-flow' },
    { kind: 'infra_blocked', templateId: 'login-flow', runId: 'r-7', variantId: null, status: 'failed', appVersion: '382', batchId: 'b-7741', templateName: 'login-flow' },
  ],
  coverage: { active: 28, draft: 2, deprecated: 1, variants: 6, executedInRange: 24, notRunRecently: 4 },
  latestRuns: Array.from({ length: 7 }, (_, i) => ({
    runId: `r-${i + 1}`, templateId: `case-${i}`, status: i === 1 ? 'failed' : 'passed', blocked: 0,
    appVersion: '382', variantId: i % 2 === 0 ? null : 'en-US', batchId: 'b-7741',
    startedAt: NOW - (i + 1) * 3_600_000, finishedAt: NOW - (i + 1) * 3_600_000 + 60_000, templateName: `case-${i}`,
  })),
};
const PLANS = { plans: [{ id: 'p1', name: 'smoke' }, { id: 'p2', name: 'regression' }] };

async function page() {
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/', name: 'overview', component: OverviewPage },
    { path: '/runs/:id', component: { template: '<div/>' } },
    { path: '/templates', component: { template: '<div/>' } },
    { path: '/devices', component: { template: '<div/>' } },
  ] });
  router.push('/');
  await router.isReady();
  const w = mount(OverviewPage, { global: { plugins: [router] } });
  await flushPromises();
  return { w, router };
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string) => {
    if (String(url).startsWith('/api/plans')) return Promise.resolve({ ok: true, json: async () => PLANS } as unknown as Response);
    return Promise.resolve({ ok: true, json: async () => OVERVIEW } as unknown as Response);
  });
});

describe('OverviewPage (041-A band verdict)', () => {
  it('renders the verdict band: word + dot + sub-line bits + attention stamp', async () => {
    const { w } = await page();
    expect(w.find('.ov-band').exists()).toBe(true);
    expect(w.find('.ov-overall').text()).toContain('failed');
    expect(w.find('.ov-dot').classes()).toContain('failed');
    const sub = w.find('.ov-summary').text();
    expect(sub).toContain('pass rate 86%');
    expect(sub).toContain('vs b-7741');
    expect(w.find('.ov-stamp').text()).toContain('2 attention');
    w.unmount();
  });

  it('renders 6 coverage cells with alert classes on failed / not-run', async () => {
    const { w } = await page();
    const segs = w.findAll('.ov-strip .seg');
    expect(segs.length).toBe(6);
    expect(segs[1]!.classes()).toContain('alert'); // failed > 0
    expect(segs[5]!.classes()).toContain('alert'); // notRunRecently > 0
    expect(segs[0]!.classes()).not.toContain('alert');
    w.unmount();
  });

  it('caps latest runs at 5 rows even when the payload ships more', async () => {
    const { w } = await page();
    const rows = w.findAll('.ov-run-row');
    expect(rows.length).toBe(5);
    expect(rows[0]!.text()).toContain('case-0');
    expect(rows[4]!.text()).toContain('case-4'); // 5th row; case-5/6 cut
    w.unmount();
  });

  it('attention rows navigate to the run detail', async () => {
    const { w, router } = await page();
    const push = vi.spyOn(router, 'push');
    await w.findAll('.ov-att-row')[0]!.trigger('click');
    await flushPromises();
    expect(push).toHaveBeenCalledWith('/runs/r-2');
    w.unmount();
  });

  it('plan chips render and run fires the plan endpoint', async () => {
    const { w } = await page();
    const chips = w.findAll('.ov-plans .chip-click, .ov-plans button');
    expect(chips.length).toBe(2);
    await chips[0]!.trigger('click');
    await flushPromises();
    const called = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/plans/p1/run'));
    expect(called).toBeTruthy();
    w.unmount();
  });

  it('empty attention renders the quiet state and hides the stamp', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).startsWith('/api/plans')) return Promise.resolve({ ok: true, json: async () => ({ plans: [] }) } as unknown as Response);
      return Promise.resolve({ ok: true, json: async () => ({ ...OVERVIEW, attention: [] }) } as unknown as Response);
    });
    const { w } = await page();
    expect(w.find('.ov-none').text()).toContain('nothing needs eyes');
    expect(w.find('.ov-stamp').exists()).toBe(false);
    w.unmount();
  });
});
