import { describe, it, expect } from 'vitest';
import {
  hitTestAt, hitTestNodeAt, isContainerNode, selectorPreview,
  renderableNodes, IDENTIFIER_RE, type AxNode,
} from '@crucible/shared/ax-tree';
// the engine's historical names — MUST be the same objects/functions (ONE predicate)
import { captureSelectorAt, type SnapNode } from '../src/manual/selector.ts';

function node(p: Partial<AxNode> & { index: number }): AxNode {
  return { hittable: true, ...p };
}

const screen = node({ index: 0, parentIndex: -1, type: 'Application', rect: { x: 0, y: 0, width: 428, height: 926 } });
const card = node({ index: 1, parentIndex: 0, type: 'Other', rect: { x: 16, y: 100, width: 396, height: 120 } });
const btn = node({ index: 2, parentIndex: 1, type: 'Button', identifier: 'home_login_bar_login_button', rect: { x: 300, y: 130, width: 100, height: 44 } });
const text = node({ index: 3, parentIndex: 1, type: 'StaticText', label: 'Sign Up', rect: { x: 32, y: 140, width: 80, height: 20 } });
const unlabeledIcon = node({ index: 4, parentIndex: 1, type: 'Image', rect: { x: 20, y: 110, width: 24, height: 24 }, hittable: false });

describe('hitTestAt — engine semantics preserved', () => {
  const nodes = [screen, card, btn, text, unlabeledIcon];

  it('smallest node wins → selector built from it', () => {
    const sel = hitTestAt(nodes, 350, 152); // inside btn (100x44)
    expect(sel).toEqual({ identifier: 'home_login_bar_login_button', type: 'Button' });
  });

  it('labeled text resolves to label selector', () => {
    expect(hitTestAt(nodes, 60, 150)).toEqual({ label: 'Sign Up', type: 'StaticText' });
  });

  it('walks up from unlabeled leaf to addressable ancestor', () => {
    // tiny unlabeled child inside btn: walk should reach btn
    const child = node({ index: 5, parentIndex: 2, type: 'Other', rect: { x: 310, y: 135, width: 10, height: 10 } });
    expect(hitTestAt([...nodes, child], 315, 140)?.identifier).toBe('home_login_bar_login_button');
  });

  it('container guard: unlabeled screen-sized target → null (coordinate more precise)', () => {
    const bare = node({ index: 9, parentIndex: -1, type: 'Other', rect: { x: 0, y: 0, width: 428, height: 926 } });
    expect(hitTestAt([bare], 200, 400)).toBeNull();
  });

  it('no hit at all → null', () => {
    expect(hitTestAt(nodes, 200, 900)).toBeNull();
  });

  it('IDENTITY: engine captureSelectorAt IS shared hitTestAt', () => {
    // the plan's one-predicate rule — if this breaks, engine and overlay drifted
    expect(captureSelectorAt).toBe(hitTestAt);
  });

  it('structural: SnapNode assignable from AxNode (shared type)', () => {
    const n: SnapNode = btn;
    expect(n.identifier).toBeTruthy();
  });
});

describe('hitTestNodeAt — node-level (overlay)', () => {
  const nodes = [screen, card, btn, text, unlabeledIcon];

  it('returns the NODE (not a selector) for overlay selection', () => {
    expect(hitTestNodeAt(nodes, 350, 152)?.identifier).toBe('home_login_bar_login_button');
  });

  it('overlay may inspect containers / unlabeled targets hitTestAt rejects', () => {
    const bare = node({ index: 9, parentIndex: -1, type: 'Other', rect: { x: 0, y: 0, width: 428, height: 926 } });
    expect(hitTestNodeAt([bare], 200, 400)).not.toBeNull();
  });
});

describe('selectorPreview — YAML round-trip heuristic', () => {
  it('snake_case identifier → identifier kind', () => {
    expect(selectorPreview(btn)).toEqual({ kind: 'identifier', text: 'home_login_bar_login_button' });
  });

  it('label fallback; type-only last resort', () => {
    expect(selectorPreview(text).kind).toBe('label');
    const bare = node({ index: 7, type: 'Button' });
    expect(selectorPreview(bare)).toEqual({ kind: 'type-only', text: 'Button' });
  });

  it('IDENTIFIER_RE matches asset ids, rejects human text', () => {
    expect(IDENTIFIER_RE.test('ic_tabbar_home')).toBe(true);
    expect(IDENTIFIER_RE.test('Sign Up')).toBe(false);
    expect(IDENTIFIER_RE.test('Camera')).toBe(false);
  });
});

describe('renderableNodes — box-drawing filter', () => {
  const noRect = node({ index: 10, type: 'StaticText', label: 'ghost' });

  it('drops containers, rectless, zero-area; smallest first', () => {
    const r = renderableNodes([screen, card, btn, text, unlabeledIcon, noRect]);
    expect(r.map((n) => n.index)).toEqual([4, 3, 2, 1]); // icon(24²), text(80x20), btn(100x44), card
    expect(r).not.toContain(screen);
  });

  it('caps at limit', () => {
    const many = Array.from({ length: 700 }, (_, i) => node({ index: 100 + i, rect: { x: i, y: 0, width: 5, height: 5 } }));
    expect(renderableNodes(many, 600)).toHaveLength(600);
  });
});

describe('isContainerNode', () => {
  it('Application type and near-screen rects are containers', () => {
    expect(isContainerNode(screen)).toBe(true);
    expect(isContainerNode(node({ index: 11, type: 'Other', rect: { x: 0, y: 0, width: 428, height: 650 } }))).toBe(true);
    expect(isContainerNode(btn)).toBe(false);
    expect(isContainerNode(node({ index: 12 }))).toBe(false); // no rect
  });
});
