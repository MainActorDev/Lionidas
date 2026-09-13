/** Inspector geometry: exact spacing facts from AX rects. Pure — no DOM, no pixels.
 *  Honesty: absence (missing rects, no in-flow neighbor) is NULL, never 0. */
import type { AxNode } from './ax-tree.js';

export interface Padding { top: number; right: number; bottom: number; left: number }

/** Edge distances from a node to its parent on all four sides (pt). */
export function paddingToParent(n: AxNode, parent: AxNode | null): Padding | null {
  if (!n.rect || !parent?.rect) return null;
  const r = n.rect;
  const p = parent.rect;
  return {
    top: r.y - p.y,
    right: p.x + p.width - (r.x + r.width),
    bottom: p.y + p.height - (r.y + r.height),
    left: r.x - p.x,
  };
}

/** Collapse SwiftUI double-exposure (e.g. heading `Other` + `StaticText` sharing
 *  an origin): keep the more specific node (labeled > unlabeled, StaticText > Other). */
export function dedupeExposures(nodes: AxNode[]): AxNode[] {
  const key = (n: AxNode) =>
    n.rect
      ? `${Math.round(n.rect.x)},${Math.round(n.rect.y)},${Math.round(n.rect.width)},${Math.round(n.rect.height)}`
      : `idx${n.index}`;
  const score = (n: AxNode) => (n.label ? 2 : 0) + (n.type === 'StaticText' ? 1 : 0);
  const best = new Map<string, AxNode>();
  for (const n of nodes) {
    const k = key(n);
    const cur = best.get(k);
    if (!cur || score(n) > score(cur)) best.set(k, n);
  }
  return [...best.values()];
}

export interface Gaps { axis: 'x' | 'y'; prev: number | null; next: number | null }

/** Gaps to adjacent IN-FLOW siblings on the dominant axis. In-flow = shares the
 *  cross-axis span AND does not intersect the target (intersection = overlay/
 *  carousel → excluded; overlap must never produce a negative gap). No sibling → null. */
export function siblingGaps(n: AxNode, siblings: AxNode[]): Gaps | null {
  if (!n.rect || siblings.length === 0) return null;
  const r = n.rect;
  const ox = (s: AxNode) => overlapAxis(r.x, r.width, s.rect!.x, s.rect!.width);
  const oy = (s: AxNode) => overlapAxis(r.y, r.height, s.rect!.y, s.rect!.height);
  // column flow: stacked above/below (share x, no y intersection)
  const colMates = siblings.filter((s) => !!s.rect && ox(s) > 1 && oy(s) <= 1);
  // row flow: side by side (share y, no x intersection)
  const rowMates = siblings.filter((s) => !!s.rect && oy(s) > 1 && ox(s) <= 1);
  // dominant axis: larger group wins; tie → y (screens are column-first)
  const axis: 'x' | 'y' = rowMates.length > colMates.length ? 'x' : 'y';
  const mates = axis === 'y' ? colMates : rowMates;
  if (!mates.length) return null;
  if (axis === 'y') {
    const prev = mates
      .filter((s) => s.rect!.y + s.rect!.height <= r.y + 1)
      .sort((a, b) => b.rect!.y + b.rect!.height - (a.rect!.y + a.rect!.height))[0];
    const next = mates
      .filter((s) => s.rect!.y >= r.y + r.height - 1)
      .sort((a, b) => a.rect!.y - b.rect!.y)[0];
    return {
      axis,
      prev: prev ? r.y - (prev.rect!.y + prev.rect!.height) : null,
      next: next ? next.rect!.y - (r.y + r.height) : null,
    };
  }
  const prev = mates
    .filter((s) => s.rect!.x + s.rect!.width <= r.x + 1)
    .sort((a, b) => b.rect!.x + b.rect!.width - (a.rect!.x + a.rect!.width))[0];
  const next = mates
    .filter((s) => s.rect!.x >= r.x + r.width - 1)
    .sort((a, b) => a.rect!.x - b.rect!.x)[0];
  return {
    axis,
    prev: prev ? r.x - (prev.rect!.x + prev.rect!.width) : null,
    next: next ? next.rect!.x - (r.x + r.width) : null,
  };
}

function overlapAxis(a: number, aw: number, b: number, bw: number): number {
  return Math.max(0, Math.min(a + aw, b + bw) - Math.max(a, b));
}

/** ── P2.5 geometric re-parent (experimental) ─────────────────────────────
 *  AX lineage lies for spacing: SwiftUI layout containers often expose no
 *  element, or a wrapper whose rect is just the union of children; one
 *  extra `Other` on one element breaks same-parent siblinghood. Container
 *  := smallest node whose rect strictly encloses n's (EQUAL rects — the
 *  SwiftUI double-exposure / label-propagation chains — never parent each
 *  other). Lineage is demoted to a fallback for root-level nodes. */
export function enclosureParent(nodes: AxNode[], n: AxNode): AxNode | null {
  if (!n.rect) return null;
  const r = n.rect;
  let best: AxNode | null = null;
  let bestArea = Infinity;
  for (const o of nodes) {
    if (o === n || !o.rect) continue;
    const b = o.rect;
    const strictlyBigger = b.width > r.width || b.height > r.height;
    if (!strictlyBigger) continue; // equal-or-smaller: exposure twin or child
    if (b.x <= r.x && b.y <= r.y && b.x + b.width >= r.x + r.width && b.y + b.height >= r.y + r.height) {
      const area = b.width * b.height;
      if (area < bestArea) { best = o; bestArea = area; }
    }
  }
  return best;
}

/** Geometric siblings: nodes whose enclosureParent is the SAME node as
 *  n's. Root-level nodes (no enclosing node) fall back to lineage peers. */
export function enclosureSiblings(nodes: AxNode[], n: AxNode): AxNode[] {
  if (!n.rect) return [];
  const parent = enclosureParent(nodes, n);
  if (!parent) {
    return n.parentIndex === undefined ? [] : nodes.filter((m) => m !== n && m.parentIndex === n.parentIndex);
  }
  return nodes.filter((m) => m !== n && m.rect && enclosureParent(nodes, m) === parent);
}
