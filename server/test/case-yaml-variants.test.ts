/** Phase B T2 — variants in case-yaml: parse + serialize round-trips,
 *  byte-stability for variantless cases, interleaving with alerts/setup. */
import { describe, it, expect } from 'vitest';
import { parseCaseYaml, caseToYaml } from '@crucible/shared/case-yaml';

const THREE = `name: Render account status
tags: [account, smoke]
variants:
  - id: active
    networkScenario: account-active
    env:
      expected_title: "Account Active"
  - id: pending
    networkScenario: account-pending
    env:
      expected_title: "Verification Pending"
  - id: rejected
    networkScenario: account-rejected
    env:
      expected_title: "Account Rejected"
steps:
  - tap: { point: [10, 20], on: Masuk }
  - expect: "\${expected_title}"
`;

describe('parseCaseYaml — variants key', () => {
  it('parses the brief\'s 3-variant case', () => {
    const r = parseCaseYaml(THREE);
    expect(r.ok).toBe(true);
    expect(r.case?.variants).toEqual([
      { id: 'active', networkScenario: 'account-active', env: { expected_title: 'Account Active' } },
      { id: 'pending', networkScenario: 'account-pending', env: { expected_title: 'Verification Pending' } },
      { id: 'rejected', networkScenario: 'account-rejected', env: { expected_title: 'Account Rejected' } },
    ]);
  });

  it('variant errors surface through the case parser with line info', () => {
    const r = parseCaseYaml('name: x\nvariants:\n  - id: BAD\nsteps:\n  - tap: { point: [1, 2] }\n');
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.message.includes('id must match'))).toBe(true);
  });

  it('explicit variants: null ≡ absent (same as tags)', () => {
    const r = parseCaseYaml('name: x\nvariants:\nsteps:\n  - tap: { point: [1, 2] }\n');
    expect(r.ok).toBe(true);
    expect(r.case?.variants).toBeUndefined();
  });

  it('unknown top-level keys are still ignored (unchanged behavior receipt)', () => {
    const r = parseCaseYaml('name: x\nfuture_key: whatever\nsteps:\n  - tap: { point: [1, 2] }\n');
    expect(r.ok).toBe(true);
  });
});

describe('caseToYaml — variants serialization', () => {
  it('round-trips: parse(caseToYaml(parsed)) preserves variants exactly', () => {
    const first = parseCaseYaml(THREE);
    expect(first.ok).toBe(true);
    const serialized = caseToYaml({
      name: first.case!.name,
      tags: first.case!.tags,
      ...(first.case!.variants ? { variants: first.case!.variants } : {}),
      steps: first.case!.steps as unknown[],
    });
    const second = parseCaseYaml(serialized);
    expect(second.ok).toBe(true);
    expect(second.case!.variants).toEqual(first.case!.variants);
    // and the second serialization is IDENTICAL (idempotent serialization)
    const reserialized = caseToYaml({
      name: second.case!.name, tags: second.case!.tags,
      ...(second.case!.variants ? { variants: second.case!.variants } : {}), steps: second.case!.steps as unknown[],
    });
    expect(reserialized).toBe(serialized);
  });

  it('variantless cases are byte-stable (compat receipt)', () => {
    const input = 'name: x\ntags: [a]\nsteps:\n  - tap: { point: [1, 2] }\n';
    const parsed = parseCaseYaml(input);
    expect(parsed.ok).toBe(true);
    // build the round-trip expectation FROM the serializer (not a hand-
    // written string) so serializer drift cannot pass vacuously
    const once = caseToYaml({ name: parsed.case!.name, tags: parsed.case!.tags, steps: parsed.case!.steps as unknown[] });
    const reparsed = parseCaseYaml(once);
    const twice = caseToYaml({ name: reparsed.case!.name, tags: reparsed.case!.tags, steps: reparsed.case!.steps as unknown[] });
    expect(twice).toBe(once);
    expect(once).not.toContain('variants');
  });

  it('serializes between alerts and setup (canonical order)', () => {
    const y = caseToYaml({
      name: 'x', tags: [],
      alerts: { entries: [['default', 'dismiss']] } as never,
      variants: [{ id: 'a', env: { k: 'v' } }],
      setup: [{ idx: 0, action: 'tap', x: 1, y: 2 }],
      steps: [{ idx: 0, action: 'tap', x: 3, y: 4 }],
    });
    const alertPos = y.indexOf('alerts:');
    const variantPos = y.indexOf('variants:');
    const setupPos = y.indexOf('setup:');
    const stepsPos = y.indexOf('steps:');
    expect(alertPos).toBeLessThan(variantPos);
    expect(variantPos).toBeLessThan(setupPos);
    expect(setupPos).toBeLessThan(stepsPos);
  });

  it('minimal variant shapes serialize losslessly (env-only, scenario-only, bare)', () => {
    const variants = [
      { id: 'bare' },
      { id: 'e', env: { k: 'v' } },
      { id: 's', networkScenario: 'sc' },
    ];
    const y = caseToYaml({ name: 'x', tags: [], variants, steps: [{ idx: 0, action: 'tap', x: 1, y: 2 }] });
    const back = parseCaseYaml(y);
    expect(back.ok).toBe(true);
    expect(back.case!.variants).toEqual(variants);
  });

  it('env values with ${…} refs stay quoted (yamlScalar brace rule)', () => {
    const y = caseToYaml({
      name: 'x', tags: [],
      variants: [{ id: 'a', env: { title: '${expected_title}' } }],
      steps: [{ idx: 0, action: 'tap', x: 1, y: 2 }],
    });
    expect(y).toContain("title: '${expected_title}'");
    const back = parseCaseYaml(y);
    expect(back.case!.variants![0]!.env).toEqual({ title: '${expected_title}' });
  });
});
