/** P2 — predicate stress: engine trees (via factory) × the REAL predicates.
 *  Factory contract tests + the corpus green/red table, machine-checkable.
 *  Fixtures from P0/P1 (alloy + engine, same screens). */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { countMatches, resolveSelector } from '../src/manual/selector.js';
import { sweepTriggered } from '../src/manual/sweep.js';
import { engineTreeToSnapNodes } from './utils/engine-tree.js';
import type { SnapNode } from '../src/manual/selector.js';

const load = (p: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/ax-depth/${p}`, import.meta.url), 'utf8'));
const foodiaryEngine = engineTreeToSnapNodes(load('foodiary-home/tree-engine.json'));
const lpEngine = engineTreeToSnapNodes(load('lp-home-statusbar/tree-engine.json'));
const lpAlloy = (load('lp-home-statusbar/tree-alloy.json') as { nodes: SnapNode[] }).nodes;

describe('engine-tree factory contract', () => {
  it('flattens nested children to flat index/parentIndex (golden shape)', () => {
    expect(foodiaryEngine.length).toBeGreaterThan(10);
    const root = foodiaryEngine[0]!;
    expect(root.type).toBe('Application');
    expect(root.parentIndex).toBeUndefined();
    const nested = foodiaryEngine.find((n) => n.parentIndex === 0);
    expect(nested).toBeDefined();
    // parentIndex always refers to an earlier-visited node
    for (const n of foodiaryEngine) {
      if (n.parentIndex !== undefined) expect(n.parentIndex).toBeLessThan(n.index!);
    }
  });

  it('determinism: same JSON twice → identical arrays', () => {
    expect(engineTreeToSnapNodes(load('foodiary-home/tree-engine.json'))).toEqual(foodiaryEngine);
  });

  it('throws on unmappable role (never silent drop)', () => {
    const bad = { role: 'AXHoverCushion', children: [] };
    expect(() => engineTreeToSnapNodes(bad)).toThrow(/unmappable role/);
  });

  it('schema guard: unknown extra fields ignored; missing optionals undefined', () => {
    const one = engineTreeToSnapNodes({ role: 'AXButton', label: 'x', mystery: 42, children: [] });
    expect(one[0]!.label).toBe('x');
    expect(one[0]!.identifier).toBeUndefined();
    expect((one[0] as unknown as Record<string, unknown>).mystery).toBeUndefined();
  });
});

describe('P2 corpus — engine tree × real predicates', () => {
  it('case B: MINGGU resolves to ONE node (was null on alloy)', () => {
    const sel = { label: 'MINGGU, 13 SEPTEMBER 2026' };
    expect(countMatches(foodiaryEngine, sel)).toBe(1); // alloy: 3 (undercount)
    const r = resolveSelector(foodiaryEngine, sel);
    expect(r).not.toBeNull(); // alloy: null → coordinate fallback
    expect(r!.rect.height).toBeLessThan(40); // the real text, not a container
  });

  it('case A (foodiary): status-bar items resolvable', () => {
    const clock = { labelContains: 'battery' };
    expect(countMatches(foodiaryEngine, clock)).toBe(1); // alloy: 0
    const t = resolveSelector(foodiaryEngine, { labelContains: 'battery' });
    expect(t).not.toBeNull();
    expect(t!.y).toBeLessThan(60); // in the status-bar strip
  });

  it('count-regression axis: LP tab buttons DROP on engine tree (recorded, bounded)', () => {
    // alloy sees 4 tab buttons; engine full tree sees none (childless group).
    // Known P1 finding — the assertion documents it as a MEASURED regression,
    // and the hit-test seam covers it (see research note asymmetry #3).
    const tabs = { labelContains: 'Akun' };
    expect(countMatches(lpAlloy, tabs)).toBe(1);
    expect(countMatches(lpEngine, tabs)).toBe(0);
  });

  it('negative control: sweep does not fire on healthy engine trees', () => {
    const pts = [{ x: 201, y: 437 }, { x: 201, y: 820 }, { x: 100, y: 300 }, { x: 350, y: 500 }];
    for (const p of pts) expect(sweepTriggered(foodiaryEngine, p.x, p.y)).toBe(false);
    for (const p of pts) expect(sweepTriggered(lpEngine, p.x, p.y)).toBe(false);
  });

  it('isContainerNode rejects screen-sized nodes on engine trees', () => {
    const big = foodiaryEngine.filter((n) => n.rect && n.rect.width >= 400 && n.rect.height >= 600);
    expect(big.length).toBeGreaterThan(0);
    for (const n of big) {
      const sel = n.label !== undefined ? { label: n.label } : { identifier: n.identifier ?? 'none' };
      expect(resolveSelector(foodiaryEngine, sel, 'recentre')).toBeNull();
    }
  });
});
