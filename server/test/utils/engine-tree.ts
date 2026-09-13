/** Engine-tree → SnapNode[] factory (AX-depth P2). Flattens the engine's
 *  NESTED describe_ui JSON ({tree:{children:[…]}}) into the FLAT array our
 *  predicates consume (index/parentIndex). Test util, NOT shipped — becomes
 *  shared/ code only if the P3 gate adopts the engine tree.
 *
 *  Conventions (pinned from P1 fixtures, 2026-09-13):
 *  - DFS pre-order; index = visit order; parentIndex = parent's index;
 *    root gets no parentIndex (matches alloy).
 *  - role → type via an EXPLICIT table; unmappable role THROWS (never
 *    silently drops — a poisoned tree is worse than a loud failure).
 *  - frame → rect (engine frames are already device points).
 *  - hittable := !hidden && enabled !== false (engine has no hittable;
 *    visible+enabled is the optimistic convention — divergence from
 *    alloy's conservatism is deliberate and measured in P2, not hidden).
 *  - Unknown extra fields pass through ignored; missing optional fields
 *    stay undefined (never 0/''). */
import type { SnapNode } from '../../src/manual/selector.js';

/** Roles observed in P1 fixtures: AXApplication, AXButton, AXGenericElement,
 *  AXGroup, AXImage, AXRadioButton, AXStaticText, AXTextField. Alloy types
 *  with NO AX counterpart (Window, ScrollView, TabBar, Table, Cell,
 *  CollectionView) simply never appear — type-agnostic selectors
 *  (label-only) are unaffected. */
const ROLE_TO_TYPE: Readonly<Record<string, string>> = {
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
    out.push({
      index: out.length,
      ...(parentIndex !== undefined ? { parentIndex } : {}),
      type,
      ...(n.label != null ? { label: n.label } : {}),
      ...(n.identifier != null ? { identifier: n.identifier } : {}),
      hittable: !(n.hidden === true) && n.enabled !== false,
      ...(n.frame ? { rect: { x: n.frame.x, y: n.frame.y, width: n.frame.width, height: n.frame.height } } : {}),
    });
    for (const c of n.children ?? []) visit(c, out.length - 1);
  };
  visit(root, undefined);
  return out;
}
