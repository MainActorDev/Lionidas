import { describe, it, expect } from 'vitest';
import { SettleDetector, QUIET_GAP_MS } from '@crucible/shared/frame-settle';

describe('SettleDetector — quiet/busy from frame timestamps', () => {
  it('starts quiet; single frame after long idle stays quiet (hysteresis)', () => {
    const d = new SettleDetector();
    expect(d.push(1000)).toBe('quiet');           // first frame ever
    expect(d.push(5000)).toBe('quiet');           // 4s gap: isolated straggler
  });

  it('burst of frames → busy; quiet after QUIET_GAP of silence', () => {
    const d = new SettleDetector();
    d.push(1000);
    expect(d.push(1100)).toBe('busy');            // 100ms apart
    expect(d.push(1200)).toBe('busy');
    expect(d.push(1600)).toBe('quiet');           // 400ms gap ≥ QUIET_GAP
  });

  it('tick(): no frame arriving also settles busy → quiet', () => {
    const d = new SettleDetector();
    d.push(1000); d.push(1100); d.push(1200);
    expect(d.tick(1200 + QUIET_GAP_MS)).toBe('quiet');
    expect(d.tick(1200 + QUIET_GAP_MS - 1)).toBe('quiet'); // already quiet, stays
  });

  it('tick() before the gap keeps busy (mid-burst check must not settle early)', () => {
    const d = new SettleDetector();
    d.push(1000); d.push(1100);
    expect(d.tick(1100 + QUIET_GAP_MS - 1)).toBe('busy');
    expect(d.tick(1100 + QUIET_GAP_MS)).toBe('quiet');
  });

  it('steady flow stays busy (carousel case)', () => {
    const d = new SettleDetector();
    let t = 0;
    d.push(t);
    for (let i = 0; i < 50; i++) { t += 100; expect(d.push(t)).toBe('busy'); }
    expect(d.tick(t + 100)).toBe('busy');
  });

  it('busyMs accumulates then resets on quiet', () => {
    const d = new SettleDetector();
    d.push(1000); d.push(1100); d.push(1200); d.push(1300);
    expect(d.busyMs).toBe(300);
    d.push(1300 + QUIET_GAP_MS);
    expect(d.busyMs).toBe(0);
  });
});
