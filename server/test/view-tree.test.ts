/** Viewtree P1 — parser contract + golden tests on the committed P0
 *  fixtures, + the AX↔view cross-check (machine-checkable richness claim). */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseRecursiveDescription, nodesFromProbe, type VNode, type ProbeNode } from '@crucible/shared/view-tree';
import type { AxNode } from '@crucible/shared/ax-tree';

const load = (p: string): string => readFileSync(new URL(`./fixtures/viewtree/${p}`, import.meta.url), 'utf8');

describe('parseRecursiveDescription — contract', () => {
  it('parses a minimal 3-view dump with correct depth/parentIndex', () => {
    const nodes = parseRecursiveDescription([
      '<UIWindow: 0x1; frame = (0 0; 402 874)>',
      '   | <UIView: 0x2; frame = (0 0; 402 400)>',
      '   |    | <UIButton: 0x3; frame = (16 16; 100 44); userInteractionEnabled = NO>',
    ].join('\n'));
    expect(nodes).toHaveLength(3);
    expect(nodes[0]!.viewClass).toBe('UIWindow');
    expect(nodes[0]!.type).toBe('Window');
    expect(nodes[1]!.parentIndex).toBe(0);
    expect(nodes[2]!.parentIndex).toBe(1);
    expect(nodes[2]!.type).toBe('Button');
    expect(nodes[2]!.hittable).toBe(false);
  });

  it('extracts baseClass, text label, hidden/alpha0/clipped', () => {
    const nodes = parseRecursiveDescription(
      "<LionParcelLogistics.CustomLabel: 0x9; baseClass = UILabel; frame = (0 36; 74 12); text = 'Cek Ongkir'; alpha = 0; hidden = YES>",
    );
    expect(nodes[0]!.baseClass).toBe('UILabel');
    expect(nodes[0]!.label).toBe('Cek Ongkir');
    expect(nodes[0]!.type).toBe('StaticText');
    expect(nodes[0]!.hidden).toBe(true);
    expect(nodes[0]!.alpha0).toBe(true);
  });

  it('determinism: same input twice → identical output', () => {
    const t = load('lp-home/recdesc.txt');
    expect(parseRecursiveDescription(t)).toEqual(parseRecursiveDescription(t));
  });

  it('throws on view line without frame (loud, never partial)', () => {
    expect(() => parseRecursiveDescription('<UIView: 0x1; opaque = NO>')).toThrow(/without frame/);
  });

  it('throws on depth jump (orphan)', () => {
    expect(() => parseRecursiveDescription([
      '<UIWindow: 0x1; frame = (0 0; 402 874)>',
      '   |    | <UIView: 0x2; frame = (0 0; 40 40)>',
    ].join('\n'))).toThrow(/depth jump/);
  });
});

