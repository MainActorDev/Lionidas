/** Pixel sampling for inspector estimates. All values are ESTIMATES — callers
 *  must label them (est.). Absence is null, never a guess.
 *
 *  Tuning table (all thresholds named — change here, not at call sites):
 *    FILL_SPREAD_MAX 48  — 90th-pct distance from median for a solid fill (px RGB)
 *    INK_DIST_MIN    60  — min distance from bg for a pixel to count as ink
 *    INK_SHARE_MIN   0.02 — ink must cover ≥2% of the rect to count as glyphs
 *    RADIUS_RMSE_MAX 2.5 — corner contour fit RMSE for a circular arc (px)
 *    RADIUS_SCAN    200  — corner scan window in native px (per side)
 *    SIZE_BAND_FILL 0.95 — band filling the rect = clipped glyph box → null
 *    SIZE_STRIPS       3 — column strips that must agree (left/mid/right)
 *    SIZE_STRIP_TOL  2px — inter-strip band agreement at native res
 *    TOKEN_DE_MAX     10 — CIE ΔE for a DLS token match
 */
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import tokens from './dls-tokens.json' with { type: 'json' };

export const FILL_SPREAD_MAX = 48;
export const INK_DIST_MIN = 60;
export const INK_SHARE_MIN = 0.02;
export const RADIUS_RMSE_MAX = 2.5;
export const RADIUS_SCAN = 200;
export const SIZE_BAND_FILL = 0.95;
export const SIZE_STRIPS = 3;
export const SIZE_STRIP_TOL = 2;
export const TOKEN_DE_MAX = 10;

export interface Raster { data: Buffer; width: number; height: number; scale: number }
type RGB = [number, number, number];

export const hex = (c: RGB) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
const dist = (a: RGB, b: RGB) => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);

function px(r: Raster, x: number, y: number): RGB {
  const i = (y * r.width + x) * 3;
  return [r.data[i]!, r.data[i + 1]!, r.data[i + 2]!];
}

export function quantile(values: number[], q: number): number {
  const a = [...values].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.max(0, Math.round(q * (a.length - 1))))]!;
}

/** Background estimate: median of the perimeter ring (text rarely touches all 4 edges). */
export function bgOf(r: Raster): RGB {
  const ring: RGB[] = [];
  for (let x = 0; x < r.width; x += 2) { ring.push(px(r, x, 0), px(r, x, r.height - 1)); }
  for (let y = 0; y < r.height; y += 2) { ring.push(px(r, 0, y), px(r, r.width - 1, y)); }
  return [0, 1, 2].map((ch) => quantile(ring.map((s) => s[ch] ?? 0), 0.5)) as RGB;
}

/** Fill (est.): median color of the center 50% region. Null when the region is
 *  photo-like (high 90th-pct spread) — no honest single fill exists. */
export async function fillOf(r: Raster): Promise<{ hex: string } | null> {
  const x0 = Math.floor(r.width * 0.25), x1 = Math.ceil(r.width * 0.75);
  const y0 = Math.floor(r.height * 0.25), y1 = Math.ceil(r.height * 0.75);
  const samples: RGB[] = [];
  for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) samples.push(px(r, x, y));
  if (samples.length < 4) return null;
  const med = [0, 1, 2].map((ch) => quantile(samples.map((s) => s[ch] ?? 0), 0.5)) as RGB;
  const spread = quantile(samples.map((s) => dist(s, med)), 0.9);
  if (spread > FILL_SPREAD_MAX) return null;
  return { hex: hex(med) };
}

/** Per-segment median background (24px windows per row) — gradient immune.
 *  Gradients vary SMOOTHLY: within any 24px window the spread is tiny, so the
 *  segment median is that segment's true bg, however much the gradient moves
 *  across the full row (observed: teal→navy gradient spread ≈70 across a row
 *  flips whole gradient tails into phantom "ink" against a single row median).
 *  Glyph-majority segments (strokes ≥ window — bold 68pt digits ARE wider than
 *  24px) flip the local median onto the glyph: those segments are REPLACED by
 *  the smooth-gradient prediction from their neighbors (avg of prev/next seg
 *  medians) when they deviate ≥ SEG_FLIP_MIN from it. */
