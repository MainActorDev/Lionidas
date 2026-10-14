/** Regression locks for the composer incidents (plan Stage D):
 *  caret-metric (7460b81/9da58a8 — chips width-neutral, caret at text end)
 *  chip-layers (def429f/4e93e03 — single painter, selection transparent, no mirror) */

import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import Composer from '../components/Composer.vue';

vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve({ json: () => Promise.resolve(
    String(url).includes('/refs/search')
      ? { rows: [{ id: 'case:c2', kind: 'case', title: 'tracking_milestone_labels', meta: 'draft', ref: { kind: 'case', locator: 'c2' } }] }
      : { issues: [] }) })));

async function withChip(): Promise<{ w: ReturnType<typeof mount>; el: HTMLTextAreaElement }> {
  const w = mount(Composer, { attachTo: document.body });
  const ta = w.find('textarea');
  await ta.setValue('@milestone');
  await new Promise((r) => setTimeout(r, 260));
  await flushPromises();
  const row = w.findAll('.slash-row:not(.state)').find((r) => r.text().includes('tracking_milestone_labels'))
    ?? w.findAll('.slash-row:not(.state)')[0];
  await row!.trigger('mousedown');
  await flushPromises();
  return { w, el: ta.element as HTMLTextAreaElement };
}

describe('regression: caret-metric (7460b81, 9da58a8)', () => {
  it('chips are WIDTH-NEUTRAL — compiled rules give chips zero padding/margin/border', async () => {
    const { w } = await withChip();
    const chipEl = document.querySelector('.chip.inline:not(.querying)') as HTMLElement | null;
    expect(chipEl).toBeTruthy(); // a picked chip rendered
    // lock the SOURCE rules (SFC style block is the truth; happy-dom won't cascade scoped CSS):
    const src = (await import('../components/Composer.vue?raw')).default as string;
    const styleBlock = src.slice(src.lastIndexOf('<style'));
    const chipRule = /\.chip\.inline\s*\{[^}]*/.exec(styleBlock)?.[0] ?? '';
    expect(chipRule).toMatch(/padding:\s*0(?![.\d])/); // zero padding (the 10px bug can't return)
    expect(chipRule).toMatch(/margin:\s*0(?![.\d])/);  // zero margin
    expect(chipRule).not.toMatch(/border(-top|-right|-bottom|-left)?(-width)?\s*:\s*(?!none|0)[\d.]+(px|em|rem)/); // no border WIDTHS — rings are box-shadows
    w.unmount();
  });

  it('caret sits exactly at text end after a pick (no minus-one-letter drift)', async () => {
    const { w, el } = await withChip();
    expect(el.selectionStart).toBe(el.value.length); // caret = end of 'label '
    expect(el.value).not.toContain('\u200B');          // sentinels forbidden (MR1)
    w.unmount();
  });
});

describe('regression: chip-layers (def429f, 4e93e03)', () => {
  it('single painter: textarea text transparent; overlay BELOW textarea; selection text transparent', async () => {
    const { w } = await withChip();
    // layer contract locked at the SOURCE level (SFC style block is the truth):
    const src2 = (await import('../components/Composer.vue?raw')).default as string;
    const styleBlock2 = src2.slice(src2.lastIndexOf('<style'));
    const taRule = /\.ta-wrap textarea\s*\{[^}]*/.exec(styleBlock2)?.[0] ?? '';
    const ovRule = /\.ta-overlay\s*\{[^}]*/.exec(styleBlock2)?.[0] ?? '';
    expect(taRule).toMatch(/color:\s*transparent/);                    // native text invisible (single painter)
    expect(parseInt(/z-index:\s*(\d+)/.exec(ovRule)?.[1] ?? '0', 10)).toBeLessThan(parseInt(/z-index:\s*(\d+)/.exec(taRule)?.[1] ?? '0', 10)); // overlay BELOW → caret paints over chips
    expect(styleBlock2).toMatch(/::selection\s*\{[^}]*color:\s*transparent/); // no forced-contrast mirror
    w.unmount();
  });
});
