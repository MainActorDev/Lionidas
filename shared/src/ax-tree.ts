/** AX tree utilities shared by the server engine and the web inspect overlay.
 *  ONE hit-test predicate for both — the overlay can never disagree with the
 *  recorder about "what is under this point". Moved verbatim from
 *  server/src/manual/selector.ts (2026-09-07, inspect-mode plan T1); the
 *  server re-exports these as captureSelectorAt/SnapNode so existing imports
 *  keep working, and an identity test pins the re-export. */

export interface AxNode {
  index?: number; parentIndex?: number; type?: string; label?: string;
  identifier?: string; hittable?: boolean;
  rect?: { x: number; y: number; width: number; height: number };
}

/** StepSelector shape (kept structurally identical to the engine's). */
export interface AxSelector { identifier?: string; label?: string; labelContains?: string; ignoreCase?: boolean; type?: string }

/** ONE definition of "looks like an asset identifier" — consumed by the YAML
 *  parser (via re-export) and selectorPreview so they can never drift. */
export const IDENTIFIER_RE = /^[a-z][a-z0-9_]*$/;

function contains(n: AxNode, x: number, y: number): boolean {
  const r = n.rect;
  return !!r && x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
}

/** A screen-covering or near-screen ancestor: tapping its center is never
 *  the recorded intent — recorded coordinates carry the intent instead. */
export function isContainerNode(n: AxNode): boolean {
  const r = n.rect;
  if (!r) return false;
  if (n.type === 'Application') return true;
  return r.width >= 400 && r.height >= 600;
}

/** Deepest hittable node containing (x,y); walks up through ancestors that
 *  carry no label AND no identifier until something addressable is found.
 *  Node-level: NO container/no-name rejection — the overlay may inspect any
 *  walked-to node. hitTestAt applies the selector-policy rejections. */
export function hitTestNodeAt(nodes: AxNode[], x: number, y: number): AxNode | null {
  const hits = nodes.filter((n) => n.hittable && contains(n, x, y));
  if (hits.length === 0) return null;
  let node: AxNode | undefined = hits.reduce((small, n) =>
    (n.rect!.width * n.rect!.height < small.rect!.width * small.rect!.height ? n : small));
  while (node && !node.identifier && !node.label) {
    const parent = nodes.find((n) => n.index === node!.parentIndex);
    if (!parent || !contains(parent, x, y)) break;
    node = parent;
  }
  return node ?? null;
}

/** EXACT captureSelectorAt semantics (engine selector policy): the node-level
 *  hit-test plus the rejections — unlabeled targets yield null (honest:
 *  nothing addressable), screen-sized containers yield null (a coordinate
 *  tap is MORE precise). */
export function hitTestAt(nodes: AxNode[], x: number, y: number): AxSelector | null {
  const node = hitTestNodeAt(nodes, x, y);
  if (!node || (!node.identifier && !node.label)) return null;
  if (isContainerNode(node)) return null;
  const sel: AxSelector = {};
  if (node.identifier) sel.identifier = node.identifier;
  if (node.label) sel.label = node.label;
  if (node.type) sel.type = node.type;
  return sel;
}

/** How a node would be addressed in YAML — the same heuristic the parser
 *  applies to `on:` values, so the preview IS what round-trips. */
export function selectorPreview(n: AxNode): { kind: 'identifier' | 'label' | 'type-only'; text: string } {
  if (n.identifier && IDENTIFIER_RE.test(n.identifier)) return { kind: 'identifier', text: n.identifier };
  if (n.label) return { kind: 'label', text: n.label };
  return { kind: 'type-only', text: n.type ?? 'unknown' };
}

/** Nodes worth drawing boxes for: has a rect, not a container, positive area.
 *  Smallest-area first (capped) so dense screens stay readable; hit-testing
 *  always sees the FULL array — rendering and hit-testing are decoupled. */
export function renderableNodes(nodes: AxNode[], limit = 600): AxNode[] {
  return nodes
    .filter((n) => n.rect && n.rect.width > 0 && n.rect.height > 0 && !isContainerNode(n))
    .sort((a, b) => (a.rect!.width * a.rect!.height) - (b.rect!.width * b.rect!.height))
    .slice(0, limit);
}

/** Node identity for RE-RESOLVING a selection (or hover) across tree refetches:
 *  the snapshot a surface keeps becomes stale the moment the tree realigns
 *  (scroll refetch) — re-locate the same element in the fresh array so the
 *  selection ring tracks the element, not the old rect.
 *  Match key: identifier > label+type. Rect proximity is a TIEBREAK only
 *  (SwiftUI same-rect double-exposure twins share label+type), never the
 *  primary key (screens legitimately repeat labels at distinct rects). */
export function sameNodeIn(nodes: AxNode[], stale: AxNode | null | undefined): AxNode | null {
  if (!stale) return null;
  const candidates = nodes.filter((n) =>
    stale.identifier
      ? n.identifier === stale.identifier
      : n.label !== undefined && n.label === stale.label && n.type === stale.type);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0] ?? null;
  // ambiguous (duplicate label/type): keep the node nearest the stale rect
  const r = stale.rect ?? { x: 0, y: 0, width: 0, height: 0 };
  const dist = (n: AxNode): number => {
    const a = n.rect, b = r;
    if (!a) return Infinity;
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  return candidates.reduce((best, n) => (dist(n) < dist(best) ? n : best));
}

/** Direct parent of n (via parentIndex) — null for roots/orphans. */
export function parentOf(nodes: AxNode[], n: AxNode): AxNode | null {
  if (n.parentIndex === undefined || n.parentIndex < 0) return null;
  return nodes.find((m) => m.index === n.parentIndex) ?? null;
}

/** In-flow siblings of n (same parent, not n itself) — for gap redlines. */
export function siblingsOf(nodes: AxNode[], n: AxNode): AxNode[] {
  if (n.parentIndex === undefined || n.parentIndex < 0) return [];
  return nodes.filter((m) => m !== n && m.parentIndex === n.parentIndex);
}