const SEG_W = 24;
const SEG_FLIP_MIN = 40;
export function segBgOf(r: Raster): RGB[][] {
  const medOf = (s: RGB[]): RGB => [0, 1, 2].map((ch) => quantile(s.map((c) => c[ch] ?? 0), 0.5)) as RGB;
  const rows: RGB[][] = [];
  for (let y = 0; y < r.height; y++) {
    const segs: RGB[] = [];
    for (let x0 = 0; x0 < r.width; x0 += SEG_W) {
      const s: RGB[] = [];
      for (let x = x0; x < Math.min(x0 + SEG_W, r.width); x += 2) s.push(px(r, x, y));
      segs.push(medOf(s));
    }
    // neighbor-interpolate glyph-majority segments back to smooth bg
    const fixed: RGB[] = segs.map((m, i) => {
      const prev = segs[i - 1], next = segs[i + 1];
      if (!prev || !next) return m; // edges: no prediction possible
      const pred = [(prev[0] + next[0]) / 2, (prev[1] + next[1]) / 2, (prev[2] + next[2]) / 2] as RGB;
      return dist(m, pred) >= SEG_FLIP_MIN ? pred : m;
    });
    rows.push(fixed);
  }
  return rows;
}

/** Dominant ink color (est., text nodes only). Antialiased text is a CONTINUUM
 *  of blends, not exact RGB repeats — so: rank all non-bg pixels by contrast to
 *  their OWN row's bg, take the top-contrast decile (the glyph CORES), answer
 *  their median.
 *  Gates: ink must cover ≥ INK_SHARE_MIN of the rect (else it's an edge-halo or
 *  a solid fill, not glyphs) and ink pixels must exist at all. */
export async function textColorsOf(r: Raster, opts: { isTextNode: boolean }): Promise<{ hex: string } | null> {
  if (!opts.isTextNode) return null;
  const segBg = segBgOf(r);
  const inked: Array<{ d: number; c: RGB }> = [];
  for (let y = 1; y < r.height - 1; y += 2) {
    for (let x = 1; x < r.width - 1; x += 2) {
      const c = px(r, x, y);
      const d = dist(c, segBg[y][Math.min(Math.floor(x / SEG_W), segBg[y].length - 1)]);
      if (d >= INK_DIST_MIN) inked.push({ d, c });
    }
  }
  const sampled = Math.max(1, ((r.width - 2) * (r.height - 2)) / 4);
  if (inked.length / sampled < INK_SHARE_MIN) return null; // too little ink → not glyphs
  inked.sort((a, b) => b.d - a.d); // highest-contrast cores first
  const core = inked.slice(0, Math.max(1, Math.floor(inked.length / 10))); // top decile
  const med = [0, 1, 2].map((ch) => quantile(core.map((s) => s.c[ch]!), 0.5)) as RGB;
  // PHANTOM-INK GUARD: glyph-majority segment runs (bold text wider than a
  // segment) invert the local bg — the "ink" found is then the actual bg
  // (e.g. the gradient between digit gaps) and the glyph became "bg". Detect:
  // the ring (region border) is bg-dominated and never contains glyph cores,
  // so REAL ink contrasts with the ring; phantom "ink" IS bg and matches it.
  // Honest null beats a confident wrong color.
  const ring = bgOf(r);
  if (dist(med, ring) < INK_DIST_MIN) return null;
  return { hex: hex(med) };
}

/** Font size (est., pt): ink-band height ÷ 0.72 (SF/Helvetica cap+descender
 *  ratio). Single-band guard scans FULL width (word gaps must not split the
 *  band); the 3 column strips then verify their ink rows fall inside the band
 *  (±tol) — guards icons/gradient patches faking a text band. */
