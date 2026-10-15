/** wait step (plan 20261015T221500Z): grammar round-trip, duration bounds,
 *  until-shape rules (flat condition form — YAML flow cannot nest maps), and
 *  the honest-error contracts. */
import { describe, expect, it } from 'vitest';
import { parseCaseYaml, caseToYaml, parseWaitDuration } from '../../shared/src/case-yaml.ts';

const P = (steps: string) => `name: t\nsteps:\n${steps}`;

describe('wait grammar — time form', () => {
  it.each(['500ms', '1s', '1500', '2s'])('parses %s', (d) => {
    const r = parseCaseYaml(P(`  - wait: ${d}\n`));
    expect(r.errors).toHaveLength(0);
    expect(r.case?.steps[0]?.action).toBe('wait');
  });
  it('round-trips all time spellings', () => {
    for (const y of ['  - wait: 500ms\n', '  - wait: 1s\n', '  - wait: 1500\n', '  - wait: { for: splash, time: 7s }\n']) {
      const r = parseCaseYaml(P(y));
      expect(r.errors).toHaveLength(0);
      const out = caseToYaml(r.case!);
      expect(parseCaseYaml(out).errors).toHaveLength(0);
    }
  });
  it('rejects bad durations and over-limit with the limit quoted', () => {
    expect(parseCaseYaml(P('  - wait: 7x\n')).errors[0]?.message).toMatch(/bad duration "7x"/);
    expect(parseCaseYaml(P('  - wait: 999999s\n')).errors[0]?.message).toMatch(/exceeds the 60000ms limit/);
    expect(parseCaseYaml(P('  - wait: { text: "Go", timeout: 999s }\n')).errors[0]?.message).toMatch(/exceeds the 120000ms limit/);
  });
});

describe('wait grammar — condition form (flat; R1 + YAML-flow lesson)', () => {
  it('bare until-string: identifier kind for snake_case, text otherwise', () => {
    const id = parseCaseYaml(P('  - wait: { until: home_login_bar_login_button }\n'));
    expect(id.case?.steps[0]?.wait).toMatchObject({ mode: 'until', target: { kind: 'identifier', value: 'home_login_bar_login_button' }, timeoutMs: 10_000 });
    const txt = parseCaseYaml(P('  - wait: { until: "Get Started" }\n'));
    expect(txt.case?.steps[0]?.wait).toMatchObject({ mode: 'until', target: { kind: 'text', value: 'Get Started' } });
  });
  it('flat text:/screen: forms parse + round-trip', () => {
    for (const y of ['  - wait: { text: "Get Started" }\n', '  - wait: { screen: splash.dismissed }\n', '  - wait: { text: "Go", timeout: 8s }\n']) {
      const r = parseCaseYaml(P(y));
      expect(r.errors).toHaveLength(0);
      const out = caseToYaml(r.case!);
      const back = parseCaseYaml(out);
      expect(back.errors).toHaveLength(0);
      expect(back.case?.steps[0]?.wait).toEqual(r.case?.steps[0]?.wait);
    }
  });
  it('shape rules: until+time, text+screen, until+nested are refused with guidance', () => {
    expect(parseCaseYaml(P('  - wait: { until: x, time: 5s }\n')).errors[0]?.message).toMatch(/mutually exclusive/);
    expect(parseCaseYaml(P('  - wait: { text: "a", screen: b.c }\n')).errors[0]?.message).toMatch(/mutually exclusive/);
    // nested until-map is structurally unparseable YAML flow — parse fails with yaml's own error
    expect(parseCaseYaml(P('  - wait: { until: { screen: { x: 1 } } }\n')).ok).toBe(false);
    expect(parseCaseYaml(P('  - wait: { what: 1 }\n')).errors[0]?.message).toMatch(/unknown key "what"/);
  });
  it('screen target grammar: dotted a.b required', () => {
    expect(parseCaseYaml(P('  - wait: { screen: splash }\n')).errors[0]?.message).toMatch(/"<screen>\.<state>"/);
    expect(parseCaseYaml(P('  - wait: { screen: splash.not_a_state! }\n')).errors[0]?.message).toMatch(/"<screen>\.<state>"/);
  });
});

describe('parseWaitDuration unit', () => {
  it('bare number = ms; suffixes multiply; rejects junk', () => {
    expect(parseWaitDuration(1500, 60_000)).toBe(1500);
    expect(parseWaitDuration('2s', 60_000)).toBe(2000);
    expect(parseWaitDuration('250ms', 60_000)).toBe(250);
    expect(parseWaitDuration('7x', 60_000)).toMatch(/bad duration/);
    expect(parseWaitDuration(-5, 60_000)).toMatch(/bad duration/);
  });
});

describe('setup blocks accept waits (the splash use-case)', () => {
  it('a wait in setup parses', () => {
    const r = parseCaseYaml('name: t\nsetup:\n  - wait: { text: "Get Started", timeout: 12s }\nsteps:\n  - tap: { on: "Get Started" }\n');
    expect(r.errors).toHaveLength(0);
    expect(r.case?.setup?.[0]?.action).toBe('wait');
  });
});
