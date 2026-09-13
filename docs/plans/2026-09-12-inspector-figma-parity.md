# Inspector Figma-Parity — Final Implementation Plan

> **For Hermes:** implement task-by-task with build/test verification between each.
> Design reference (FINAL, user-approved): `sketches/006-inspector-props/a2-figma-rail-menu/index.html`
> — tool rail (vertical, icon-only, hover tooltips) + props rail, both on the RIGHT of the canvas.

**Goal:** Upgrade inspect mode from "boxes only" to a Figma-parity inspector: spacing redlines (padding + sibling gaps), a properties rail (position/size, spacing diagram, typography, appearance), pixel-sampled estimates marked `(est.)`, DLS token matching, and a specialized vertical tool menu — on both DrivePage and DeviceSidebar.

**Architecture:** Exact values come from AX-tree geometry (pure functions in `shared/`); estimated values (text color, font size, corner radius, fill) are sampled server-side with `sharp` from a lossless child screenshot via the existing `alloy_screenshot` seam. UI is two new presentational components (`InspectTools`, `InspectProps`) + one composable (`useInspectProps`) shared by both surfaces. Honesty contract: every sampled value carries `(est.)` + section badge `◌ sampled`; unknowable values render `—`; never a silent guess.

**Tech Stack:** Vue 3 + TS (web), vitest (server tests), sharp 0.35 (already a server dep), existing POST `/api/manual/:id/tree`.

**Out of scope (decided):** font family/weight estimation (unreliable from pixels), DYLD-injection probe (Tier 3), new child endpoints.

---

## Performance budget & quality bar (measured, not vibes)

Cost model against the real pipeline (3× capture = 1179×2556 ≈ 3 MP, 9 MB raw RGB):

| Stage | Naive | Budgeted design |
|---|---|---|
| Child capture (`alloy_screenshot`) | ~300 ms | ~300 ms (irreducible; one per selection change) |
| Decode + region extract (sharp) | full-frame 9 MB raw ~150 ms | **`extract()` before `raw()`** — region-only ≈ 0.9 MB, ~80 ms |
| Color/ink sampling | full-res stride-2 ≈ 90 ms | **512-wide downscale** ≈ 45 ms |
| Font band scan | **full-res ≈ 900 ms ☠** | 512-wide ≈ 170 ms (bands are row facts; x-precision irrelevant) |
| Radius contour fit | full-frame scan | **native-res corner crop 200×120** ≈ 7 ms (precision needs pixels; ×4 corners ≈ 30 ms) |
| **Per selection (p50 target)** | ~1.6 s | **≤ 800 ms**, stretch 500 ms |
| Client render | — | trivial: static SVG caps in viewBox units, re-render only on selection/tree change; zero per-frame work; zero stream impact (screenshot seam ≠ stream WS) |

