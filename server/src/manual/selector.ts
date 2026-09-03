/** A6 element selectors: captured at record time from the live hierarchy,
 *  resolved at playback. Chain: identifier (icons) → label+type (SwiftUI
 *  text) → coordinates (last-resort fallback, scaled cross-device). */
export interface StepSelector { identifier?: string; label?: string; type?: string }

export interface SnapNode {
  index?: number; parentIndex?: number; type?: string; label?: string;
  identifier?: string; hittable?: boolean;
  rect?: { x: number; y: number; width: number; height: number };
}

function contains(n: SnapNode, x: number, y: number): boolean {
  const r = n.rect;
  return !!r && x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;
}

/** Deepest hittable node containing (x,y); walks up through ancestors that
 *  carry no label AND no identifier until something addressable is found.
 *  Container guard: stops the walk BEFORE screen-sized ancestors — without
 *  it a tap on unlabeled chrome resolves to the app root / page container
 *  and playback taps its center, far from the recorded point (found live:
 *  tnc template taps redirected to the app-root center). */
export function captureSelectorAt(nodes: SnapNode[], x: number, y: number): StepSelector | null {
  const hits = nodes.filter((n) => n.hittable && contains(n, x, y));
  if (hits.length === 0) return null;
  let node: SnapNode | undefined = hits.reduce((small, n) =>
    (n.rect!.width * n.rect!.height < small.rect!.width * small.rect!.height ? n : small));
  while (node && !node.identifier && !node.label) {
    const parent = nodes.find((n) => n.index === node!.parentIndex);
    if (!parent || !contains(parent, x, y)) break;
    node = parent;
  }
  if (!node || (!node.identifier && !node.label)) return null;
  if (isContainerNode(node)) return null; // screen-sized: a coordinate tap is MORE precise
  const sel: StepSelector = {};
  if (node.identifier) sel.identifier = node.identifier;
  if (node.label) sel.label = node.label;
  if (node.type) sel.type = node.type;
  return sel;
}

/** A screen-covering or near-screen ancestor: tapping its center is never
 *  the recorded intent — recorded coordinates carry the intent instead. */
function isContainerNode(n: SnapNode): boolean {
  const r = n.rect;
  if (!r) return false;
  if (n.type === 'Application') return true;
  return r.width >= 400 && r.height >= 600;
}

/** Shared match PREDICATE — one definition of "this node satisfies this
 *  selector" for both resolution (tapping) and existence assertions.
 *  Pool POLICIES differ deliberately: resolveSelector prefers hittable
 *  nodes (it taps); countMatches counts ALL matches (asserting non-hittable
 *  StaticText content is legitimate). One predicate, two policies. */
export function matchesSelector(n: SnapNode, sel: StepSelector): boolean {
  return (sel.identifier === undefined || n.identifier === sel.identifier) &&
    (sel.label === undefined || n.label === sel.label) &&
    (sel.type === undefined || n.type === sel.type);
}

/** Existence-assertion counter: how many nodes satisfy the selector. */
export function countMatches(nodes: SnapNode[], sel: StepSelector): number {
  return nodes.filter((n) => matchesSelector(n, sel)).length;
}

/** Unique hittable match → its rect center. null = gone or ambiguous
 *  (caller falls back to coordinates and logs it). Containers (app root,
 *  screen-covering pages) are rejected: their center is never the recorded
 *  intent — legacy templates recorded them before the capture guard. */
export function resolveSelector(nodes: SnapNode[], sel: StepSelector): { x: number; y: number } | null {
  const matches = nodes.filter((n) => matchesSelector(n, sel));
  const hittable = matches.filter((n) => n.hittable && n.rect);
  const pool = hittable.length > 0 ? hittable : matches.filter((n) => n.rect);
  if (pool.length !== 1) return null;
  const node = pool[0]!;
  if (isContainerNode(node)) return null; // coordinate fallback is more precise
  const r = node.rect!;
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
}
