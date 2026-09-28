import { describe, it, expect } from 'vitest';
import { parseVariants } from '../../shared/src/yaml-variants.ts';
import { caseToYaml, parseCaseYaml } from '../../shared/src/case-yaml.ts';
import type { YamlError } from '../../shared/src/case-yaml.ts';

/** Plan 20260928T153608Z rev 2 stage 3 — variant-only `network:` pins. */

const errs: YamlError[] = [];

describe('variant network pin grammar', () => {
  it('parses network: on a variant; round-trips through case yaml', () => {
    const vs = parseVariants([{ id: 'slow', network: 'edge', networkScenario: 'countries-sg' }, { id: 'fast' }], errs);
    expect(vs?.[0]).toMatchObject({ id: 'slow', network: 'edge' });
    expect(vs?.[1]).toMatchObject({ id: 'fast' });
    const y = caseToYaml({ name: 'x', tags: [], steps: [{ idx: 0, action: 'tap', x: 1, y: 1 }], variants: vs as unknown[] });
    expect(y).toContain('network: edge');
    const back = parseCaseYaml(y);
    expect(back.ok).toBe(true);
    expect(back.case!.variants?.[0]).toMatchObject({ network: 'edge' });
  });

  it('rejects unknown profile ids with a naming error', () => {
    const e2: YamlError[] = [];
    const vs = parseVariants([{ id: 'x', network: 'dial-up' }], e2);
    expect(vs).toBeNull();
    expect(e2.some((e) => e.message.includes('unknown network profile "dial-up"'))).toBe(true);
  });

  it('accepts all seven presets', () => {
    const e2: YamlError[] = [];
    const vs = parseVariants(
      ['wifi', 'dsl', 'lte', '3g', 'edge', 'very-bad-network', '100-loss'].map((id, i) => ({ id: `v${i}`, network: id })),
      e2,
    );
    expect(e2).toEqual([]);
    expect(vs).toHaveLength(7);
  });
});
