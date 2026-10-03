import { describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import StreamShimmer from '../cockpit/StreamShimmer.vue';

/** EXACT port of the operator's aurora reference — the only contract is
 *  visibility (connecting/reconnecting) and the reference's structure:
 *  3 bands + the glow ::after. No ramp, no caption, no extras.
 *  Crossfade contract (2026-10-03): on live the shimmer does NOT cut — it
 *  stays mounted with .out (250ms fade, pointer-events none) so the first
 *  stream frames paint under it; unmount lands after the fade. */

describe('StreamShimmer (exact reference port)', () => {
  it('renders only for connecting/reconnecting (live crossfades out)', async () => {
    vi.useFakeTimers();
    const w = mount(StreamShimmer, { props: { state: 'failed' } });
    expect(w.find('.aurora').exists()).toBe(false);

    await w.setProps({ state: 'connecting' });
    expect(w.find('.aurora').exists()).toBe(true);

    await w.setProps({ state: 'reconnecting' });
    expect(w.find('.aurora').exists()).toBe(true);

    // live: NOT gone — fading (.out), gone only after the 250ms fade
    await w.setProps({ state: 'live' });
    expect(w.find('.aurora').exists()).toBe(true);
    expect(w.find('.shimmer').classes()).toContain('out');
    vi.advanceTimersByTime(300);
    await nextTick();
    expect(w.find('.aurora').exists()).toBe(false);

    await w.setProps({ state: 'idle' });
    expect(w.find('.aurora').exists()).toBe(false);
    vi.useRealTimers();
  });

  it('carries the reference structure: 3 bands, no extras', () => {
    const w = mount(StreamShimmer, { props: { state: 'connecting' } });
    expect(w.findAll('.aurora__band')).toHaveLength(3);
    // no leftover additions from earlier iterations
    expect(w.find('.shimmer').attributes('style')).toBeUndefined();
    expect(w.find('.status, .caption, .veil, .rib').exists()).toBe(false);
  });
});
