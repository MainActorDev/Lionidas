/** AX-depth P0 corpus — RED baseline. Asserts TODAY's failures on committed
 *  fixtures; every assertion here must FAIL on a fixed tree (P1/P2 win
 *  condition). Cases + metadata: fixtures/ax-depth/<case>/case.json.
 *  Run live capture via scripts/ax-depth-p0-check.ts. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { countMatches, matchesSelector, resolveSelector } from '../src/manual/selector.js';
import { sweepTriggered } from '../src/manual/sweep.js';
import type { SnapNode } from '../src/manual/selector.js';

interface Fixture { nodes: SnapNode[]; logicalW: number; logicalH: number }
const load = (name: string): Fixture =>
  JSON.parse(readFileSync(new URL(`./fixtures/ax-depth/${name}/tree-alloy.json`, import.meta.url), 'utf8'));

describe('ax-depth corpus — RED baseline (asserts today\'s failures)', () => {
  const foodiary = load('foodiary-home');
  const lp = load('lp-home-statusbar');

  it('case A: no status-bar items in either tree (both apps)', () => {
    const sbItem = (n: SnapNode) =>
      !!n.label && /batter|battery|wi-?fi|\b\d{1,2}:\d{2}\b/i.test(n.label);
    expect(foodiary.nodes.some(sbItem)).toBe(false); // RED: depth must surface these
    expect(lp.nodes.some(sbItem)).toBe(false);
  });

  it('case B: SwiftUI label propagation → ambiguity null on the day header', () => {
    const sel = { label: 'MINGGU, 13 SEPTEMBER 2026' };
    expect(matchesSelector(foodiary.nodes[3]!, sel)).toBe(true); // the full-screen Other carries the label
    expect(resolveSelector(foodiary.nodes, sel)).toBeNull(); // RED: 4 hittable matches → null
  });

  it('case B footnote: countMatches origin-collapse undercounts (3 vs 4 matches)', () => {
    const real = { label: 'MINGGU, 13 SEPTEMBER 2026' };
    expect(countMatches(foodiary.nodes, real)).toBe(3);
  });

  it('negative control: stencil sweep does NOT fire on these healthy screens', () => {
    // no recorded-point-inside-blind-container situation exists on either
    // screen — sweepTriggered must stay quiet (guards over-eager fallbacks)
    const pts = [
      { x: 201, y: 437 }, { x: 201, y: 820 }, { x: 100, y: 300 }, { x: 350, y: 500 },
    ];
    for (const p of pts) expect(sweepTriggered(foodiary.nodes, p.x, p.y)).toBe(false);
    for (const p of pts) expect(sweepTriggered(lp.nodes, p.x, p.y)).toBe(false);
  });
});
