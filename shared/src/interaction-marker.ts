/** Shared 030-B interaction-marker draw (live cockpit + evidence replay use
 *  the SAME code — parity by construction, not by copy). Pure canvas ops:
 *  full-bleed crosshair guides + ember ring + optional caret + label chip
 *  with offscreen flip. Opacity from the caller (live: fade by age;
 *  evidence: overlayAt fade). The op-recording variant exists so tests can
 *  assert parity deterministically (the live-drill lesson: never verify
 *  canvas by pixels). */

export interface MarkerSpec {
  /** fraction of logical width/height — resolution independent */
  fx: number;
  fy: number;
  label: string;
  kind: 'tap' | 'type';
  /** 1 = fresh, 0 = fully faded */
  opacity: number;
}

const EMBER = '234,110,52';

export function drawInteractionMarker(
  ctx: CanvasRenderingContext2D,
  m: MarkerSpec,
  w: number,
  h: number,
): void {
  const alpha = Math.max(0, Math.min(1, m.opacity));
  if (alpha <= 0) return;
  const x = m.fx * w;
  const y = m.fy * h;

  // full-bleed guides (quiet)
  ctx.strokeStyle = `rgba(${EMBER},${alpha * 0.35})`;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();

  // center ring + dot
  ctx.strokeStyle = `rgba(${EMBER},${alpha})`;
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(x, y, 1.5, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(${EMBER},${alpha})`; ctx.fill();

  // typing lands at a spot: caret tick
  if (m.kind === 'type') ctx.fillRect(x - 1, y - 12, 2, 24);

  // label chip — never offscreen
  ctx.font = '10px ui-monospace, Menlo, monospace';
  const tw = ctx.measureText(m.label).width + 12;
  let lx = x + 14; if (lx + tw > w) lx = x - 14 - tw;
  let ly = y - 24; if (ly < 30) ly = y + 16;
  ctx.fillStyle = `rgba(0,0,0,${0.7 * alpha})`;
  ctx.fillRect(lx, ly, tw, 16);
  ctx.strokeStyle = `rgba(${EMBER},${alpha * 0.6})`;
  ctx.lineWidth = 1;
  ctx.strokeRect(lx, ly, tw, 16);
  ctx.fillStyle = `rgba(238,238,238,${alpha})`;
  ctx.fillText(m.label, lx + 6, ly + 11.5);
}
