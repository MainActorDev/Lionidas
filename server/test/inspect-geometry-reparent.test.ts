/** P2.5 — geometric re-parent evidence: property tests (invariants) + the
 *  honest 2×2 (lineage vs enclosure × alloy vs engine trees) on the P0/P1
 *  corpus fixtures with pixel ground truth measured from screenshots. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { paddingToParent, siblingGaps, enclosureParent, enclosureSiblings } from '@crucible/shared/inspect-geometry';
import { parentOf, siblingsOf } from '@crucible/shared/ax-tree';
import type { AxNode } from '@crucible/shared/ax-tree';

const node = (i: number, x: number, y: number, w: number, h: number, p?: number, type = 'Other'): AxNode =>
  ({ index: i, ...(p === undefined ? {} : { parentIndex: p }), type, rect: { x, y, width: w, height: h } });

describe('enclosureParent — properties', () => {
  it('finds the SMALLEST strictly-enclosing node (not the app root)', () => {
    // SwiftUI disease: card in a group (rect=union of children) inside app root
    const screen = node(0, 0, 0, 402, 874);
    const group = node(1, 16, 100, 370, 200, 0);
    const card = node(2, 32, 116, 180, 80, 1);
    expect(enclosureParent([screen, group, card], card)).toBe(group);
  });

  it('equal rects never parent each other (double-exposure guard)', () => {
    const a = node(1, 18, 92, 203, 13, 0, 'StaticText');
    const b = node(2, 18, 92, 203, 13, 1, 'Other'); // same rect, different node
    expect(enclosureParent([a, b], a)).toBeNull();
  });

  it('no enclosing rect → null (honesty, never the app root by accident)', () => {
    const screen = node(0, 0, 0, 402, 874);
    const top = node(1, 0, 0, 402, 874, 0); // same size as screen — NOT strictly bigger
    expect(enclosureParent([screen, top], top)).toBeNull();
  });
});

describe('enclosureSiblings — the reported complaint, synthetically', () => {
  it('two cards in one visible container become siblings despite broken lineage', () => {
    // complaint shape: same visual row, one card wrapped in an extra Other
    // with the SAME rect as its content (the real SwiftUI emission)
    const screen = node(0, 0, 0, 402, 874);
    const row = node(1, 16, 300, 370, 80, 0);
    const cardA = node(2, 16, 300, 180, 80, 1);
    const extraWrapper = node(3, 206, 310, 150, 60, 1); // equal-rect twin of cardB
    const cardB = node(4, 206, 310, 150, 60, 3); // nested one level deeper than cardA
    // LINEAGE says: cardA.siblings = [extraWrapper] (same parentIndex=1) — cardB is a nephew
    expect(siblingsOf([screen, row, cardA, extraWrapper, cardB], cardA)).not.toContain(cardB);
    // ENCLOSURE says: both cards live inside `row` → siblings (equal-rect
    // twins never parent each other)
    const sibs = enclosureSiblings([screen, row, cardA, extraWrapper, cardB], cardA);
    expect(sibs).toContain(cardB);
    expect(sibs).toContain(extraWrapper); // the twin rides along — gaps see the card, not nothing
    const gaps = siblingGaps(cardA, sibs);
    expect(gaps?.axis).toBe('x');
  });

  it('overlapping cards (carousel) stay NON-siblings under enclosure', () => {
    const screen = node(0, 0, 0, 402, 874);
    const pageA = node(1, 0, 200, 402, 400, 0);
    const pageB = node(2, 100, 200, 402, 400, 0); // overlaps A — different layer, not a row mate
    const target = node(3, 20, 220, 100, 50, 1);
    const sibs = enclosureSiblings([screen, pageA, pageB, target], target);
    expect(siblingGaps(target, sibs)).toBeNull(); // no in-flow mate ⇒ null (honest), never negative
  });
});

/** ── the 2×2 on corpus fixtures — HONEST RESULT ─────────────────────────
 *  Ground truth via vision on the committed Foodiary screenshot (3×):
 *  paragraph at px(111,1062)→pt(37,354); gradient card at px(54,515)→
 *  pt(18,172). Finding: the CARD HAS NO AX NODE (pure drawing) — so on
 *  this screen BOTH lineage and enclosure measure to the screen-covering
 *  content root (0,62,402,812): re-parenting is NOT the fix here. The
 *  mis-wiring class the synthetic tests prove IS fixed by enclosure; the
 *  absent-container class is unfixable from ANY tree (needs pixel-edge
 *  detection or the viewtree probe). Asserted below as measured. */
const load = (p: string): { nodes: AxNode[] } =>
  JSON.parse(readFileSync(new URL(`./fixtures/ax-depth/${p}`, import.meta.url), 'utf8'));

