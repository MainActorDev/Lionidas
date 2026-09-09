/** Sweep fallback — two-source truth for selector resolution (steal-list
 *  Tier 1.1/1.2). When the AX walk structurally cannot see a
 *  control (SwiftUI childless containers: tab bars, nav bars), probe the
 *  point hit-test instead. Pure functions — dispatch is injected. */
import { matchesSelector, type SnapNode, type StepSelector } from './selector.ts';

/** Is the sweep worth firing? True when the recorded point sits inside a
 *  container the tree rendered CHILDLESS (walk-blindness signal) of
 *  non-trivial width, with no labeled node already covering the point.
 *  Healthy trees never trigger; neither do genuine misses on visible
 *  labeled buttons (those resolve normally). */
export function sweepTriggered(nodes: SnapNode[], x: number, y: number): boolean {
  // a labeled node covering the point = the tree CAN see it — no sweep
  const covered = nodes.some(
    (n) => (n.label !== undefined || n.identifier !== undefined) && n.hittable !== false && covers(n, x, y),
  );
  if (covered) return false;
  // blindness signal: a childless container ≥200pt wide contains the point
  return nodes.some((n) => {
    if (!n.rect) return false;
    const childless = !nodes.some((c) => c.parentIndex === n.index);
    return childless && n.rect.width >= 200 && covers(n, x, y);
  });
}

function covers(n: SnapNode, x: number, y: number): boolean {
  const r = n.rect;
  return !!r && x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
}

/** 5-point stencil: center + quarter-points of the container's rect,
 *  clamped to stay inside. The stencil covers controls the walk missed
 *  inside the blind container. */
export function probePoints(rect: { x: number; y: number; width: number; height: number }): Array<{ x: number; y: number }> {
  const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const pts = [
    { x: cx, y: cy },
    { x: rect.x + rect.width * 0.25, y: rect.y + rect.height * 0.25 },
    { x: rect.x + rect.width * 0.75, y: rect.y + rect.height * 0.25 },
    { x: rect.x + rect.width * 0.25, y: rect.y + rect.height * 0.75 },
    { x: rect.x + rect.width * 0.75, y: rect.y + rect.height * 0.75 },
  ];
  return pts.map((p) => ({
    x: clamp(p.x, rect.x + 1, rect.x + rect.width - 1),
    y: clamp(p.y, rect.y + 1, rect.y + rect.height - 1),
  }));
}

/** The blind container covering the recorded point — whose rect the stencil
 *  probes. Null when the tree sees the point fine (no sweep case). */
export function blindContainerAt(nodes: SnapNode[], x: number, y: number): SnapNode | null {
  if (nodes.some((n) => (n.label !== undefined || n.identifier !== undefined) && n.hittable !== false && covers(n, x, y))) return null;
  const candidates = nodes.filter(
    (n) => n.rect && !nodes.some((c) => c.parentIndex === n.index) && n.rect.width >= 200 && covers(n, x, y),
  );
  if (candidates.length === 0) return null;
  // smallest blind container = tightest stencil
  return candidates.reduce((small, n) => (n.rect!.width * n.rect!.height < small.rect!.width * small.rect!.height ? n : small));
}

/** Run the stencil probes; first node satisfying the selector wins.
 *  probeFn returns the interactable view AT a point (may be empty). */
export async function sweepFind(
  probeFn: (x: number, y: number) => Promise<SnapNode[]>,
  sel: StepSelector,
  probes: Array<{ x: number; y: number }>,
): Promise<SnapNode | null> {
  for (const p of probes) {
    let views: SnapNode[];
    try {
      views = await probeFn(p.x, p.y);
    } catch {
      continue; // one dead probe never kills the sweep
    }
    const hit = views.filter((v) => matchesSelector(v, sel))[0];
    if (hit) return hit;
  }
  return null;
}