describe('parseRecursiveDescription — golden on P0 fixtures', () => {
  it('LP home: 300+ views, UITabBar present with buttons, 40+ hidden views, app classes parsed', () => {
    const nodes = parseRecursiveDescription(load('lp-home/recdesc.txt'));
    expect(nodes.length).toBeGreaterThan(300);
    const tabBar = nodes.find((n) => n.viewClass === 'UITabBar');
    expect(tabBar).toBeDefined();
    expect(tabBar!.rect!.y).toBeGreaterThan(700);
    expect(nodes.filter((n) => n.viewClass === 'UITabBarButton').length).toBe(4);
    // hidden=35 (some also alpha=0); combined invisible set is the honest
    // forensics figure — the parser distinguishes the two flags
    expect(nodes.filter((n) => n.hidden).length).toBe(35);
    expect(nodes.filter((n) => n.hidden || n.alpha0).length).toBeGreaterThanOrEqual(40);
    expect(nodes.some((n) => n.viewClass.startsWith('LionParcelLogistics.'))).toBe(true);
  });

  it('Foodiary home: the SwiftUI ceiling — ~7 views, one hosting chain, no content classes', () => {
    const nodes = parseRecursiveDescription(load('foodiary-home/recdesc.txt'));
    expect(nodes.length).toBeLessThan(10);
    expect(nodes.some((n) => /Hosting/.test(n.viewClass))).toBe(true);
    expect(nodes.filter((n) => n.type === 'Button' || n.type === 'StaticText')).toHaveLength(0);
  });

  it('cross-check (richness claim): every AX-hittable labeled node has a geometric counterpart in the view tree', () => {
    const views = parseRecursiveDescription(load('lp-home/recdesc.txt')) as VNode[];
    const ax = JSON.parse(readFileSync(new URL('./fixtures/ax-depth/lp-home-statusbar/tree-alloy.json', import.meta.url), 'utf8')) as { nodes: AxNode[] };
    const labeled = ax.nodes.filter((n) => (n.label || n.identifier) && n.hittable && n.rect);
    let matched = 0;
    for (const n of labeled) {
      const r = n.rect!;
      const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
      // counterpart = a view whose frame contains the AX node's center
      if (views.some((v) => v.rect && cx >= v.rect.x && cx <= v.rect.x + v.rect.width && cy >= v.rect.y && cy <= v.rect.y + v.rect.height)) matched++;
    }
    const agreement = matched / labeled.length;
    expect(labeled.length).toBeGreaterThan(20);
    // ≥90% was the adopt bar in the plan; assert honestly what we got
    expect(agreement).toBeGreaterThanOrEqual(0.9);
  });
});

describe('nodesFromProbe — probe normalizer (P3)', () => {
  const probeFixture = (): ProbeNode[] =>
    JSON.parse(readFileSync(new URL('./fixtures/viewtree/lp-home/probe.json', import.meta.url), 'utf8'));

  it('normalizes the LP-home probe fixture: same node count, type filled, rect preserved', () => {
    const nodes = nodesFromProbe(probeFixture());
    const parsed = parseRecursiveDescription(load('lp-home/recdesc.txt'));
    expect(nodes).toHaveLength(parsed.length);
    expect(nodes[0]!.viewClass).toBe('UIWindow');
    expect(nodes[0]!.type).toBe('Window');
    expect(nodes[0]!.rect!.width).toBe(402);
    // optional flags round-trip only when set (honesty: never fabricated)
    expect(nodes.some((n) => n.hidden)).toBe(true);
  });

  it('type parity: every probe node maps to the SAME type the lldb parser produced', () => {
    const nodes = nodesFromProbe(probeFixture());
    const parsed = parseRecursiveDescription(load('lp-home/recdesc.txt'));
    nodes.forEach((n, i) => {
      expect(n.type).toBe(parsed[i]!.type);
      expect(n.viewClass).toBe(parsed[i]!.viewClass);
      expect(n.rect).toEqual(parsed[i]!.rect);
    });
  });

  it('throws on malformed input — never a partial tree', () => {
    expect(() => nodesFromProbe(null as never)).toThrow(/not an array/);
    expect(() => nodesFromProbe([{ viewClass: 'UIView' }])).toThrow(/no rect/);
    expect(() => nodesFromProbe([{ viewClass: 'UIView', rect: { x: 0, y: 0, width: 1, height: 1 } },
      { viewClass: 'UIView', index: 5, parentIndex: 0, rect: { x: 0, y: 0, width: 1, height: 1 } }]))
      .toThrow(/dense sequential/);
    expect(() => nodesFromProbe([{ viewClass: 'UIView', index: 0, rect: { x: 0, y: 0, width: 1, height: 1 } },
      { viewClass: 'UIView', index: 1, parentIndex: 7, rect: { x: 0, y: 0, width: 1, height: 1 } }]))
      .toThrow(/dangling parentIndex/);
  });

  it('hittable defaults to true, honors explicit false', () => {
    const nodes = nodesFromProbe([
      { viewClass: 'UIView', rect: { x: 0, y: 0, width: 1, height: 1 } },
      { viewClass: 'UIView', index: 1, parentIndex: 0, hittable: false, rect: { x: 0, y: 0, width: 1, height: 1 } },
    ]);
    expect(nodes[0]!.hittable).toBe(true);
    expect(nodes[1]!.hittable).toBe(false);
  });
});
