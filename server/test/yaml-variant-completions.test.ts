/** Phase B T4 — variant autocomplete: slot classification for the three
 *  new contexts + completions (skeletons, scenario vocab, variant-id vocab). */
import { describe, it, expect } from 'vitest';
import { slotAt } from '@crucible/shared/yaml-slots';
import { buildCompletions } from '@crucible/shared/yaml-completions';

const DOC = `name: x
variants:
  - id: active
    networkScenario: account-active
    env:
      expected_title: "A"
  - id: pending
    networkScenario:
steps:
  - tap: { point: [1, 2] }
`;

const at = (line: number, col: number): number => {
  // line/col are 1-based; col = characters into the line
  const lines = DOC.split('\n');
  let off = 0;
  for (let i = 0; i < line - 1; i++) off += lines[i]!.length + 1;
  return off + col;
};

describe('slotAt — variant contexts', () => {
  it('classifies variant-id after "- " inside the variants block', () => {
    // cursor right after "  - " on the pending line
    expect(slotAt(DOC, at(7, 5))).toBe('variant-id');
  });
  it('classifies variant-key on a 4-indent key line inside a variant', () => {
    // typing at "    netw|" on the pending variant's networkScenario line (line 8)
    expect(slotAt(DOC, at(8, 8))).toBe('variant-key');
  });
  it('classifies scenario-name after "networkScenario: "', () => {
    // end of line 8: "    networkScenario:" with cursor after the colon
    expect(slotAt(DOC, at(8, 20))).toBe('scenario-name');
  });
  it('does NOT leak variant slots into steps (block scope ends at steps:)', () => {
    // "- " of the tap step line (line 10, after "  - ")
    expect(slotAt(DOC, at(10, 3))).not.toBe('variant-id');
    expect(slotAt(DOC, at(10, 3))).toBe('step-action');
  });
  it('top-key still works above the variants block', () => {
    expect(slotAt(DOC, at(1, 1))).toBe('top-key');
  });
});

describe('buildCompletions — variant slots', () => {
  const vocab = {
    selectors: [],
    caseNames: [],
    apps: [],
    tags: [],
    scenarios: ['account-active', 'checkout-3g'],
    variantIds: ['active', 'pending', 'rejected'],
  };

  it('variant-key offers the three sibling keys', () => {
    const cs = buildCompletions('variant-key', vocab, '');
    expect(cs.map((c) => c.label)).toEqual(['id', 'networkScenario', 'env']);
  });

  it('scenario-name offers vocabulary scenarios', () => {
    const cs = buildCompletions('scenario-name', vocab, '');
    expect(cs.map((c) => c.label)).toEqual(['account-active', 'checkout-3g']);
  });

  it('variant-id offers vocabulary ids; missing vocab degrades to empty (grammar-only safe)', () => {
    expect(buildCompletions('variant-id', vocab, '').map((c) => c.label)).toEqual(['active', 'pending', 'rejected']);
    expect(buildCompletions('variant-id', { selectors: [], caseNames: [], apps: [], tags: [] }, '')).toEqual([]);
  });

  it('top-key includes the variants skeleton', () => {
    const cs = buildCompletions('top-key', vocab, '');
    const v = cs.find((c) => c.label === 'variants')!;
    expect(String(v.apply)).toContain('- id: ');
    expect(String(v.apply)).toContain('networkScenario:');
  });
});
