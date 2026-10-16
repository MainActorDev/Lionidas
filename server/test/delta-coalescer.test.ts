/** DeltaCoalescer tests — Phase 5 step 3 (fake timers for interval math). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeltaCoalescer, type CoalescedSnapshot } from '../src/agent/deltaCoalescer.ts';

describe('DeltaCoalescer', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('buffers deltas and flushes ONE coalesced snapshot per interval', () => {
    const out: CoalescedSnapshot[] = [];
    const c = new DeltaCoalescer((s) => out.push(s), { intervalMs: 80 });
    c.push('s1', 't1', 'i1', 'Hello ');
    c.push('s1', 't1', 'i1', 'wor');
    c.push('s1', 't1', 'i1', 'ld');
    expect(out).toHaveLength(0); // nothing before the interval fires
    vi.advanceTimersByTime(80);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ sessionId: 's1', turnId: 't1', itemId: 'i1', text: 'Hello world', done: false });
  });

  it('second interval flushes the grown text (full snapshot, not delta)', () => {
    const out: CoalescedSnapshot[] = [];
    const c = new DeltaCoalescer((s) => out.push(s), { intervalMs: 80 });
    c.push('s1', 't1', 'i1', 'A');
    vi.advanceTimersByTime(80);
    c.push('s1', 't1', 'i1', 'B');
    vi.advanceTimersByTime(80);
    expect(out.map((s) => s.text)).toEqual(['A', 'AB']);
  });

  it('separate items get separate buffers/timers', () => {
    const out: CoalescedSnapshot[] = [];
    const c = new DeltaCoalescer((s) => out.push(s), { intervalMs: 80 });
    c.push('s1', 't1', 'i1', 'one');
    c.push('s1', 't1', 'i2', 'two');
    vi.advanceTimersByTime(80);
    const texts = out.map((s) => s.text).sort();
    expect(texts).toEqual(['one', 'two']);
  });

  it('complete() flushes immediately with final text and done:true', () => {
    const out: CoalescedSnapshot[] = [];
    const c = new DeltaCoalescer((s) => out.push(s), { intervalMs: 80 });
    c.push('s1', 't1', 'i1', 'streamed but authoritative ');
    c.complete('s1', 't1', 'i1', 'streamed but authoritative FINAL');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ text: 'streamed but authoritative FINAL', done: true });
    // buffer retired: no further flush for this item
    vi.advanceTimersByTime(240);
    expect(out).toHaveLength(1);
  });

  it('flushTurn() drains all buffers for the turn with done:true', () => {
    const out: CoalescedSnapshot[] = [];
    const c = new DeltaCoalescer((s) => out.push(s), { intervalMs: 80 });
    c.push('s1', 't1', 'i1', 'x');
    c.push('s1', 't1', 'i2', 'y');
    c.push('s1', 'OTHER', 'i3', 'z'); // different turn — must survive
    c.flushTurn('s1', 't1');
    expect(out).toHaveLength(2);
    expect(out.every((s) => s.done)).toBe(true);
    expect(c.size).toBe(1); // only the other turn's buffer remains
    vi.advanceTimersByTime(240);
    // drained timers were cleared — the survivor flushes exactly once
    expect(out.filter((s) => s.itemId === 'i1')).toHaveLength(1);
  });

  it('no timer leak: completed buffers clear their interval', () => {
    const c = new DeltaCoalescer(() => {}, { intervalMs: 80 });
    c.push('s1', 't1', 'i1', 'a');
    expect(vi.getTimerCount()).toBe(1);
    c.complete('s1', 't1', 'i1', 'a');
    expect(vi.getTimerCount()).toBe(0);
  });
});
