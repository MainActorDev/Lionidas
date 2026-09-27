import { describe, it, expect } from 'vitest';
import { parseCaseYaml } from '@crucible/shared/case-yaml';

/** R2 S4 — case schema v2: R2 verbs parse; v1 cases parse byte-identically
 *  (the LIFT — v1 is one implicit screen, no behavior change). Save-time
 *  resolution (swaps/screens vs DB) is covered in case-v2-routes.test.ts. */

describe('S4 — R2 verb parsing', () => {
  it('arrive/refresh/swap parse as scalar screen/swap ids', () => {
    const r = parseCaseYaml([
      'name: v2case',
      'app: com.x.y',
      'steps:',
      '  - arrive: tracking',
      '  - refresh: tracking',
      '  - swap: my',
    ].join('\n'));
    expect(r.ok).toBe(true);
    expect(r.case!.steps.map((s) => [s.action, s.screen ?? s.swap])).toEqual([
      ['arrive', 'tracking'],
      ['refresh', 'tracking'],
      ['swap', 'my'],
    ]);
  });

  it('expect screen: positive and negated forms', () => {
    const r = parseCaseYaml([
      'name: v2case',
      'steps:',
      '  - expect screen: tracking.loaded',
      '  - expect screen: tracking.state != loading',
    ].join('\n'));
    expect(r.ok).toBe(true);
    expect(r.case!.steps[0]!.expectScreen).toEqual({ screen: 'tracking', state: 'loaded' });
    expect(r.case!.steps[1]!.expectScreen).toEqual({ screen: 'tracking', state: 'loading', negate: true });
  });

  it('malformed verbs rejected with direction: bad id, bad form, empty', () => {
    const r = parseCaseYaml([
      'name: v2case',
      'steps:',
      `  - arrive: 'Bad ID'`,
      '  - expect screen: tracking',
      '  - swap: ""',
    ].join('\n'));
    expect(r.ok).toBe(false);
    const msgs = r.errors.map((e) => e.message).join(' | ');
    expect(msgs).toContain('arrive takes a screen id');
    expect(msgs).toContain('expect screen');
    expect(msgs).toContain('swap takes a target id');
  });

  it('swaps: + entry: parse (swaps share the variant grammar); worlds: stays a parseable alias', () => {
    const r = parseCaseYaml([
      'name: v2case',
      'app: com.x.y',
      'entry: { screen: tracking, mode: deepLink }',
      'swaps:',
      '  - id: sg',
      '    scenarios: [countries-sg, auth-happy]',
      'steps:',
      '  - arrive: tracking',
    ].join('\n'));
    expect(r.ok).toBe(true);
    expect(r.case!.entry).toEqual({ screen: 'tracking', mode: 'deepLink' });
    expect(r.case!.swaps).toEqual([{ id: 'sg', scenarios: ['countries-sg', 'auth-happy'] }]);
    // deprecated alias: worlds: parses identically (old case versions)
    const legacy = parseCaseYaml([
      'name: legacy world case',
      'worlds:',
      '  - id: my',
      '    scenarios: [countries-my]',
      'steps:',
      '  - world: my',
    ].join('\n'));
    expect(legacy.ok).toBe(true);
    expect(legacy.case!.swaps).toEqual([{ id: 'my', scenarios: ['countries-my'] }]);
    // alias STEP also parses — normalized to swap in storage
    expect(legacy.case!.steps[0]).toMatchObject({ action: 'swap', swap: 'my' });
  });

  it('swap target colliding with variant id → error (one vocabulary)', () => {
    const r = parseCaseYaml([
      'name: v2case',
      'variants:',
      '  - id: dupe',
      'swaps:',
      '  - id: dupe',
      'steps:',
      '  - tap: { point: [1, 1], on: b }',
    ].join('\n'));
    expect(r.ok).toBe(false);
    expect(r.errors[0]!.message).toContain('also appears in variants');
  });

  it('entry validation: bad mode and bad screen id rejected', () => {
    const r1 = parseCaseYaml(['name: x', 'entry: { screen: s, mode: warp }', 'steps:', '  - tap: { point: [1, 1], on: b }'].join('\n'));
    expect(r1.ok).toBe(false);
    expect(r1.errors[0]!.message).toContain('entry.mode');
    const r2 = parseCaseYaml(['name: x', 'entry: { screen: Bad }', 'steps:', '  - tap: { point: [1, 1], on: b }'].join('\n'));
    expect(r2.ok).toBe(false);
    expect(r2.errors[0]!.message).toContain('entry must be');
  });
});

describe('S4 — the LIFT (v1 equivalence)', () => {
  // a real v1 case shape: setup + steps + variants (singular scenario), the
  // exact vocabulary that existed before S4. It must parse to the SAME
  // structure it always did — no swaps, no entry, no new-action leakage.
  const V1 = [
    'name: privacy policy',
    'app: com.lioparcel.services.consumer.int-dev',
    'alerts: dismiss',
    'setup:',
    '  - tap: { point: [212, 796], on: Continue without account, when: Continue without account }',
    'steps:',
    '  - tap: { point: [319, 865], on: ic_tabbar_account_inactive }',
    '  - scroll: down',
    '  - expect: { contains: DATA COLLECTION }',
    'variants:',
    '  - id: sg',
    '    networkScenario: countries-sg',
    '    env: { COUNTRY: Batam }',
  ].join('\n');

  it('v1 case parses identically — no v2 keys materialize', () => {
    const r = parseCaseYaml(V1);
    expect(r.ok).toBe(true);
    expect(r.case!.swaps).toBeUndefined();
    expect(r.case!.entry).toBeUndefined();
    expect(r.case!.steps.map((s) => s.action)).toEqual(['tap', 'scroll', 'expect']);
    expect(r.case!.steps.every((s) => s.screen === undefined && s.swap === undefined && s.expectScreen === undefined)).toBe(true);
    expect(r.case!.variants).toEqual([{ id: 'sg', networkScenario: 'countries-sg', env: { COUNTRY: 'Batam' } }]);
  });

  it('old unknown-action error still names the old vocabulary plus new verbs', () => {
    const r = parseCaseYaml(['name: x', 'steps:', '  - teleport: home'].join('\n'));
    expect(r.ok).toBe(false);
    expect(r.errors[0]!.message).toContain('unknown action "teleport"');
  });
});
