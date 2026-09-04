/** A6 element selectors: captured at record time from the live hierarchy,
 *  resolved at playback. Chain: identifier (icons) → label+type (SwiftUI
 *  text) → coordinates (last-resort fallback, scaled cross-device). */
export interface StepSelector { identifier?: string; label?: string; labelContains?: string; ignoreCase?: boolean; type?: string }

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
  if (sel.identifier !== undefined && n.identifier !== sel.identifier) return false;
  const fold = (s: string): string => (sel.ignoreCase === true ? s.toLowerCase() : s);
  if (sel.labelContains !== undefined) {
    if (typeof n.label !== 'string' || !fold(n.label).includes(fold(sel.labelContains))) return false;
  } else if (sel.label !== undefined && fold(n.label ?? '') !== fold(sel.label)) return false;
  return sel.type === undefined || n.type === sel.type;
}

/** Human form of a selector for run steps/reasons: `contains: frag` for
 *  contains-mode, ` (ignore case)` suffix when the flag is set. ONE rule —
 *  playback stepName, fail reasons, and RunDetail all render through it. */
export function selectorLabel(sel: StepSelector): string {
  const base = sel.labelContains !== undefined ? `contains: ${sel.labelContains}` : sel.label ?? sel.identifier ?? '?';
  return sel.ignoreCase === true ? `${base} (ignore case)` : base;
}

/** Existence-assertion counter: how many DISTINCT elements satisfy the
 *  selector. SwiftUI double-exposes heading-like elements (a container
 *  `Other` node and its `StaticText` child share label AND top-left corner;
 *  only heights differ — measured live on the LP privacy-policy screen).
 *  That is one visual element, not ambiguity: matches starting at the same
 *  (x, y) collapse. Occurrences at different positions remain distinct —
 *  the honest ambiguity signal. */
export function countMatches(nodes: SnapNode[], sel: StepSelector): number {
  const matches = nodes.filter((n) => matchesSelector(n, sel));
  const origins = new Set<string>();
  for (const n of matches) {
    const r = n.rect;
    origins.add(r ? `${Math.round(r.x)},${Math.round(r.y)}` : `no-rect@${nodes.indexOf(n)}`);
  }
  return origins.size;
}

/** Nodes whose CENTER is not the recorded intent even when small:
 *  scroll containers, page-dot groups — multi-child wrappers whose center
 *  lands on a DIFFERENT control (live: 'Horizontal scroll bar, 1 page' at
 *  358×48 re-centred a tap onto the adjacent link). Hittable wrappers stay
 *  eligible in BOTH modes — their center IS their tap target. */
function isRecentreUnsafe(n: SnapNode): boolean {
  if (isContainerNode(n)) return true;
  if (/scroll bar|scrollbar/i.test(n.label ?? '')) return true;
  return n.type === 'Other' && n.hittable !== true;
}

/** Unique hittable match → its rect (center AND bounds, so callers can run a
 *  proximity check against the recorded point). null = gone or ambiguous
 *  (caller falls back to coordinates and logs it). Containers (app root,
 *  screen-covering pages) are rejected: their center is never the recorded
 *  intent — legacy templates recorded them before the capture guard.
 *  mode 'recentre' additionally rejects wrapper nodes whose center is some
 *  other control (isRecentreUnsafe) — playback's re-centre fallback must
 *  never aim at those; 'confirm' keeps them (presence checks are fine). */
export function resolveSelector(nodes: SnapNode[], sel: StepSelector, mode: 'confirm' | 'recentre' = 'confirm'): { x: number; y: number; rect: { x: number; y: number; width: number; height: number } } | null {
  const matches = nodes.filter((n) => matchesSelector(n, sel));
  const hittable = matches.filter((n) => n.hittable && n.rect);
  const pool = hittable.length > 0 ? hittable : matches.filter((n) => n.rect);
  if (pool.length !== 1) return null;
  const node = pool[0]!;
  if (mode === 'recentre' ? isRecentreUnsafe(node) : isContainerNode(node)) return null; // coordinate fallback is more precise
  const r = node.rect!;
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), rect: r };
}
