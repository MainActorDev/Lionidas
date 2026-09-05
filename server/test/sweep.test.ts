import { describe, it, expect } from 'vitest';
import { sweepTriggered, probePoints, blindContainerAt, sweepFind } from '../src/manual/sweep.ts';
import type { SnapNode } from '../src/manual/selector.ts';

/** Real-world fixture: the LP home screen tab bar as the walk renders it —
 *  one childless AXGroup, buttons invisible to the tree. */
const tabbarFixture = (): SnapNode[] => [
  { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 393, height: 852 } },
  { index: 1, parentIndex: 0, type: 'Other', label: 'Lion Parcel', rect: { x: 0, y: 0, width: 393, height: 700 } },
  // the blind container: 393 wide, zero children in the tree
  { index: 2, parentIndex: 0, type: 'Other', rect: { x: 0, y: 700, width: 393, height: 120 } },
];

describe('sweepTriggered', () => {
  it('fires inside a childless wide container (tab-bar blindness)', () => {
    expect(sweepTriggered(tabbarFixture(), 190, 760)).toBe(true);
  });

  it('silent on a healthy tree (labeled node covers the point)', () => {
    const healthy: SnapNode[] = [
      { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 393, height: 852 } },
      { index: 1, parentIndex: 0, type: 'Button', label: 'Beranda', hittable: true, rect: { x: 20, y: 730, width: 80, height: 40 } },
      { index: 2, parentIndex: 0, type: 'Other', rect: { x: 0, y: 700, width: 393, height: 120 } },
    ];
    expect(sweepTriggered(healthy, 60, 750)).toBe(false);
  });

  it('silent when the point is outside every container (genuine empty screen area)', () => {
    expect(sweepTriggered(tabbarFixture(), 190, 400)).toBe(false); // inside labeled content area
  });

  it('silent for narrow childless containers (not the blindness shape)', () => {
    const narrow: SnapNode[] = [
      { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 393, height: 852 } },
      { index: 1, parentIndex: 0, type: 'Other', rect: { x: 150, y: 400, width: 90, height: 40 } },
    ];
    expect(sweepTriggered(narrow, 190, 415)).toBe(false);
  });
});

describe('blindContainerAt', () => {
  it('returns the smallest blind container (tightest stencil)', () => {
    const nodes = tabbarFixture();
    // add a WIDER blind ancestor — stencil must use the tab bar, not the screen
    const withWide: SnapNode[] = [...nodes, { index: 3, parentIndex: 0, type: 'Other', rect: { x: 0, y: 600, width: 393, height: 252 } }];
    const c = blindContainerAt(withWide, 190, 760);
    expect(c?.rect?.y).toBe(700); // the 120pt tab bar, not the 252pt region
  });

  it('null when a labeled node covers the point', () => {
    const healthy: SnapNode[] = [
      { index: 0, type: 'Button', label: 'OK', hittable: true, rect: { x: 100, y: 100, width: 60, height: 40 } },
    ];
    expect(blindContainerAt(healthy, 130, 120)).toBe(null);
  });
});

describe('probePoints', () => {
  it('5-point stencil: center + quarters, clamped inside', () => {
    const pts = probePoints({ x: 0, y: 700, width: 393, height: 120 });
    expect(pts).toHaveLength(5);
    expect(pts[0]).toEqual({ x: 196.5, y: 760 });
    for (const p of pts) {
      expect(p.x).toBeGreaterThanOrEqual(1);
      expect(p.x).toBeLessThanOrEqual(392);
      expect(p.y).toBeGreaterThanOrEqual(701);
      expect(p.y).toBeLessThanOrEqual(819);
    }
  });
});

describe('sweepFind', () => {
  const sel = { label: 'Pesanan' };

  it('first hit wins across the stencil', async () => {
    const probeFn = async (x: number, y: number): Promise<SnapNode[]> =>
      x > 250 && y > 700 ? [{ index: 0, type: 'Button', label: 'Pesanan', hittable: true, rect: { x: 260, y: 730, width: 80, height: 40 } }] : [];
    const hit = await sweepFind(probeFn, sel, probePoints({ x: 0, y: 700, width: 393, height: 120 }));
    expect(hit?.label).toBe('Pesanan');
  });

  it('all-miss ⇒ null (no false recovery)', async () => {
    const hit = await sweepFind(async () => [], sel, probePoints({ x: 0, y: 700, width: 393, height: 120 }));
    expect(hit).toBe(null);
  });

  it('a thrown probe skips to the next point, never kills the sweep', async () => {
    let calls = 0;
    const probeFn = async (x: number): Promise<SnapNode[]> => {
      calls++;
      if (calls <= 2) throw new Error('probe timeout');
      return x > 0 ? [{ index: 0, type: 'Button', label: 'Pesanan', rect: { x: 0, y: 0, width: 10, height: 10 } }] : [];
    };
    const hit = await sweepFind(probeFn, sel, probePoints({ x: 0, y: 0, width: 100, height: 100 }));
    expect(hit?.label).toBe('Pesanan');
    expect(calls).toBe(3);
  });

  it('non-matching views are ignored (selector predicate enforced)', async () => {
    const probeFn = async (): Promise<SnapNode[]> => [{ index: 0, type: 'Button', label: 'Something else', rect: { x: 0, y: 0, width: 10, height: 10 } }];
    const hit = await sweepFind(probeFn, sel, probePoints({ x: 0, y: 0, width: 100, height: 100 }));
    expect(hit).toBe(null);
  });
});