**Resolution policy lives in the ROUTE (Task 5), not the estimators.** Estimators stay pure over any `Raster` they receive (its `scale` = that image's px/pt); the route feeds: colors + font-size at ≤512-wide downscale, radius at native-res corner crops. Tests in Tasks 2–3 build fixtures at 3× and pass `scale: 3` — unaffected by route policy.

**Sampling stack rules (Task 5/6):**
- Debounce 250 ms + single in-flight (abort previous) — no request storm during hover churn.
- No screenshot caching across selections in v1 (honesty > latency); revisit only if p95 > 1 s in drills.
- Screenshot dispatch does not contend with the child input gate (separate routes) — verified in Task 12 by sampling during a 56-char type (stream + gate health unchanged).

**Quality upgrades over v1 sketches (Task 3):**
- Radius: fit **all 4 corners independently**, take the median, discard outliers (RMSE > 2.5 px per corner → that corner null); report null only when < 2 corners agree. Asymmetric shapes stay honest.
- Font size: band detection runs on **3 column strips (left/mid/right)** — strips must agree within 2 px else null (guards icons, gradients, partial glyphs).
- All thresholds (ink dist 60, fill spread 48, ΔE 10, RMSE 2.5) become named constants with a tuning table in the module docblock — no magic numbers inline.
- **Task 12 asserts the budget**: `performance.now()` markers around fetch→render, recorded per drill; acceptance = p50 ≤ 800 ms, p95 ≤ 1.5 s on the local stack; failure = tune (never loosen honesty nulls).

---

## Ground truth (verified in repo, 2026-09-12)

| Fact | Where |
|---|---|
| `AxNode = { index?, parentIndex?, type?, label?, identifier?, rect?{x,y,width,height} }` | `shared/src/ax-tree.ts:8` |
| Tree fetch returns `{ nodes, logicalW, logicalH }` | `web/src/composables/useInspectTree.ts:57`, route `server/src/routes/manual.ts:239` |
| InspectOverlay = pure SVG, `viewBox 0 0 logicalW logicalH`, rides bezel-wrap pct rect, pointer-events none | `web/src/components/InspectOverlay.vue` |
| Selection re-resolution already exists (`sameNodeIn` watcher) | `web/src/components/DeviceSidebar.vue:120`, `DrivePage.vue` |
| Screenshot seam: `dispatchWithHeal('alloy_screenshot', {udid}) → {ok, result:{path}}` | `server/src/manual/session.ts:59` |
| `sharp` available server-side; `pino` log; tests `server/test/*.test.ts` (vitest) | `server/package.json` |
| App nav sidebar is LEFT (`--sidebar-w: 220px`, `layout.css:5`) → inspector cluster goes RIGHT | `web/src/styles/layout.css` |
| DeviceSidebar content column ≈ 196px wide (220 − padding) | `.sb-body` padding 12 |
| Existing key bindings: `i` = toggle inspect, `Esc` = deselect/exit | `DeviceSidebar.vue:143,674` |
| Web checks: `pnpm typecheck` (vue-tsc) + `pnpm lint` (oxlint); no web unit-test runner | `web/package.json` |
| Server checks: `CI=true pnpm vitest run` (581 passing baseline) + `tsc --noEmit` | `server/package.json` |

**Shortcut conflict resolved:** `i` stays "toggle inspect". Mode keys only while inspect is ON: `m` = measure ⇄ inspect, `t` = tree, `e` = estimates, `s` = screenshot, `⌘⇧C` = copy. Before wiring, grep both surfaces for existing `m/t/e/s` handlers and re-verify (Task 8, Step 0).

---

## Phase 1 — Shared geometry (pure functions, TDD)

### Task 1: spacing/geometry module `shared/src/inspect-geometry.ts`

**Files:**
- Create: `shared/src/inspect-geometry.ts`
- Test: `server/test/inspect-geometry.test.ts`

**Step 1 — write failing tests** covering: parent padding (4 sides), prev/next sibling gap on the dominant axis, layout-direction detection (row vs column via sibling rect overlap), same-rect double-exposure dedupe (SwiftUI heading `Other` + `StaticText` sharing origin → one entry before spacing math), out-of-flow guard (overlay/carousel siblings that intersect the target are excluded from gap math), negative/absent parent → all nulls (honest).

```ts
import { describe, expect, it } from 'vitest';
import { paddingToParent, siblingGaps, dedupeExposures } from '@crucible/shared/inspect-geometry';
import type { AxNode } from '@crucible/shared/ax-tree';

const node = (i: number, x: number, y: number, w: number, h: number, p?: number, type = 'Other'): AxNode =>
  ({ index: i, parentIndex: p, type, rect: { x, y, width: w, height: h } });

describe('paddingToParent', () => {
  it('four sides from exact rects', () => {
    const child = node(1, 16, 20, 100, 40, 0);
    const parent = node(0, 0, 0, 320, 240);
    expect(paddingToParent(child, parent)).toEqual({ top: 20, right: 204, bottom: 180, left: 16 });
  });
  it('nulls when either rect missing', () => {
    expect(paddingToParent(node(1, 0, 0, 1, 1), { index: 0 })).toBeNull();
  });
});

describe('siblingGaps', () => {
  it('column layout: prev/next vertical gaps', () => {
    const target = node(2, 0, 110, 100, 40, 0);
    const sibs = [node(1, 0, 50, 100, 40, 0), node(3, 0, 160, 100, 40, 0)];
    expect(siblingGaps(target, sibs, node(0, 0, 0, 100, 300))).toMatchObject({ axis: 'y', prev: 20, next: 10 });
  });
  it('row layout detected via x-overlap', () => {
    const target = node(2, 120, 0, 40, 40, 0);
    const sibs = [node(1, 60, 0, 40, 40, 0), node(3, 200, 0, 40, 40, 0)];
    expect(siblingGaps(target, sibs, node(0, 0, 0, 300, 40))).toMatchObject({ axis: 'x', prev: 20, next: 40 });
  });
  it('overlapping (out-of-flow) siblings excluded from gap math', () => {
    const target = node(2, 0, 110, 100, 40, 0);
    const sibs = [node(1, 0, 50, 100, 40, 0), node(3, 10, 120, 80, 20, 0)]; // 3 intersects target
    expect(siblingGaps(target, sibs, node(0, 0, 0, 100, 300))).toMatchObject({ axis: 'y', prev: 20, next: null });
  });
});

describe('dedupeExposures', () => {
  it('same-origin double exposure collapses to the labeled node', () => {
    const nodes = [node(1, 16, 84, 218, 22, 0), node(2, 16, 84, 218, 22, 0, 'StaticText')];
    expect(dedupeExposures(nodes)).toHaveLength(1);
    expect(dedupeExposures(nodes)[0].type).toBe('StaticText');
  });
});
```

**Step 2 — run, expect FAIL** (module missing): `cd server && CI=true pnpm vitest run test/inspect-geometry.test.ts`

**Step 3 — implement** (complete module):

```ts
/** Inspector geometry: exact spacing facts from AX rects. Pure — no DOM, no pixels.
 *  Honesty: absence (missing rects, no in-flow neighbor) is NULL, never 0. */
import type { AxNode } from './ax-tree';

export interface Padding { top: number; right: number; bottom: number; left: number }

export function paddingToParent(n: AxNode, parent: AxNode | null): Padding | null {
  if (!n.rect || !parent?.rect) return null;
  const r = n.rect, p = parent.rect;
  return { top: r.y - p.y, right: p.x + p.width - (r.x + r.width), bottom: p.y + p.height - (r.y + r.height), left: r.x - p.x };
}

/** Collapse SwiftUI double-exposure (e.g. heading `Other` + `StaticText` sharing an
 *  origin): keep the more specific node (labeled > unlabeled; StaticText > Other). */
export function dedupeExposures(nodes: AxNode[]): AxNode[] {
  const key = (n: AxNode) => n.rect ? `${Math.round(n.rect.x)},${Math.round(n.rect.y)},${Math.round(n.rect.width)},${Math.round(n.rect.height)}` : `idx${n.index}`;
  const score = (n: AxNode) => (n.label ? 2 : 0) + (n.type === 'StaticText' ? 1 : 0);
  const best = new Map<string, AxNode>();
  for (const n of nodes) {
    const k = key(n);
    if (!best.has(k) || score(n) > score(best.get(k)!)) best.set(k, n);
  }
  return [...best.values()];
}

export interface Gaps { axis: 'x' | 'y'; prev: number | null; next: number | null }

/** Gaps to adjacent IN-FLOW siblings on the dominant axis. A sibling that
 *  intersects the target on the other axis is out-of-flow (overlay/carousel)
 *  and is excluded — overlap must never produce a negative gap. */
export function siblingGaps(n: AxNode, siblings: AxNode[], parent: AxNode | null): Gaps | null {
  if (!n.rect || siblings.length === 0) return null;
  const r = n.rect;
  const inFlow = siblings.filter((s) => {
    if (!s.rect) return false;
    const o = overlap(r, s.rect);
    return o.w > 1 && o.h > 1; // must share the cross-axis to be in the same flow
  });
  if (!inFlow.length) return null;
  // dominant axis: how do in-flow siblings sit relative to us?
  const below = inFlow.filter((s) => s.rect!.y >= r.y + r.height - 1);
  const right = inFlow.filter((s) => s.rect!.x >= r.x + r.width - 1);
  const axis: 'x' | 'y' = right.length >= below.length ? 'x' : 'y';
  if (axis === 'y') {
    const prev = inFlow.filter((s) => s.rect!.y + s.rect!.height <= r.y + 1)
      .sort((a, b) => b.rect!.y + b.rect!.height - (a.rect!.y + a.rect!.height))[0];
    const next = inFlow.filter((s) => s.rect!.y >= r.y + r.height - 1)
      .sort((a, b) => a.rect!.y - b.rect!.y)[0];
    return { axis, prev: prev ? r.y - (prev.rect!.y + prev.rect!.height) : null, next: next ? next.rect!.y - (r.y + r.height) : null };
  }
  const prev = inFlow.filter((s) => s.rect!.x + s.rect!.width <= r.x + 1)
    .sort((a, b) => b.rect!.x + b.rect!.width - (a.rect!.x + a.rect!.width))[0];
  const next = inFlow.filter((s) => s.rect!.x >= r.x + r.width - 1)
    .sort((a, b) => a.rect!.x - b.rect!.x)[0];
  return { axis, prev: prev ? r.x - (prev.rect!.x + prev.rect!.width) : null, next: next ? next.rect!.x - (r.x + r.width) : null };
}

function overlap(a: AxNode['rect'], b: AxNode['rect']) {
  const x = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return { w: x, h: y };
}
```

`parent` param is reserved for future centering context; unused for gap math itself — keep the signature ( callers pass it) but mark `@param parent` documented or drop it. **Decision: drop `parent` from `siblingGaps`** (YAGNI) — update tests accordingly before implementing.

**Step 4 — tests PASS** (adjust expected `{axis, prev, next}` objects to the final signature).

**Step 5 — export from shared index** if `shared/src/index.ts` re-exports modules (check how `ax-tree` is exported; mirror it — imports use `@crucible/shared/ax-tree` subpath, so likely no index change needed).

**Step 6 — commit:** `feat(shared): inspector spacing geometry — padding, sibling gaps, exposure dedupe`

---

## Phase 2 — Sampling engine (server, TDD on synthetic images)

### Task 2: sampler module `server/src/manual/inspect-sample.ts` — colors

**Files:**
- Create: `server/src/manual/inspect-sample.ts`
- Test: `server/test/inspect-sample.test.ts`

Sampling operates on a decoded raw buffer (`sharp(...).raw().toBuffer({resolveWithObject:true})`) plus a pt→px `scale`. Pure functions take `{data, width, height, scale}` — the file/child I/O is wired in Task 5, so tests need no simulator.

**Step 1 — failing tests** (build fixtures with sharp itself — deterministic):

```ts
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { fillOf, textColorsOf } from '../src/manual/inspect-sample.js';

async function solidPng(w: number, h: number, rgb: [number, number, number], scale = 3) {
  const img = sharp({ create: { width: w * scale, height: h * scale, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } });
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, scale };
}

describe('fillOf', () => {
  it('solid region → exact fill', async () => {
    expect((await fillOf(await solidPng(100, 40, [42, 108, 219]))).hex).toBe('#2A6CDB');
  });
  it('high-variance region (photo-like) → null', async () => {
    const svg = `<svg width="300" height="120"><rect width="300" height="120" fill="#333"/><circle cx="60" cy="60" r="55" fill="#e33"/><circle cx="160" cy="60" r="55" fill="#3e5"/><circle cx="260" cy="60" r="55" fill="#35f"/></svg>`;
    const { data, info } = await sharp(Buffer.from(svg)).raw().toBuffer({ resolveWithObject: true });
    expect(await fillOf({ data, width: info.width, height: info.height, scale: 3 })).toBeNull();
  });
});

describe('textColorsOf', () => {
  it('light glyphs on dark bg → dominant ink color', async () => {
    const svg = `<svg width="654" height="66"><rect width="654" height="66" fill="#111"/><text x="9" y="48" font-family="Helvetica" font-size="51" fill="#EEEEEE">Selamat pagi</text></svg>`;
    const { data, info } = await sharp(Buffer.from(svg)).raw().toBuffer({ resolveWithObject: true });
    const out = await textColorsOf({ data, width: info.width, height: info.height, scale: 3 }, { isTextNode: true });
    expect(out?.hex.toUpperCase()).toBe('#EEEEEE');
  });
});
```

**Step 2 — FAIL** (`Cannot find module`).

**Step 3 — implement** color extraction:

```ts
/** Pixel sampling for inspector estimates. All values are ESTIMATES — callers
 *  must label them (est.). Absence is null, never a guess. */
import sharp from 'sharp';

export interface Raster { data: Buffer; width: number; height: number; scale: number }
type RGB = [number, number, number];

const hex = (c: RGB) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
const dist = (a: RGB, b: RGB) => Math.sqrt((a[0]-b[0])**2 + (a[1]-b[1])**2 + (a[2]-b[2])**2);

function px(r: Raster, x: number, y: number): RGB { const i = (y * r.width + x) * 3; return [r.data[i], r.data[i+1], r.data[i+2]]; }

/** Median color of the center 50% region. Null when variance is photo-like. */
export async function fillOf(r: Raster): Promise<{ hex: string } | null> {
  const x0 = Math.floor(r.width * 0.25), x1 = Math.ceil(r.width * 0.75);
  const y0 = Math.floor(r.height * 0.25), y1 = Math.ceil(r.height * 0.75);
  const samples: RGB[] = [];
  for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) samples.push(px(r, x, y));
  if (samples.length < 4) return null;
  const med = [0,1,2].map((ch) => quantile(samples.map((s) => s[ch]), 0.5)) as RGB;
  const spread = quantile(samples.map((s) => dist(s, med)), 0.9);
  if (spread > 48) return null; // photo/gradient — no honest single fill
  return { hex: hex(med) };
}

/** Dominant ink color (pixels far from the region's bg median). Text nodes only. */
export async function textColorsOf(r: Raster, opts: { isTextNode: boolean }): Promise<{ hex: string } | null> {
  if (!opts.isTextNode) return null;
  // bg = median of the perimeter ring (text rarely touches all edges)
  const ring: RGB[] = [];
  for (let x = 0; x < r.width; x += 2) { ring.push(px(r, x, 0), px(r, x, r.height - 1)); }
  for (let y = 0; y < r.height; y += 2) { ring.push(px(r, 0, y), px(r, r.width - 1, y)); }
  const bg = [0,1,2].map((ch) => quantile(ring.map((s) => s[ch]), 0.5)) as RGB;
  const counts = new Map<string, { n: number; sum: RGB }>();
  for (let y = 1; y < r.height - 1; y += 2) for (let x = 1; x < r.width - 1; x += 2) {
    const c = px(r, x, y);
    if (dist(c, bg) < 60) continue; // not ink
    const k = c.map((v) => v >> 5).join(','); // 4-bit/channel buckets
    const e = counts.get(k) ?? { n: 0, sum: [0,0,0] }; e.n++; e.sum[0]+=c[0]; e.sum[1]+=c[1]; e.sum[2]+=c[2]; counts.set(k, e);
  }
  const best = [...counts.values()].sort((a, b) => b.n - a.n)[0];
  const total = [...counts.values()].reduce((s, e) => s + e.n, 0);
  if (!best || best.n / total < 0.5) return null; // no dominant ink
  return { hex: hex([best.sum[0]/best.n, best.sum[1]/best.n, best.sum[2]/best.n]) };
}

export function quantile(sorted: number[], q: number): number {
  const a = [...sorted].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.max(0, Math.round(q * (a.length - 1))))]!;
}
```

**Step 4 — PASS. Step 5 — commit:** `feat(server): inspector color sampling — fill + dominant ink`

### Task 3: font size + corner radius estimators (same module)

**Step 1 — failing tests** appended to `server/test/inspect-sample.test.ts`:

```ts
import { estimateFontSizePt, estimateRadiusPt } from '../src/manual/inspect-sample.js';

describe('estimateFontSizePt', () => {
  it('single-line 17pt Helvetica at 3× → 17 ± 2', async () => {
    const svg = `<svg width="654" height="66"><rect width="654" height="66" fill="#111"/><text x="9" y="48" font-family="Helvetica" font-size="51" fill="#EE4">Selamat pagi</text></svg>`;
    const { data, info } = await sharp(Buffer.from(svg)).raw().toBuffer({ resolveWithObject: true });
    const pt = await estimateFontSizePt({ data, width: info.width, height: info.height, scale: 3 });
    expect(pt).not.toBeNull();
    expect(Math.abs(pt! - 17)).toBeLessThanOrEqual(2);
  });
  it('multi-line (two text bands) → null', async () => {
    const svg = `<svg width="300" height="132"><rect width="300" height="132" fill="#111"/><text x="6" y="40" font-family="Helvetica" font-size="36" fill="#EEE">Ayam</text><text x="6" y="100" font-family="Helvetica" font-size="36" fill="#EEE">goreng</text></svg>`;
    const { data, info } = await sharp(Buffer.from(svg)).raw().toBuffer({ resolveWithObject: true });
    expect(await estimateFontSizePt({ data, width: info.width, height: info.height, scale: 3 })).toBeNull();
  });
});

describe('estimateRadiusPt', () => {
  it('exact 12pt radius at 3× on contrasting bg', async () => {
    const svg = `<svg width="744" height="132"><rect width="744" height="132" fill="#111"/><rect x="0" y="0" width="744" height="132" rx="36" fill="#2A6CDB"/></svg>`;
    const { data, info } = await sharp(Buffer.from(svg)).raw().toBuffer({ resolveWithObject: true });
    const pt = await estimateRadiusPt({ data, width: info.width, height: info.height, scale: 3 }, { bg: [17, 17, 17] });
    expect(Math.abs(pt! - 12)).toBeLessThanOrEqual(1.5);
  });
  it('fill ≈ bg (invisible radius) → null', async () => {
    const { data, width, height } = { ...(await solidPngRaw(248, 44, [17, 17, 17])), scale: 3 } as Raster;
    const r = { data, width, height, scale: 3 };
    expect(await estimateRadiusPt(r, { bg: [17, 17, 17] })).toBeNull();
  });
});
```

(Test helper `solidPngRaw` = the Task 2 fixture minus fill assertion reuse.)

**Step 2 — FAIL. Step 3 — implement:**

```ts
/** Font size (est.): single-line guard via ink-band analysis. Cap+descender band
 *  of one text line ≈ 0.72 × font size (SF/Helvetica). Multi-line → null. */
export async function estimateFontSizePt(r: Raster): Promise<number | null> {
  const ring: RGB[] = []; /* same perimeter ring as textColorsOf → bg */
  for (let x = 0; x < r.width; x += 2) { ring.push(px(r, x, 0), px(r, x, r.height - 1)); }
  for (let y = 0; y < r.height; y += 2) { ring.push(px(r, 0, y), px(r, r.width - 1, y)); }
  const bg = [0,1,2].map((ch) => quantile(ring.map((s) => s[ch]), 0.5)) as RGB;
  const rowInk: boolean[] = [];
  for (let y = 0; y < r.height; y++) {
    let ink = 0;
    for (let x = 0; x < r.width; x++) if (dist(px(r, x, y), bg) > 60) ink++;
    rowInk.push(ink > Math.max(2, r.width * 0.02));
  }
  const bands: Array<[number, number]> = [];
  let s = -1;
  rowInk.forEach((ink, y) => { if (ink && s < 0) s = y; if (!ink && s >= 0) { bands.push([s, y - 1]); s = -1; } });
  if (s >= 0) bands.push([s, rowInk.length - 1]);
  if (bands.length !== 1) return null;             // 0 = no text, 2+ = multi-line
  const bandPx = bands[0]![1] - bands[0]![0] + 1;
  if (bandPx / r.height > 0.95) return null;       // band fills rect — rect IS the glyph box (clip risk)
  return Math.round((bandPx / r.scale) / 0.72);
}

/** Corner radius (est.): fit circle to the top-left corner contour. Requires
 *  node fill ≠ surrounding bg (invisible radius is a cosmetic no-op → null). */
export async function estimateRadiusPt(r: Raster, opts: { bg: RGB }): Promise<number | null> {
  const center: RGB = px(r, Math.floor(r.width/2), Math.floor(r.height/2));
  if (dist(center, opts.bg) < 20) return null;
  // corner inset x(y) = r - sqrt(r² - (r-y)²); least-squares over candidates
  const rows: Array<[number, number]> = []; // [y_px, first_x_px_of_fill]
  const yMax = Math.min(r.height - 1, 120);
  for (let y = 0; y <= yMax; y++) {
    let xFill = -1;
    for (let x = 0; x < Math.min(r.width, 200); x++) if (dist(px(r, x, y), opts.bg) > 20) { xFill = x; break; }
    if (xFill >= 0) rows.push([y, xFill]);
  }
  if (rows.length < 4) return null;
  const maxY = rows[rows.length - 1]![0];
  if (maxY >= Math.min(r.height, 120) - 1 && rows[0]![1] > 2) return null; // square corner reached scan limit
  let bestR = -1, bestErr = Infinity;
  for (let rad = 2; rad <= 120; rad++) {
    let err = 0;
    for (const [y, xFill] of rows) {
      const yy = Math.min(y, rad);
      const expect = rad - Math.sqrt(Math.max(0, rad * rad - (rad - yy) * (rad - yy)));
      err += (xFill - expect) ** 2;
    }
    if (err < bestErr) { bestErr = err; bestR = rad; }
  }
  const rmse = Math.sqrt(bestErr / rows.length);
  if (rmse > 2.5) return null; // contour isn't a circular arc
  return Math.round((bestR / r.scale) * 10) / 10;
}
```

**Step 4 — PASS** (tune constants only if a tolerance legitimately fails; do not loosen assertions). **Step 5 — commit:** `feat(server): inspector size + radius estimators with honesty nulls`

### Task 4: DLS token matcher

**Files:**
- Create: `server/src/manual/dls-tokens.json` — seed format below; **[VERIFY] pull real hex values from the `lionparcel-dls` skill at implementation time, do not invent brand colors**
- Add to: `server/src/manual/inspect-sample.ts` + tests

```json
[
  { "token": "LP/Blue/500", "hex": "#2A6CDB", "note": "primary CTA — VERIFY against DLS" }
]
```

```ts
// nearestToken(hex): Lab ΔE via simple sRGB→Lab; match only when ΔE ≤ 10,
// else null (near-miss shows raw hex only — never a wrong token name).
export function nearestToken(hexIn: string): { token: string; dE: number } | null
```

Tests: exact match → ΔE 0; a clearly different color → null; close-but-out-of-threshold color → null. **Commit:** `feat(server): DLS token nearest-match with ΔE gate`

---

## Phase 3 — Server route

### Task 5: `POST /api/manual/:id/inspect-sample`

**Files:**
- Modify: `server/src/routes/manual.ts` (add route near `:id/tree`, line 239)
- Modify: `server/src/manual/session.ts` (expose a `inspectSample(sessionId, rect, logicalW)` in the same module family as the tree snapshot at line 307 — it owns lease + dispatch seams)
- Test: `server/test/inspect-sample-route.test.ts`

**Contract:**

```
POST /api/manual/:id/inspect-sample  { rect: {x,y,width,height}, logicalW: number, nodeType?: string }
→ 200 { ok: true, sample: {
      text:   { color: '#EEEEEE', token?: 'LP/Paper', sizePt?: 17 } | null,
      fill:   { color: '#2A6CDB', token?: 'LP/Blue/500' } | null,
      radius: { pt: 8 } | null,
      scale: 3, capturedAt: <epoch ms> } }
→ 409 LEASE_LOST / 503 dispatch-failed (honest, mirrors /tree error family)
```

Flow: validate session + lease (copy the `/tree` handler's guards at `routes/manual.ts:239` and `session.ts:307-322`) → `dispatchWithHeal('alloy_screenshot', {udid})` → `sharp(path)` decode → `scale = info.width / logicalW` → extract rect region `× scale` (clamp to image bounds) → run Task 2–4 estimators (bg for radius = ring sampled just OUTSIDE the node rect within the same screenshot) → respond. Delete nothing (screenshot artifacts follow existing retention).

Route test (no simulator): inject a fake dispatch dep returning a path to a sharp-generated fixture PNG (solid blue rounded rect + white text) — assert `sample.fill.color`, `sample.radius.pt ≈ 12`, `text.color`, and a **negative control**: unknown session → 409 family, dispatch failure → 503.

**Commit:** `feat(server): inspect-sample route — pixel estimates over alloy_screenshot seam`

---

## Phase 4 — Web UI

### Task 6: `useInspectProps` composable

**Files:**
- Create: `web/src/composables/useInspectProps.ts`

State: `mode: Ref<'inspect' | 'measure'>`, `showTree`, `showEstimates` (default **true**), `sample: Ref<Sample | null>`, `sampling: Ref<boolean>`, `sampleStale: Ref<boolean>`.
API: `toggleMode()`, `toggleTree()`, `toggleEstimates()`, `resample()`, `bindSelection(selNode, sessionId, treeState)`.

- `bindSelection` watches the re-resolved `selNode`: on node identity change → POST `/api/manual/:sid/inspect-sample` with the node's rect + `logicalW` (pass tree's logicalW in); debounce 250ms; on success store sample + `capturedAt`; on tree `realigning` → set `sampleStale = true`; when selection rect changes but identity survives (scroll re-resolve) → auto-`resample()`.
- Errors: `sampling=false`, sample keeps last-good + stale flag; **never** blank out geometry sections (they come from the tree, not the sampler).
- 410/409 handling mirrors the existing tree teardown comment in `DeviceSidebar.vue:163`.

### Task 7: `InspectRedlines.vue` (canvas overlay)

**Files:**
- Create: `web/src/components/InspectRedlines.vue`

Pure presentational SVG, same mount contract as `InspectOverlay` (rides the identical bezel-wrap pct rect, `viewBox="0 0 logicalW logicalH"`, `preserveAspectRatio="none"`, `pointer-events:none`). Props: `selected: AxNode|null`, `parent: AxNode|null`, `siblings: AxNode[]`, `mode: 'inspect'|'measure'`, `visible: boolean`.

- `mode='inspect'`: 4 ember hairlines from node edges to parent edges + pt caps (Figma measure style: 1px line, small end ticks, number chip centered on the line). Only draws sides where padding is non-null and > 0 (0-padding side → no line, value lives in the rail).
- `mode='measure'`: gap lines on the dominant axis to prev/next in-flow sibling (uses `dedupeExposures` + `siblingGaps`).
- Renders **only when** `visible && selected` (aligned tree — same honesty gate as the boxes).
- Cap chips: `<rect>` + `<text>` in SVG (no HTML overlay — zero layout drift), font 10px JetBrains Mono, ember bg, white text, `paint-order` for legibility.

### Task 8: `InspectTools.vue` (vertical tool rail)

**Files:**
- Create: `web/src/components/InspectTools.vue`

Props: `mode`, `showTree`, `showEstimates`, plus emitted events (`set-mode`, `toggle-tree`, `toggle-estimates`, `screenshot`, `copy`). Visual spec = A2 sketch CSS verbatim: 44px wide, carbon bg, 32px icon buttons, 3 groups separated by hairlines, active = ember inset-left bar, tooltip right of icon (name + shortcut), flip **left** when rendered in the DeviceSidebar (prop `tooltipSide: 'left'|'right'`). Inline SVG icons from the sketch (cursor/measure/tree/estimate-info/camera/copy).

**Step 0 (before wiring):** `grep -n "case 'm'\|case 't'\|case 'e'\|case 's'\|key ===" web/src/components/DeviceSidebar.vue web/src/pages/DrivePage.vue` — resolve any collision found; documented outcome goes in the commit body.

### Task 9: `InspectProps.vue` (properties rail)

**Files:**
- Create: `web/src/components/InspectProps.vue`

Props: `node`, `parent`, `siblings`, `nodes` (for tree section), `sample`, `sampling`, `sampleStale`, `mode`, `showTree`, `showEstimates`, `treeState`; emits `select-node` (tree row click). Sections exactly per A2 sketch:

1. **header** — node type + hittable state (ember, uppercase) + label/name.
2. **tree** (collapsible via tool) — deduped rows: type ember + label + `w×h` right-aligned steel; click = `select-node`; hover = canvas ring is owned by parent (skip canvas sync in v1 — row click only).
3. **position & size** `◆ exact` — x/y/w/h 2-col grid (pt).
4. **spacing** `◆ exact` — 3×3 diagram (padding mode) or prev/next gaps (measure mode); nulls render `—`.
5. **typography** `◌ sampled` — color row (swatch + hex + `↳ token` when matched), size `17 (est.)`, weight/family `—`. When `showEstimates=false`: sampled values swap to `—` (keep rows — honesty stays visible).
6. **appearance** `◌ sampled` — fill (swatch/hex/token), corner radius chip `8 (est.)`.
7. **footer legend** — `◆ tree geometry · ◌ est. sampled 3× · — not knowable`.

States: no selection → empty-state hint ("click a node"); `sampling` → subtle shimmer on ◌ sections; `sampleStale` → amber note "moved — re-sample (r)". `r` key triggers resample (guarded: not while typing in input/textarea/contentEditable).

Width 272px standalone; **compact variant** (`compact` prop) for DeviceSidebar: single-column 196px — x/y/w/h as 2×2 grid of half-width cells, spacing diagram scaled to 24px cells, section paddings 8px. No horizontal overflow: `overflow-x: clip` + min-width 0 discipline (verify in Task 12 drills).

### Task 10: wire DrivePage

**Files:**
- Modify: `web/src/pages/DrivePage.vue`

Layout (flex row, canvas first): `[ canvas-wrap flex:1; min-width:0 ] [ InspectTools 44px ] [ InspectProps 272px ]` — rails `v-if="inspect"`, both `overflow-y:auto`, full height of the stage row. The canvas keeps its existing stream/jmuxer mount untouched (no re-parent of the video element — it must not remount: **verify stream survives rail toggle** in Task 12). Wire: selection → `useInspectProps.bindSelection`; keyboard (`m/t/e/s`, `⌘⇧C`, `r`) with typing guard; InspectRedlines mounted inside the same bezel-wrap pct rect as InspectOverlay. `⌘⇧C` → build spec JSON `{node: {type,label,frame}, padding, gaps, text:{color,sizePt(est),token?}, fill:{color,token?}, radius:{pt(est)}}` → `navigator.clipboard.writeText` → ember toast "spec copied".

**Commit:** `feat(web): drive-page inspector cluster — tools, props, redlines`

### Task 11: wire DeviceSidebar (compact)

**Files:**
- Modify: `web/src/components/DeviceSidebar.vue`

The existing "inspect" section (line ~899) extends below the canvas: `InspectTools` horizontal (`orientation="horizontal"`, tooltips flip left, sits under the canvas as a 36px icon row) + `InspectProps compact`. Same composable instance semantics as DrivePage (each surface owns one — sessions differ). Do NOT widen `.sb-body` or `--sidebar-w`. Stream canvas mount untouched.

**Commit:** `feat(web): device-sidebar compact inspector — tool row + props stack`

---

## Phase 5 — Verification

### Task 12: layout + behavior drills (browser, both surfaces)

Run against the live stack (API 9230 + wall 5230; sim 835EE2B0, Foodiary app):

1. **DrivePage layout matrix** — viewport 1280×800, 1440×900, 1920×1080: `document.documentElement.scrollWidth <= innerWidth` (no horizontal scroll); rails 44/272px exact; canvas never zero-width (≥ 240px); tooltip unclipped at top/bottom icon (flip logic); tool rail does not overlap hover-chip (z-index: chip 40, tools 50, tooltip 60).
2. **Stream continuity** — toggle inspect on/off ×3: video element identity survives (`WeakRef` check or `video.isConnected && same srcObject`); no `reconnecting` state.
3. **Behavior drill** — select button → redlines to parent + rail numbers match canvas-measured rects (pt within 1); `m` → sibling-gap lines; scroll (wheel) → realign → redlines re-render, sampleStale shows, `r` re-samples; `e` → est values → `—` and back; `t` → tree section, row click selects canvas node; `⌘⇧C` → clipboard JSON matches selected node; `s` → artifact written.
4. **Sidebar compact drill** — same matrix inside the 220px sidebar: no overflow-x, spacing diagram intact, tooltips flip left, all six tools reachable.
5. **Vision-verify** 2 screenshots (drive + sidebar) against the A2 sketch — proportions/colors match; record results.
6. **Honesty audit** — sampled values on: solid text node (all values), photo row (fill `—`), multi-line text (size `—`) — confirm nulls render as `—`, never fabricated numbers.

### Task 13: checks + docs

1. `cd server && CI=true pnpm vitest run` — all green (baseline 581 + ~20 new).
2. `cd server && pnpm exec tsc --noEmit`.
3. `cd web && pnpm check` (vue-tsc + oxlint).
4. Update skill: `crucible` — extend `references/drive-inspect-mode.md` with the inspector cluster contract (rail layout, sampling honesty rules, shortcut map incl. resolved `i` conflict).
5. Docs commit (separate, per convention): this plan file + reference update.

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Sampling hits a moving screen (mid-animation) | Sample is a moment-in-time capture; `sampleStale` on realign + `r` resample; never auto-refresh silently |
| `alloy_screenshot` latency on every selection | Debounce 250ms; single in-flight request (abort previous); last-good retained |
| librsvg font rendering differs on CI | Sampling tests run via local vitest (macOS, Helvetica present); tolerances ±2pt; not CI-blocking |
| SVG text caps at tiny logical sizes | Caps drawn in viewBox units scale with canvas — verified in Task 12 at 1280 width |
| Sidebar 220px overflow | Compact variant + `overflow-x: clip` + drill matrix; no `--sidebar-w` change |
| Stream remount on rail mount | Rails are siblings of the stage, not ancestors — canvas never re-parents; drill #2 proves it |
| Token list guesses brand colors | `[VERIFY]` gate: values pulled from `lionparcel-dls` skill, reviewed in commit |

## Explicitly not doing (honesty over feature-count)

- Font **family/weight** from pixels — unknowable reliably; rows exist but read `—`.
- DYLD-injection exact values (Tier 3) — separate future spike.
- Auto token-refresh, cross-node diffing, spec export beyond clipboard JSON.
