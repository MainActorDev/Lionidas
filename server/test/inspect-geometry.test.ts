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
    expect(paddingToParent({ index: 1 }, node(0, 0, 0, 10, 10))).toBeNull();
  });
  it('null when parent absent', () => {
    expect(paddingToParent(node(1, 0, 0, 1, 1), null)).toBeNull();
  });
});

describe('siblingGaps', () => {
  it('column layout: prev/next vertical gaps', () => {
    const target = node(2, 0, 110, 100, 40, 0);
    const sibs = [node(1, 0, 50, 100, 40, 0), node(3, 0, 160, 100, 40, 0)];
    expect(siblingGaps(target, sibs)).toEqual({ axis: 'y', prev: 20, next: 10 });
  });
  it('row layout detected via x-overlap', () => {
    const target = node(2, 120, 0, 40, 40, 0);
    const sibs = [node(1, 60, 0, 40, 40, 0), node(3, 200, 0, 40, 40, 0)];
    expect(siblingGaps(target, sibs)).toEqual({ axis: 'x', prev: 20, next: 40 });
  });
  it('overlapping (out-of-flow) sibling excluded from gap math', () => {
    const target = node(2, 0, 110, 100, 40, 0);
    const sibs = [node(1, 0, 50, 100, 40, 0), node(3, 10, 120, 80, 20, 0)]; // 3 intersects target
    expect(siblingGaps(target, sibs)).toEqual({ axis: 'y', prev: 20, next: null });
  });
  it('null when no siblings', () => {
    expect(siblingGaps(node(2, 0, 0, 10, 10), [])).toBeNull();
  });
  it('null when target rect missing', () => {
    expect(siblingGaps({ index: 2, parentIndex: 0 }, [node(1, 0, 0, 10, 10)])).toBeNull();
  });
});

describe('dedupeExposures', () => {
  it('same-origin double exposure collapses to the more specific node', () => {
    const nodes = [node(1, 16, 84, 218, 22, 0), node(2, 16, 84, 218, 22, 0, 'StaticText')];
    const out = dedupeExposures(nodes);
    expect(out).toHaveLength(1);
    expect(out[0]!.type).toBe('StaticText');
  });
  it('labeled Other beats unlabeled StaticText on identical rects', () => {
    const nodes = [node(1, 0, 0, 50, 50, 0, 'Other'), node(2, 0, 0, 50, 50, 0, 'StaticText')];
    const a = dedupeExposures(nodes);
    const labeled = [node(1, 0, 0, 50, 50, 0, 'Other'), { ...node(2, 0, 0, 50, 50, 0, 'StaticText'), label: 'Save' }];
    const b = dedupeExposures(labeled);
    // unlabeled tie → StaticText wins (more specific); labeled StaticText wins outright
    expect(a[0]!.type).toBe('StaticText');
    expect(b[0]!.label).toBe('Save');
  });
  it('distinct rects all survive', () => {
    const nodes = [node(1, 0, 0, 10, 10, 0), node(2, 0, 20, 10, 10, 0)];
    expect(dedupeExposures(nodes)).toHaveLength(2);
  });
});
