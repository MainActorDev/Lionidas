/** Phase B T1 — parseVariants contract: the 9 validation rules, the
 *  brief's 3-variant example, env-merge precedence. Pure module, no DB. */
import { describe, it, expect } from 'vitest';
import { parseVariants, mergeVariantEnv, VARIANT_ID_RE, type YamlVariant } from '@crucible/shared/yaml-variants';
import type { YamlError } from '@crucible/shared/case-yaml';

const parse = (raw: unknown): { variants: YamlVariant[] | null; errors: YamlError[] } => {
  const errors: YamlError[] = [];
  const variants = parseVariants(raw, errors);
  return { variants, errors };
};

describe('parseVariants — validation rules', () => {
  it('rule 1: non-list variants → shape error', () => {
    const r = parse({ id: 'active' });
    expect(r.variants).toBeNull();
    expect(r.errors[0]!.message).toMatch(/variants must be a list/);
  });

  it('rule 2: empty list → remove-the-key error', () => {
    const r = parse([]);
    expect(r.variants).toBeNull();
    expect(r.errors[0]!.message).toMatch(/needs at least one — remove the key/);
  });

  it('rule 3: non-mapping entry → error', () => {
    const r = parse(['active']);
    expect(r.variants).toBeNull();
    expect(r.errors[0]!.message).toMatch(/variant 1 must be a mapping/);
  });

  it('rule 4: bad id shape → error naming the shape and the value', () => {
    const r = parse([{ id: 'Active State' }]);
    expect(r.variants).toBeNull();
    expect(r.errors[0]!.message).toMatch(/variant 1: id must match \[a-z\]\[a-z0-9_-]\* \(got "Active State"\)/);
  });

  it('rule 4b: missing id → same error class', () => {
    const r = parse([{ networkScenario: 'x' }]);
    expect(r.variants).toBeNull();
    expect(r.errors[0]!.message).toMatch(/id must match/);
  });

  it('rule 5: duplicate id → error naming BOTH variants', () => {
    const r = parse([{ id: 'pending' }, { id: 'active' }, { id: 'pending' }]);
    expect(r.variants).toBeNull();
    expect(r.errors[0]!.message).toBe('variant 3: duplicate id "pending" (also variant 1)');
  });

  it('rule 6: unknown key → error with the right hint (scenario → networkScenario)', () => {
    const r = parse([{ id: 'a', scenario: 'x' }]);
    expect(r.variants).toBeNull();
    expect(r.errors[0]!.message).toMatch(/unknown key "scenario" — did you mean networkScenario\?/);
  });

  it('rule 6b: variables → env hint', () => {
    const r = parse([{ id: 'a', variables: {} }]);
    expect(r.errors[0]!.message).toMatch(/unknown key "variables" — did you mean env\?/);
  });

  it('rule 6c: arbitrary unknown key lists allowed keys', () => {
    const r = parse([{ id: 'a', timeout: 5 }]);
    expect(r.errors[0]!.message).toMatch(/unknown key "timeout" — allowed: id, networkScenario, env/);
  });

  it('rule 7: env with non-string value → error', () => {
    const r = parse([{ id: 'a', env: { n: 5 } }]);
    expect(r.variants).toBeNull();
    expect(r.errors[0]!.message).toMatch(/env must be a map of strings/);
  });

  it('rule 8: non-string networkScenario → error', () => {
    const r = parse([{ id: 'a', networkScenario: 42 }]);
    expect(r.variants).toBeNull();
    expect(r.errors[0]!.message).toMatch(/networkScenario must be a scenario name/);
  });

  it('rule 9: more than 12 variants → runaway guard', () => {
    const r = parse(Array.from({ length: 13 }, (_, i) => ({ id: `v${i}` })));
    expect(r.variants).toBeNull();
    expect(r.errors[0]!.message).toMatch(/too many variants \(13\) — max is 12/);
  });

  it('exactly 12 passes the guard', () => {
    const r = parse(Array.from({ length: 12 }, (_, i) => ({ id: `v${i}` })));
    expect(r.variants).toHaveLength(12);
    expect(r.errors).toHaveLength(0);
  });
});

describe('parseVariants — the brief\'s example (3 variants)', () => {
  it('parses verbatim: active/pending/rejected with scenario + env each', () => {
    const r = parse([
      { id: 'active', networkScenario: 'account-active', env: { expected_title: 'Account Active' } },
      { id: 'pending', networkScenario: 'account-pending', env: { expected_title: 'Verification Pending' } },
      { id: 'rejected', networkScenario: 'account-rejected', env: { expected_title: 'Account Rejected' } },
    ]);
    expect(r.errors).toHaveLength(0);
    expect(r.variants).toEqual([
      { id: 'active', networkScenario: 'account-active', env: { expected_title: 'Account Active' } },
      { id: 'pending', networkScenario: 'account-pending', env: { expected_title: 'Verification Pending' } },
      { id: 'rejected', networkScenario: 'account-rejected', env: { expected_title: 'Account Rejected' } },
    ]);
  });

  it('minimal shapes: id-only, env-only, scenario-only', () => {
    const r = parse([{ id: 'bare' }, { id: 'e', env: { k: 'v' } }, { id: 's', networkScenario: 'sc' }]);
    expect(r.variants).toEqual([
      { id: 'bare' },
      { id: 'e', env: { k: 'v' } },
      { id: 's', networkScenario: 'sc' },
    ]);
  });

  it('never partial: one bad entry nulls the whole list', () => {
    const r = parse([{ id: 'good' }, { id: 'BAD' }]);
    expect(r.variants).toBeNull();
  });
});

describe('mergeVariantEnv — Phase C precedence, settled in Phase B', () => {
  it('variant OVERRIDES invocation on key collision (narrowest scope wins)', () => {
    expect(mergeVariantEnv({ id: 'a', env: { title: 'from-variant' } }, { title: 'from-invocation' }))
      .toEqual({ title: 'from-variant' });
  });

  it('disjoint keys union', () => {
    expect(mergeVariantEnv({ id: 'a', env: { b: '2' } }, { a: '1' }))
      .toEqual({ a: '1', b: '2' });
  });

  it('null variant is a passthrough copy', () => {
    const inv = { x: '1' };
    const merged = mergeVariantEnv(null, inv);
    expect(merged).toEqual({ x: '1' });
    expect(merged).not.toBe(inv); // copy, not the same reference
  });

  it('variant without env is a passthrough copy', () => {
    expect(mergeVariantEnv({ id: 'a' }, { x: '1' })).toEqual({ x: '1' });
  });
});

describe('VARIANT_ID_RE', () => {
  it('accepts house-shaped ids, rejects the rest', () => {
    for (const good of ['a', 'active', 'account-status', 'v2', 'a_b', 'pending-2']) {
      expect(VARIANT_ID_RE.test(good), good).toBe(true);
    }
    for (const bad of ['', 'A', '2fast', 'has space', 'café', 'id:x']) {
      expect(VARIANT_ID_RE.test(bad), bad).toBe(false);
    }
  });
});
