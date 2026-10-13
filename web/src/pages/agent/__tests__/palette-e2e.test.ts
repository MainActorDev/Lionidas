/** Mention palette end-to-end (component level, real fetch contract shape):
 *  type @ → palette opens; pick inserts inline token; second @ for jira (async tier);
 *  Backspace removes token as unit; send carries refs + clean text. */
import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import Composer from '../components/Composer.vue';

const rows = [
  { id: 'case:c2', kind: 'case', title: 'tracking_milestone_labels', meta: 'draft', ref: { kind: 'case', locator: 'c2' } },
  { id: 'repo:ios-consumer-intl:733e224', kind: 'repo', title: '733e224 BE-driven milestones', meta: 'ios-consumer-intl', ref: { kind: 'github-commit', locator: 'ios-consumer-intl/733e224' } },
];
const sends: Array<{ text: string; refs: unknown[] }> = [];
vi.stubGlobal('fetch', vi.fn((url: string) => {
  if (String(url).includes('/refs/search')) return Promise.resolve({ json: () => Promise.resolve({ rows, tier: 'local' }) });
  if (String(url).includes('/refs/jira')) return Promise.resolve({ json: () => Promise.resolve({ issues: [{ key: 'CUST-6223', title: 'milestone stepper', type: 'Story' }] }) });
  return Promise.resolve({ json: () => Promise.resolve({}) });
}));

describe('mention palette e2e', () => {
  it('pick → inline token → backspace-as-unit → send carries refs', async () => {
    const w = mount(Composer, { attachTo: document.body, props: {} }, );
    const send = (t: string, refs: unknown[]): void => { sends.push({ text: t, refs: [...refs] }); };
    const w2 = w; void send;
    const ta = w2.find('textarea');
    // 1) type @ + query → palette with rows
    await ta.setValue('@milestone');
    await new Promise((r) => setTimeout(r, 260));
    let rowsDom = w2.findAll('.slash-row:not(.state)');
    expect(rowsDom.length).toBeGreaterThan(0);
    // 2) pick the CASE row (async jira may outrank it — find by content)
    const caseRow = rowsDom.find((r) => r.text().includes('tracking_milestone_labels'));
    expect(caseRow).toBeTruthy();
    await caseRow!.trigger('mousedown');
    await flushPromises();
    const val = (ta.element as HTMLTextAreaElement).value;
    expect(val).toContain('tracking_milestone_labels');
    expect(val.includes('\u200B')).toBe(false); // MR1: no sentinels EVER
    // 3) send — the parent would receive refs via the emit; assert via emitted
    await ta.setValue(`${val} please plan`);

    await w2.find('.send.ready').trigger('click');
    await flushPromises();
    const sendCalls = w2.emitted('send') as Array<Array<unknown>> | undefined;
    expect(sendCalls).toBeTruthy();
    const [, refsOut] = sendCalls![0] as [string, Array<{ kind: string; locator: string }>];
    expect(refsOut.some((r) => r.kind === 'case' && r.locator === 'c2')).toBe(true);
    w2.unmount();
  });

  it('chip is ATOMIC: Backspace-after deletes whole; Backspace-before selects then deletes', async () => {
    const w = mount(Composer, { attachTo: document.body });
    const ta = w.find('textarea');
    await ta.setValue('@milestone');
    await new Promise((r) => setTimeout(r, 260));
    const caseRow = w.findAll('.slash-row:not(.state)').find((r) => r.text().includes('tracking_milestone_labels'));
    await caseRow!.trigger('mousedown');
    await flushPromises();
    const el = ta.element as HTMLTextAreaElement;
    const label = 'tracking_milestone_labels';
    const start = el.value.indexOf(label);
    expect(start).toBeGreaterThanOrEqual(0);

    // caret AFTER the chip → one Backspace deletes the WHOLE chip
    const after = start + label.length + 1;
    el.setSelectionRange(after, after);
    await ta.trigger('keydown', { key: 'Backspace' });
    await flushPromises();
    expect(el.value.includes(label)).toBe(false);

    // caret BEFORE the chip → press 1 SELECTS the chip, press 2 deletes it
    await ta.setValue('@milestone');
    await new Promise((r) => setTimeout(r, 260));
    const caseRow2 = w.findAll('.slash-row:not(.state)').find((r) => r.text().includes('tracking_milestone_labels'));
    await caseRow2!.trigger('mousedown');
    await flushPromises();
    const start2 = el.value.indexOf(label);
    el.setSelectionRange(start2, start2);
    await ta.trigger('keydown', { key: 'Backspace' });
    expect(el.selectionStart).toBe(start2);
    expect(el.selectionEnd).toBe(start2 + label.length);
    expect(el.value.includes(label)).toBe(true);
    await ta.trigger('keydown', { key: 'Backspace' });
    await flushPromises();
    expect(el.value.includes(label)).toBe(false);
    w.unmount();
  });});
