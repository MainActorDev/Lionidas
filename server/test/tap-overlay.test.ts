import { describe, it, expect } from 'vitest';
import { overlayAt, type OverlayTap } from '@crucible/shared/tap-overlay';

/** Task 4 — pure overlay logic. playheadMs is VIDEO-relative (what the
 *  player computes as video.currentTime*1000); tap times are absolute
 *  epoch, aligned via videoStartedAt. Visible in [0, FADE_MS) after the
 *  tap's video-relative moment; linear fade to 0. */
const FADE = 1400;
const taps: OverlayTap[] = [
  { seq: 1, ts: 10_000, idx: 0, x: 100, y: 200, logicalW: 400, logicalH: 800 },
  { seq: 2, ts: 12_000, idx: 1, x: 300, y: 600, logicalW: 400, logicalH: 800 },
];

describe('overlayAt', () => {
  it('no markers before the first tap (playhead 5s, tap at 0s already faded)', () => {
    expect(overlayAt(taps, 10_000, 5_000, FADE)).toEqual([]);
  });

  it('marker at full opacity at tap moment, fading to 0 at FADE_MS', () => {
    const hit = overlayAt(taps, 10_000, 0, FADE);
    expect(hit).toHaveLength(1);
    expect(hit[0]).toMatchObject({ seq: 1, fx: 0.25, fy: 0.25, opacity: 1 });
    const mid = overlayAt(taps, 10_000, 700, FADE);
    expect(mid[0]!.opacity).toBeCloseTo(0.5, 5);
  });

  it('skips taps before video start (rel < 0); later tap still shows', () => {
    // anchor after tap 1: rel₁ = -1000 → skip; tap 2 at rel 1000
    const r = overlayAt(taps, 11_000, 1_500, FADE);
    expect(r.find((m) => m.seq === 1)).toBeUndefined();
    expect(r.find((m) => m.seq === 2)).toMatchObject({ seq: 2, opacity: expect.closeTo(0.643, 2) });
  });

  it('boundary: playhead exactly at tap+FADE is invisible; at FADE-1 visible', () => {
    expect(overlayAt(taps, 10_000, FADE, FADE)).toEqual([]);
    expect(overlayAt(taps, 10_000, FADE - 1, FADE)).toHaveLength(1);
  });
});
