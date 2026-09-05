/** Tier 2.2 — pure tap-overlay timing logic (shared: web player consumes,
 *  server tests verify). Given persisted taps, the video-start anchor and
 *  the current playhead, return the visible markers with logical→fraction
 *  coords and fade opacity. Same visual language as the live RunPanel
 *  markers (fade window 1400ms). */
export interface OverlayTap {
  seq: number;
  ts: number;
  idx: number | null;
  x: number;
  y: number;
  logicalW: number;
  logicalH: number;
}

export interface OverlayMarker {
  seq: number;
  idx: number | null;
  /** fraction of logical width/height — resolution-independent */
  fx: number;
  fy: number;
  /** 1 at tap moment → 0 at fade end */
  opacity: number;
}

export function overlayAt(taps: OverlayTap[], videoStartedAt: number, playheadMs: number, fadeMs: number): OverlayMarker[] {
  const out: OverlayMarker[] = [];
  for (const t of taps) {
    const rel = t.ts - videoStartedAt;
    if (rel < 0) continue;                       // tap happened before video started
    const age = playheadMs - rel;
    if (age < 0 || age >= fadeMs) continue;      // not yet / already faded
    if (!(t.logicalW > 0) || !(t.logicalH > 0)) continue;
    out.push({
      seq: t.seq,
      idx: t.idx,
      fx: t.x / t.logicalW,
      fy: t.y / t.logicalH,
      opacity: 1 - age / fadeMs,
    });
  }
  return out;
}
