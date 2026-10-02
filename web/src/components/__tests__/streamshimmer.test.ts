import { describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import StreamShimmer from '../cockpit/StreamShimmer.vue';

/** Variant B (aurora veil) — reactive contract:
 *  - visible ONLY while connecting/reconnecting (no caption — motion is the message)
 *  - veils wander on long multi-waypoint loops
 *  --ramp ramps 0% → 100% over ~1.5s (ease-out), resets on hide/show */

vi.useFakeTimers();

describe('StreamShimmer (variant B)', () => {
  it('renders only for connecting/reconnecting, hidden otherwise', async () => {
    const w = mount(StreamShimmer, { props: { state: 'live' } });
    expect(w.find('.shimmer').exists()).toBe(false);

    await w.setProps({ state: 'connecting' });
    expect(w.find('.shimmer').exists()).toBe(true);

    await w.setProps({ state: 'reconnecting' });
    expect(w.find('.shimmer').exists()).toBe(true);
    expect(w.find('.curtain').exists()).toBe(true);

    await w.setProps({ state: 'failed' });
    expect(w.find('.shimmer').exists()).toBe(false);
  });

  it('ramps --ramp 0→100% over 1.5s and resets on re-show', async () => {
    const w = mount(StreamShimmer, { props: { state: 'connecting' } });
    expect(w.find('.shimmer').attributes('style')).toContain('--ramp: 0%');

    vi.advanceTimersByTime(750);
    await flushPromises();
    const mid = Number(w.find('.shimmer').attributes('style')?.match(/--ramp: (\d+)%/)?.[1] ?? 0);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(100);

    vi.advanceTimersByTime(800);
    await flushPromises();
    expect(w.find('.shimmer').attributes('style')).toContain('--ramp: 100%');

    // hide → show: ramp restarts at 0
    await w.setProps({ state: 'live' });
    await w.setProps({ state: 'connecting' });
    expect(w.find('.shimmer').attributes('style')).toContain('--ramp: 0%');
  });

  it('freezes the ramp when hidden (no further progress)', async () => {
    const w = mount(StreamShimmer, { props: { state: 'connecting' } });
    vi.advanceTimersByTime(400);
    await flushPromises();
    const mid = Number(w.find('.shimmer').attributes('style')?.match(/--ramp: (\d+)%/)?.[1] ?? 0);
    expect(mid).toBeGreaterThan(0);
    await w.setProps({ state: 'live' });
    vi.advanceTimersByTime(5000);
    await flushPromises();
    // hidden: no element; on re-show the ramp RESTARTS from 0 (timer was cleared)
    await w.setProps({ state: 'connecting' });
    expect(w.find('.shimmer').attributes('style')).toContain('--ramp: 0%');
    w.unmount();
  });
});
