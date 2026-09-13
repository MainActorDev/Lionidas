/** Engine-tree → SnapNode[] factory (AX-depth adoption T1; proven in the
 *  2026-09-13 spike, graduated from server/test/utils/). Flattens the
 *  engine's NESTED describe_ui JSON ({tree:{children:[…]}}) into the FLAT
 *  array the selector predicates consume (index/parentIndex).
 *
 *  Conventions (pinned from spike fixtures):
 *  - DFS pre-order; index = visit order; parentIndex = parent's index;
 *    root gets no parentIndex (matches alloy).
 *  - role → type via an EXPLICIT table; unmappable role THROWS (never
 *    silently drops — a poisoned tree is worse than a loud failure).
 *  - frame → rect (engine frames are already device points).
 *  - hittable := !hidden && enabled !== false (engine has no hittable;
 *    optimistic convention — divergence from alloy's conservatism is
 *    measured in the spike corpus, not hidden).
 *  - Unknown extra fields pass through ignored; missing optional fields
 *    stay undefined (never 0/''). */
import type { AxNode } from './ax-tree.js';

export type SnapNode = AxNode;

/** Roles observed in spike fixtures (iOS 27 / Xcode 26.4): AXApplication,
 *  AXButton, AXGenericElement, AXGroup, AXImage, AXRadioButton,
 *  AXStaticText, AXTextField. Alloy types with NO AX counterpart (Window,
 *  ScrollView, TabBar, Table, Cell, CollectionView) never appear —
 *  type-agnostic selectors (label-only) are unaffected. A new engine
 *  version surfacing a new role throws here — that's the upgrade signal. */
export const ROLE_TO_TYPE: Readonly<Record<string, string>> = {
  AXApplication: 'Application',
  AXButton: 'Button',
  AXGenericElement: 'Other',
  AXGroup: 'Other',
  AXImage: 'Image',
  AXRadioButton: 'Button',
  AXStaticText: 'StaticText',
  AXTextField: 'TextField',
};

interface EngineNode {
  role?: string; label?: string | null; identifier?: string | null;
  frame?: { x: number; y: number; width: number; height: number } | null;
  hidden?: boolean; enabled?: boolean; children?: EngineNode[];
  [k: string]: unknown;
}

export function engineTreeToSnapNodes(json: unknown): SnapNode[] {
  const root = (json as { tree?: EngineNode })?.tree ?? (json as EngineNode);
  if (!root || typeof root !== 'object') throw new Error('engine tree: no root node');
  const out: SnapNode[] = [];
  const visit = (n: EngineNode, parentIndex: number | undefined): void => {
    if (typeof n.role !== 'string') throw new Error(`engine tree: node without role at depth (label=${String(n.label)})`);
    const type = ROLE_TO_TYPE[n.role];
    if (type === undefined) throw new Error(`engine tree: unmappable role ${n.role}`);
    const node: SnapNode = { index: out.length, type, hittable: !(n.hidden === true) && n.enabled !== false };
    if (parentIndex !== undefined) node.parentIndex = parentIndex;
    if (n.label != null) node.label = n.label;
    if (n.identifier != null) node.identifier = n.identifier;
    if (n.frame) node.rect = { x: n.frame.x, y: n.frame.y, width: n.frame.width, height: n.frame.height };
    out.push(node);
    for (const c of n.children ?? []) visit(c, out.length - 1);
  };
  visit(root, undefined);
  return out;
}