export async function estimateFontSizePt(r: Raster): Promise<number | null> {
  const segBg = segBgOf(r);
  const bandScan = (x0: number, x1: number): Array<[number, number]> => {
    const bands: Array<[number, number]> = [];
    let s = -1;
    for (let y = 0; y < r.height; y++) {
      let ink = 0;
      for (let x = x0; x < x1; x++) if (dist(px(r, x, y), segBg[y][Math.min(Math.floor(x / SEG_W), segBg[y].length - 1)]) > INK_DIST_MIN) ink++;
      const on = ink > Math.max(2, (x1 - x0) * 0.02);
      if (on && s < 0) s = y;
      if (!on && s >= 0) { bands.push([s, y - 1]); s = -1; }
    }
    if (s >= 0) bands.push([s, r.height - 1]);
    return bands;
  };
  const W = r.width;
  const bands = bandScan(0, W);
  if (!bands.length) return null; // no ink at all
  const h = (b: [number, number]) => b[1] - b[0] + 1;
  const tallest = bands.reduce((a, b) => (h(b) > h(a) ? b : a));
  // descender/ascender sub-bands (<50% of the main band) belong to the same
  // line; two or more LARGE bands = genuinely multi-line → not estimable
  const big = bands.filter((b) => h(b) >= h(tallest) * 0.5);
  if (big.length > 1) return null;
  if (h(tallest) / r.height > SIZE_BAND_FILL) return null; // band fills rect → clip risk
  // strip containment: ink in any strip must sit inside the full ink span
  const spanTop = Math.min(...bands.map((b) => b[0]));
  const spanBot = Math.max(...bands.map((b) => b[1]));
  const sw = Math.floor(W / SIZE_STRIPS);
  for (let i = 0; i < SIZE_STRIPS; i++) {
    const s = bandScan(i * sw, Math.min((i + 1) * sw, W));
    for (const [t, b] of s) {
      if (t < spanTop - SIZE_STRIP_TOL || b > spanBot + SIZE_STRIP_TOL) return null;
    }
  }
  // mixed-case ink band (ascender→baseline) ≈ 0.72 em
  return Math.round(h(tallest) / r.scale / 0.72);
}

/** Corner radius (est., pt): least-squares circle fit per corner at native res,
 *  median across agreeing corners. <2 agreeing corners → null (asymmetric/noisy). */
export async function estimateRadiusPt(r: Raster, opts: { bg: RGB }): Promise<number | null> {
  const center: RGB = px(r, Math.floor(r.width / 2), Math.floor(r.height / 2));
  if (dist(center, opts.bg) < 20) return null;
  const corners: Array<number | null> = [];
  const fit = (read: (yy: number, xx: number) => RGB, yMax: number, xMax: number): number | null => {
    const rows: Array<[number, number]> = [];
    for (let y = 0; y <= yMax; y++) {
      let xFill = -1;
      for (let x = 0; x <= xMax; x++) if (dist(read(y, x), opts.bg) > 20) { xFill = x; break; }
      if (xFill >= 0) rows.push([y, xFill]);
    }
    if (rows.length < 4) return null;
    // rows past the arc are straight-edge rows — uncorrelated error for the
    // circle fit. Keep the CURVE: rows while xFill keeps CHANGING (decreasing
    // toward the arc's waist for TL-style corners); stop when it flatlines.
    const curve: Array<[number, number]> = [];
    for (let i = 0; i < rows.length; i++) {
      if (i === 0 || rows[i]![1] !== rows[i - 1]![1]) curve.push(rows[i]!);
      else break;
    }
    if (curve.length < 4) return null;
    let bestR = -1, bestErr = Infinity;
    for (let rad = 2; rad <= Math.max(yMax, xMax); rad++) {
      let err = 0;
      for (const [y, xFill] of curve) {
        const yy = Math.min(y, rad);
        const expect = rad - Math.sqrt(Math.max(0, rad * rad - (rad - yy) ** 2));
        err += (xFill - expect) ** 2;
      }
      if (err < bestErr) { bestErr = err; bestR = rad; }
    }
    const rmse = Math.sqrt(bestErr / curve.length);
    return rmse <= RADIUS_RMSE_MAX ? bestR : null;
  };
  const W = r.width - 1, H = r.height - 1;
  const lim = RADIUS_SCAN;
  corners.push(fit((y, x) => px(r, x, y), Math.min(H, lim), Math.min(W, lim)));                                   // TL
  corners.push(fit((y, x) => px(r, W - x, y), Math.min(H, lim), Math.min(W, lim)));                               // TR
  corners.push(fit((y, x) => px(r, x, H - y), Math.min(H, lim), Math.min(W, lim)));                               // BL
  corners.push(fit((y, x) => px(r, W - x, H - y), Math.min(H, lim), Math.min(W, lim)));                           // BR
  const good = corners.filter((c): c is number => c !== null && c > 2);
  if (good.length < 2) return null;
  good.sort((a, b) => a - b);
  const med = good.length % 2 ? good[(good.length - 1) / 2]! : (good[good.length / 2 - 1]! + good[good.length / 2]!) / 2;
  const agreeing = good.filter((c) => Math.abs(c - med) <= Math.max(4, med * 0.25));
  if (agreeing.length < 2) return null;
  return Math.round((med / r.scale) * 10) / 10;
}

