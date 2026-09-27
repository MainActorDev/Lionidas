/** A6 element selectors: captured at record time from the live hierarchy,
 *  resolved at playback. Chain: identifier (icons) → label+type (SwiftUI
 *  text) → coordinates (last-resort fallback, scaled cross-device).
 *  The hit-test predicate, node type and container guard now live in
 *  @crucible/shared/ax-tree (ONE definition for engine + inspect overlay);
 *  they are re-exported below as their historical names so existing imports
 *  keep working — pinned by an identity test. */
import { hitTestAt, isContainerNode as isContainerNodeImpl, type AxNode, type AxSelector } from '@crucible/shared/ax-tree';

export type SnapNode = AxNode;
export type StepSelector = AxSelector;
export const captureSelectorAt = hitTestAt;
export const isContainerNode = isContainerNodeImpl;


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
  // Link aim: a WRAPPED link's rect spans every line it occupies — the
  // geometric center can sit on a DIFFERENT link's line (live 2026-09-26:
  // 'Terms & Conditions' two-line rect, center landed on the Privacy link
  // and the tnc case opened the wrong document). Aim at the link's text
  // START (first line) instead — deterministic for any wrap.
  if (node.type === 'Link') {
    // Aim at the LAST line: inline links flow AFTER surrounding plain text,
    // so the link's glyphs sit on the final line of its (possibly wrapped)
    // rect — the first line is often plain text (live 2026-09-26: tapping
    // the first line hit nothing; the glyphs were on line 2).
    return { x: Math.round(r.x + Math.min(r.width * 0.5, 60)), y: Math.round(r.y + r.height - Math.min(r.height * 0.25, 14)), rect: r };
  }
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), rect: r };
}
