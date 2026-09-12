import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  fillOf, textColorsOf, estimateFontSizePt, estimateRadiusPt, nearestToken,
  rasterFromPng, downscaleTo, bgOf,
  FILL_SPREAD_MAX, INK_DIST_MIN, RADIUS_RMSE_MAX, TOKEN_DE_MAX,
} from '../src/manual/inspect-sample.js';
import type { Raster } from '../src/manual/inspect-sample.js';

async function solidRaster(w: number, h: number, rgb: [number, number, number], scale = 3): Promise<Raster> {
  const img = sharp({ create: { width: w * scale, height: h * scale, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } });
  return rasterFromPng(await img.png().toBuffer(), scale);
}

async function svgRaster(svg: string, scale: number): Promise<Raster> {
  return rasterFromPng(await sharp(Buffer.from(svg)).png().toBuffer(), scale);
}

describe('fillOf', () => {
  it('solid region → exact fill', async () => {
    const r = await solidRaster(100, 40, [42, 108, 219]);
    expect((await fillOf(r))!.hex).toBe('#2A6CDB');
  });
  it('high-variance region (photo-like) → null', async () => {
    const svg = `<svg width="300" height="120"><rect width="300" height="120" fill="#333"/><circle cx="60" cy="60" r="55" fill="#e33"/><circle cx="160" cy="60" r="55" fill="#3e5"/><circle cx="260" cy="60" r="55" fill="#35f"/></svg>`;
    const r = await svgRaster(svg, 3);
    expect(await fillOf(r)).toBeNull();
  });
});

describe('textColorsOf', () => {
  it('light glyphs on dark bg → dominant ink color', async () => {
    const svg = `<svg width="654" height="66"><rect width="654" height="66" fill="#111111"/><text x="9" y="48" font-family="Helvetica" font-size="51" fill="#EEEEEE">Selamat pagi</text></svg>`;
    const r = await svgRaster(svg, 3);
    const out = await textColorsOf(r, { isTextNode: true });
    expect(out!.hex.toUpperCase()).toBe('#EEEEEE');
  });
  it('non-text node → null regardless of pixels', async () => {
    const r = await solidRaster(50, 50, [200, 30, 30]);
    expect(await textColorsOf(r, { isTextNode: false })).toBeNull();
  });
});

describe('estimateFontSizePt', () => {
  it('single-line 17pt Helvetica at 3× → 17 ± 2', async () => {
    const svg = `<svg width="654" height="66"><rect width="654" height="66" fill="#111111"/><text x="9" y="48" font-family="Helvetica" font-size="51" fill="#EE4">Selamat pagi</text></svg>`;
    const r = await svgRaster(svg, 3);
    const pt = await estimateFontSizePt(r);
    expect(pt).not.toBeNull();
    expect(Math.abs(pt! - 17)).toBeLessThanOrEqual(2);
  });
  it('multi-line (two text bands) → null', async () => {
    const svg = `<svg width="300" height="132"><rect width="300" height="132" fill="#111111"/><text x="6" y="40" font-family="Helvetica" font-size="36" fill="#EEEEEE">Ayam</text><text x="6" y="100" font-family="Helvetica" font-size="36" fill="#EEEEEE">goreng</text></svg>`;
    const r = await svgRaster(svg, 3);
    expect(await estimateFontSizePt(r)).toBeNull();
  });
  it('solid rect with no ink → null (no band)', async () => {
    const r = await solidRaster(100, 40, [17, 17, 17]);
    expect(await estimateFontSizePt(r)).toBeNull();
  });
});

describe('estimateRadiusPt', () => {
  it('exact 12pt radius at 3× on contrasting bg', async () => {
    const svg = `<svg width="744" height="132"><rect width="744" height="132" fill="#111111"/><rect x="0" y="0" width="744" height="132" rx="36" fill="#2A6CDB"/></svg>`;
    const r = await svgRaster(svg, 3);
    const pt = await estimateRadiusPt(r, { bg: [17, 17, 17] });
    expect(pt).not.toBeNull();
    expect(Math.abs(pt! - 12)).toBeLessThanOrEqual(1.5);
  });
  it('fill ≈ bg (invisible radius) → null', async () => {
    const r = await solidRaster(248, 44, [17, 17, 17]);
    expect(await estimateRadiusPt(r, { bg: [17, 17, 17] })).toBeNull();
  });
  it('square corners (radius 0) → null (no arc to fit)', async () => {
    const svg = `<svg width="600" height="300"><rect width="600" height="300" fill="#111111"/><rect x="0" y="0" width="600" height="300" fill="#2A6CDB"/></svg>`;
    const r = await svgRaster(svg, 3);
    expect(await estimateRadiusPt(r, { bg: [17, 17, 17] })).toBeNull();
  });
});

describe('nearestToken', () => {
  it('exact token match', () => {
    expect(nearestToken('#FF0000')!.token).toBe('backgroundBrand/brand500');
  });
  it('near-identical within ΔE gate', () => {
    expect(nearestToken('#FE0202')).not.toBeNull();
  });
  it('clearly different color → null', () => {
    expect(nearestToken('#2A6CDB')).toBeNull();
  });
});

describe('downscaleTo', () => {
  it('keeps aspect and updates scale', async () => {
    const r = await solidRaster(300, 100, [10, 20, 30]);
    const d = await downscaleTo(r, 150);
    expect(d.width).toBe(150);
    expect(Math.round(d.height)).toBe(50);
    expect(d.scale).toBeCloseTo(0.5, 1);
  });
});

describe('thresholds exported for tuning', () => {
  it('all named constants present', () => {
    expect(FILL_SPREAD_MAX).toBeGreaterThan(0);
    expect(INK_DIST_MIN).toBeGreaterThan(0);
    expect(RADIUS_RMSE_MAX).toBeGreaterThan(0);
    expect(TOKEN_DE_MAX).toBeGreaterThan(0);
  });
});

describe('bgOf', () => {
  it('perimeter ring median ignores centered ink', async () => {
    const svg = `<svg width="300" height="90"><rect width="300" height="90" fill="#111111"/><text x="10" y="60" font-family="Helvetica" font-size="48" fill="#EEE">Ayam</text></svg>`;
    const r = await svgRaster(svg, 3);
    const bg = bgOf(r);
    expect(bg[0]).toBeLessThan(60);
  });
});
