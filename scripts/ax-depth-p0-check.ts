// P0 corpus proof: run the REAL predicates against captured trees.
// Usage: node --experimental-strip-types scripts/ax-depth-p0-check.ts
import { readFileSync } from 'node:fs';
import { matchesSelector, countMatches, resolveSelector } from '../server/src/manual/selector.ts';

const load = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const foodiary = load('server/test/fixtures/ax-depth/foodiary-home/tree-alloy.json');
const lp = load('server/test/fixtures/ax-depth/lp-home-statusbar/tree-alloy.json');

// Case A — status-bar items absent from both trees
const sbLabels = (t: any) => t.nodes.filter((n: any) => n.label && /batter|battery|wi-?fi|\b\d{1,2}:\d{2}\b/i.test(n.label));
console.log('case A — status-bar items: LP home =', sbLabels(lp).length, '· Foodiary =', sbLabels(foodiary).length);

// Case B — heading double-exposure → ambiguity null on Foodiary
const sel = { label: 'MINGGU, 13 SEPTEMBER 2026' } as const;
const m = foodiary.nodes.filter((n: any) => matchesSelector(n, sel));
console.log('case B — heading: matches =', m.length, '· countMatches =', countMatches(foodiary.nodes, sel), '· resolveSelector =', resolveSelector(foodiary.nodes, sel));