/** DLS token nearest-match. CIE ΔE via sRGB→Lab; ≤ TOKEN_DE_MAX only. */
export function nearestToken(hexIn: string): { token: string; dE: number } | null {
  const rgb = hexToRgb(hexIn);
  if (!rgb) return null;
  const lab = srgbToLab(rgb);
  let best: { token: string; dE: number } | null = null;
  for (const t of tokens as Array<{ token: string; hex: string }>) {
    const l2 = srgbToLab(hexToRgb(t.hex)!);
    const dE = Math.sqrt((lab[0] - l2[0]) ** 2 + (lab[1] - l2[1]) ** 2 + (lab[2] - l2[2]) ** 2);
    if (!best || dE < best.dE) best = { token: t.token, dE: Math.round(dE * 10) / 10 };
  }
  return best && best.dE <= TOKEN_DE_MAX ? best : null;
}

export function hexToRgb(h: string): RGB | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(h.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function srgbToLab(rgb: RGB): [number, number, number] {
  const f = (v: number) => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [R = 0, G = 0, B = 0] = rgb.map(f);
  const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const Y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const g = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const [fx = 0, fy = 0, fz = 0] = [X, Y, Z].map(g);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** Decode a screenshot region to a raw RGB raster. `rect` is in LOGICAL pt;
 *  `scale` derived from image px / logicalW. Native-res (no downscale). */
export async function regionRaster(path: string, rect: { x: number; y: number; width: number; height: number }, scale: number): Promise<Raster> {
  const meta = await sharp(path).metadata();
  const left = Math.max(0, Math.round(rect.x * scale));
  const top = Math.max(0, Math.round(rect.y * scale));
  const width = Math.min(meta.width! - left, Math.round(rect.width * scale));
  const height = Math.min(meta.height! - top, Math.round(rect.height * scale));
  if (width < 4 || height < 4) throw new Error(`region too small: ${width}x${height}`);
  const { data, info } = await sharp(path)
    .extract({ left, top, width: Math.max(4, width), height: Math.max(4, height) })
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) throw new Error(`expected 3 channels, got ${info.channels}`);
  return { data, width: info.width, height: info.height, scale };
}

/** Downscaled raster for color/size work (keeps aspect; ≤ target wide). */
export async function downscaleTo(r: Raster, targetWide: number): Promise<Raster> {
  if (r.width <= targetWide) return r;
  const { data, info } = await sharp(r.data, { raw: { width: r.width, height: r.height, channels: 3 } })
    .resize({ width: targetWide })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const scale = (r.scale * info.width) / r.width;
  return { data, width: info.width, height: info.height, scale };
}

/** Decode a PNG buffer to a raw RGB raster (alpha stripped — px() assumes 3ch). */
export async function rasterFromPng(buf: Buffer, scale: number): Promise<Raster> {
  const { data, info } = await sharp(buf).removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) throw new Error(`expected 3 channels, got ${info.channels}`);
  return { data, width: info.width, height: info.height, scale };
}

export { readFile };