describe('P2.5 — 2×2: lineage vs enclosure × alloy vs engine (corpus)', () => {
  const alloy = load('foodiary-home/tree-alloy.json');
  const engineRaw = JSON.parse(readFileSync(new URL('./fixtures/ax-depth/foodiary-home/tree-engine.json', import.meta.url), 'utf8'));
  // engine tree is nested — quick flatten for this evidence run (factory
  // lives in server tests; graduating it is the adoption plan's step)
  const engine: AxNode[] = [];
  const walk = (n: Record<string, unknown>, parentIndex: number | undefined): void => {
    const idx = engine.length;
    const out: AxNode = {
      index: idx,
      type: String(n.role ?? 'Other').replace(/^AX/, '').replace('RadioButton', 'Button').replace('GenericElement', 'Other').replace('StaticText', 'StaticText'),
      hittable: true,
    };
    if (parentIndex !== undefined) out.parentIndex = parentIndex;
    if (n.label != null) out.label = String(n.label);
    const f = n.frame as { x: number; y: number; width: number; height: number } | undefined;
    if (f) out.rect = { x: f.x, y: f.y, width: f.width, height: f.height };
    engine.push(out);
    for (const c of ((n.children as Array<Record<string, unknown>>) ?? [])) walk(c, idx);
  };
  walk(engineRaw.tree ?? engineRaw, undefined);

  // target: the "Sarapan adalah slot…" StaticText (present in both trees)
  const pick = (nodes: AxNode[], prefix: string): AxNode => {
    const n = nodes.find((m) => (m.label ?? '').startsWith(prefix));
    if (!n) throw new Error(`fixture missing ${prefix}`);
    return n;
  };
  const prefix = 'Sarapan adalah slot';

  const evaluate = (nodes: AxNode[], n: AxNode, mode: 'lineage' | 'enclosure') => {
    const parent = mode === 'lineage' ? parentOf(nodes, n) : enclosureParent(nodes, n);
    const sibs = mode === 'lineage' ? siblingsOf(nodes, n) : enclosureSiblings(nodes, n);
    return { parent, pad: paddingToParent(n, parent), sibCount: sibs.length, gaps: siblingGaps(n, sibs) };
  };

  it('alloy lineage (today): padding measured against the screen-covering root — WRONG vs the visible card', () => {
    const n = pick(alloy.nodes, prefix);
    const r = evaluate(alloy.nodes, n, 'lineage');
    expect(r.pad).not.toBeNull();
    // lineage says top:290 left:37 (offset from content root at y:62/x:0).
    // vision ground truth vs the CARD: top ≈ 354−172 = 182, left ≈ 37−18 = 19.
    expect(r.pad!.top).toBe(290); // pinned: the wrong-to-card value, asserted
    expect(r.parent?.rect?.width).toBeGreaterThanOrEqual(400); // screen-covering
  });

  it('alloy enclosure: NO CHANGE on this screen — the card has no AX node (asserted, not hidden)', () => {
    const n = pick(alloy.nodes, prefix);
    const lin = evaluate(alloy.nodes, n, 'lineage');
    const enc = evaluate(alloy.nodes, n, 'enclosure');
    expect(enc.parent).toBe(lin.parent); // same node: smallest enclosing IS the content root
    expect(enc.pad).toEqual(lin.pad);
  });

  it('engine enclosure: same conclusion — absent container, not mis-wiring', () => {
    const nE = pick(engine, prefix);
    const enc = evaluate(engine, nE, 'enclosure');
    expect(enc.parent).not.toBeNull();
    // engine also has no card node; the paragraph sits at depth under the app
    expect(enc.parent?.rect?.height).toBeGreaterThan(700); // enclosing = screen-level
  });

  it('cross-tree agreement: the PARAGRAPH RECT agrees ±2pt (padding cannot — trees expose different screen-level roots, y:0 vs y:62)', () => {
    const nA = pick(alloy.nodes, prefix);
    const nE = pick(engine, prefix);
    expect(nA.rect).toBeDefined();
    expect(nE.rect).toBeDefined();
    expect(Math.abs(nE.rect!.y - nA.rect!.y)).toBeLessThanOrEqual(2);
    expect(Math.abs(nE.rect!.x - nA.rect!.x)).toBeLessThanOrEqual(2);
    const a = evaluate(alloy.nodes, nA, 'enclosure');
    const e = evaluate(engine, nE, 'enclosure');
    // both trees: enclosing container is screen-level (the absent-card finding)
    expect(a.parent?.rect?.height).toBeGreaterThan(700);
    expect(e.parent?.rect?.height).toBeGreaterThan(700);
  });
});
