import { describe, it, expect } from 'vitest';
import { parseCaseYaml, caseToYaml } from '@crucible/shared/case-yaml';

/** R2 S6 follow-up — the drill case exposed a DATA-LOSS bug: caseToYaml had
 *  no emitters for the v2 verbs, so GET /api/templates/:id/yaml rendered
 *  every arrive/refresh/world/expectScreen step as `scroll: down` with a
 *  warning comment — and saving that yaml back would DESTROY the case.
 *  These tests pin: v2 steps round-trip losslessly; worlds + entry emit and
 *  re-parse; the placeholder fallback never fires for known verbs. */

const CASE = `name: roundtrip worlds
app: com.test.app
entry: { screen: home }
swaps:
  - id: sg
    scenarios: [countries-sg]
  - id: my
    scenarios: [countries-my]
steps:
  - arrive: home
  - expect screen: home.world-sg
  - swap: my
  - refresh: home
  - expect screen: home.state != loading
`;

describe('caseToYaml — R2 verb emitters (data-loss pin)', () => {
  it('v2 case round-trips: parse → emit → parse yields the same structure', () => {
    const first = parseCaseYaml(CASE);
    expect(first.ok).toBe(true);
    const c = first.case!;
    const emitted = caseToYaml({
      name: c.name,
      tags: c.tags,
      ...(c.app ? { app: c.app } : {}),
      ...(c.swaps ? { swaps: c.swaps as unknown[] } : {}),
      ...(c.entry ? { entry: c.entry } : {}),
      steps: c.steps as unknown[],
    });
    expect(emitted).not.toContain('unrendered step kind');
    expect(emitted).not.toContain('placeholder');
    const second = parseCaseYaml(emitted);
    expect(second.ok).toBe(true);
    // structure equality (env/order-stable fields)
    expect(second.case!.steps.map((s) => s.action)).toEqual(first.case!.steps.map((s) => s.action));
    expect(second.case!.swaps?.map((w) => w.id)).toEqual(['sg', 'my']);
    expect(second.case!.swaps?.[0]?.scenarios).toEqual(['countries-sg']);
    expect(second.case!.entry?.screen).toBe('home');
    // verb payloads survive
    expect(second.case!.steps[0]).toMatchObject({ action: 'arrive', screen: 'home' });
    expect(second.case!.steps[2]).toMatchObject({ action: 'swap', swap: 'my' });
    expect(second.case!.steps[3]).toMatchObject({ action: 'refresh', screen: 'home' });
    expect(second.case!.steps[4]).toMatchObject({ action: 'expectScreen', expectScreen: { screen: 'home', state: 'loading', negate: true } });
  });

  it('LEGACY stored world steps emit as swap — never the placeholder (data-loss pin)', () => {
    // storage written before the 2026-09-24 rename carries action:'world';
    // the emitter must render it in the new vocabulary, not scroll: down
    const out = caseToYaml({
      name: 'legacy storage',
      tags: [],
      steps: [
        { idx: 0, action: 'world', world: 'my' } as never,
        { idx: 1, action: 'arrive', screen: 'home' } as never,
      ],
    });
    expect(out).toContain('- swap: my');
    expect(out).toContain('- arrive: home');
    expect(out).not.toContain('placeholder');
    expect(out).not.toContain('unrendered');
    // and the emitted form re-parses to normalized storage
    const back = parseCaseYaml(out);
    expect(back.ok).toBe(true);
    expect(back.case!.steps[0]).toMatchObject({ action: 'swap', swap: 'my' });
  });

  it('variants vocabulary still emits when no worlds (legacy cases unchanged)', () => {
    const legacy = parseCaseYaml('name: legacy\nsteps:\n  - expect: OK\nvariants:\n  - id: v1\n    networkScenario: slow\n');
    expect(legacy.ok).toBe(true);
    const out = caseToYaml({ name: legacy.case!.name, tags: [], variants: legacy.case!.variants as unknown[], steps: legacy.case!.steps as unknown[] });
    expect(out).toContain('variants:');
    expect(out).toContain('networkScenario:');
    expect(out).not.toContain('worlds:');
  });

  it('scenarios[] (S2 set form) survives the round-trip', () => {
    const src = 'name: sets\nsteps:\n  - expect: OK\nvariants:\n  - id: a\n    scenarios: [one, two]\n';
    const parsed = parseCaseYaml(src);
    expect(parsed.ok).toBe(true);
    const out = caseToYaml({ name: 'sets', tags: [], variants: parsed.case!.variants as unknown[], steps: parsed.case!.steps as unknown[] });
    expect(out).toContain('scenarios: [one, two]');
    const back = parseCaseYaml(out);
    expect(back.case!.variants?.[0]?.scenarios).toEqual(['one', 'two']);
  });
});
