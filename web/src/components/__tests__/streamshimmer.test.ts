import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import StreamShimmer from '../cockpit/StreamShimmer.vue';

/** EXACT port of the operator's aurora reference — the only contract is
 *  visibility (connecting/reconnecting) and the reference's structure:
 *  3 bands + the glow ::after. No ramp, no caption, no extras. */

describe('StreamShimmer (exact reference port)', () => {
  it('renders only for connecting/reconnecting', async () => {
    const w = mount(StreamShimmer, { props: { state: 'live' } });
    expect(w.find('.aurora').exists()).toBe(false);

    await w.setProps({ state: 'connecting' });
    expect(w.find('.aurora').exists()).toBe(true);

    await w.setProps({ state: 'reconnecting' });
    expect(w.find('.aurora').exists()).toBe(true);

    await w.setProps({ state: 'failed' });
    expect(w.find('.aurora').exists()).toBe(false);
    await w.setProps({ state: 'idle' });
    expect(w.find('.aurora').exists()).toBe(false);
  });

  it('carries the reference structure: 3 bands, no extras', () => {
    const w = mount(StreamShimmer, { props: { state: 'connecting' } });
    expect(w.findAll('.aurora__band')).toHaveLength(3);
    // no leftover additions from earlier iterations
    expect(w.find('.shimmer').attributes('style')).toBeUndefined();
    expect(w.find('.status, .caption, .veil, .rib').exists()).toBe(false);
  });
});
