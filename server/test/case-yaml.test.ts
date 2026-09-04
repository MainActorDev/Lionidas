import { describe, it, expect } from 'vitest';
import { parseCaseYaml, caseToYaml } from '@crucible/shared/case-yaml';

/** T0: the YAML format definitions. Round-trip contract: caseToYaml then
 *  parseCaseYaml preserves execution semantics; unknown keys fail WITH line
 *  info; capture artifacts (ts/thumb) are dropped, never round-tripped. */

const SAMPLE = `# login and check home
name: login and check home
tags: [smoke, login]
app: com.lionparcel.ios

steps:
  - tap: { point: [214, 462], on: Login }
  - scroll: down
  - type: { text: '\${env.USERNAME}', on: Email field }
  - tap: { point: [214, 590], on: Continue, optional: true }
  - runFlow: dismiss-onboarding
  - expect: Home
  - expect: { on: Log in to get the best shipping rates., optional: true }
`;

describe('parseCaseYaml', () => {
  it('parses the full sample — every step kind, selector mapping, optional, env preserved', () => {
    const r = parseCaseYaml(SAMPLE);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    const c = r.case!;
    expect(c.name).toBe('login and check home');
    expect(c.tags).toEqual(['smoke', 'login']);
    expect(c.app).toBe('com.lionparcel.ios');
    expect(c.steps).toHaveLength(7);
    expect(c.steps[0]).toMatchObject({ action: 'tap', x: 214, y: 462, selector: { label: 'Login' } });
    expect(c.steps[1]).toMatchObject({ action: 'scroll', direction: 'down' });
    expect(c.steps[2]).toMatchObject({ action: 'type', text: '${env.USERNAME}', selector: { label: 'Email field' } });
    expect(c.steps[3]).toMatchObject({ action: 'tap', optional: true });
    expect(c.steps[4]).toMatchObject({ action: 'runFlow', templateId: 'dismiss-onboarding' });
    expect(r.runFlowNames).toEqual(['dismiss-onboarding']);
    expect(c.steps[5]).toMatchObject({ action: 'expect', selector: { label: 'Home' } });
    expect(c.steps[6]).toMatchObject({ action: 'expect', optional: true });
  });

  it('identifier-style `on` becomes selector.identifier (asset ids like ic_barcode)', () => {
    const r = parseCaseYaml('name: x\nsteps:\n  - tap: { point: [1, 2], on: ic_barcode }\n');
    expect(r.ok).toBe(true);
    expect(r.case!.steps[0]).toMatchObject({ selector: { identifier: 'ic_barcode' } });
  });

  it('unknown step key → error naming the step and suggesting (optinal:)', () => {
    const r = parseCaseYaml('name: x\nsteps:\n  - tap: { point: [1, 2], optinal: true }\n');
    expect(r.ok).toBe(false);
    expect(r.errors[0]!.message).toContain('unknown key "optinal"');
    expect(r.errors[0]!.message).toContain('step 1');
  });

  it('unknown action → error listing valid actions', () => {
    const r = parseCaseYaml('name: x\nsteps:\n  - swipe: left\n');
    expect(r.ok).toBe(false);
    expect(r.errors[0]!.message).toContain('unknown action "swipe"');
  });

  it('missing name / empty steps / bad direction / bad point all error', () => {
    expect(parseCaseYaml('steps:\n  - scroll: down\n').ok).toBe(false);
    expect(parseCaseYaml('name: x\nsteps: []\n').errors[0]!.message).toContain('non-empty');
    expect(parseCaseYaml('name: x\nsteps:\n  - scroll: sideways\n').ok).toBe(false);
    expect(parseCaseYaml('name: x\nsteps:\n  - tap: { point: [1] }\n').ok).toBe(false);
  });

  it('two action keys in one step → error', () => {
    const r = parseCaseYaml('name: x\nsteps:\n  - tap: { point: [1, 2] }\n    scroll: down\n');
    expect(r.ok).toBe(false);
    expect(r.errors[0]!.message).toContain('exactly one action key');
  });

  it('invalid yaml → parse error with line, never throws', () => {
    const r = parseCaseYaml('name: [unclosed\n');
    expect(r.ok).toBe(false);
    expect(r.errors[0]!.line).toBeGreaterThanOrEqual(1);
  });

  it('tags normalize: trim, dedupe, cap 8', () => {
    const r = parseCaseYaml('name: x\ntags: [a, a, b, c, d, e, f, g, h, i, j]\nsteps:\n  - scroll: down\n');
    expect(r.case!.tags).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  });
});

describe('caseToYaml ⟷ parseCaseYaml round-trip (the contract)', () => {
  it('storage rows → yaml → back: semantics preserved, ts/thumb dropped', () => {
    const row = {
      name: 'checkout with promo',
      tags: ['regression', 'checkout'],
      app: 'com.lionparcel.ios',
      steps: [
        { action: 'tap', x: 214, y: 462, idx: 0, ts: 123, thumb: '/tmp/x.png', selector: { label: 'Cart' } },
        { action: 'type', text: '${env.PROMO}', idx: 1, selector: { label: 'Promo field' } },
        { action: 'scroll', direction: 'down', idx: 2, ts: 456 },
        { action: 'runFlow', templateId: 'tpl_deadbee', idx: 3, optional: true },
        { action: 'expect', idx: 4, selector: { label: 'Payment success' } },
        { action: 'expect', idx: 5, selector: { label: 'Track package' }, optional: true },
        { action: 'tap', x: 30, y: 68, idx: 6, selector: { identifier: 'ic_barcode' } },
      ],
    };
    const yaml = caseToYaml(row);
    const back = parseCaseYaml(yaml);
    expect(back.ok).toBe(true);
    expect(back.errors).toEqual([]);
    expect(back.case!.name).toBe(row.name);
    expect(back.case!.tags).toEqual(row.tags);
    expect(back.case!.app).toBe(row.app);
    expect(back.case!.steps).toHaveLength(7);
    // semantics, step by step (idx is positional; ts/thumb gone)
    expect(back.case!.steps[0]).toMatchObject({ action: 'tap', x: 214, y: 462, selector: { label: 'Cart' } });
    expect(back.case!.steps[1]).toMatchObject({ action: 'type', text: '${env.PROMO}' });
    expect(back.case!.steps[2]).toMatchObject({ action: 'scroll', direction: 'down' });
    expect(back.case!.steps[3]).toMatchObject({ action: 'runFlow', templateId: 'tpl_deadbee', optional: true });
    expect(back.case!.steps[4]).toMatchObject({ action: 'expect', selector: { label: 'Payment success' } });
    expect(back.case!.steps[5]).toMatchObject({ action: 'expect', optional: true });
    expect(back.case!.steps[6]).toMatchObject({ selector: { identifier: 'ic_barcode' } });
    // runFlow by raw templateId serializes as {name: <id>} — parse reads it
    // back as templateId and (since it came via the name field) reports it
    // in runFlowNames for the SERVER to resolve against template names.
    expect(back.runFlowNames).toEqual(['tpl_deadbee']);
  });

  it('yaml quoting survives round-trip for hostile strings', () => {
    const row = { name: "it's: a #tricky 'name'", tags: ["a: b"], app: null, steps: [{ action: 'type', text: "pass: 'word' #2", idx: 0, selector: { label: 'Email: field' } }] };
    const back = parseCaseYaml(caseToYaml(row as never));
    expect(back.ok).toBe(true);
    expect(back.case!.name).toBe("it's: a #tricky 'name'");
    expect(back.case!.steps[0]).toMatchObject({ text: "pass: 'word' #2", selector: { label: 'Email: field' } });
  });
});

describe('contains: + ignoreCase: keys', () => {
  it('parses contains: X → labelContains', () => {
    const r = parseCaseYaml("name: t\nsteps:\n  - expect: { contains: 'DATA COLLECTION' }");
    expect(r.ok).toBe(true);
    expect(r.case!.steps[0]).toMatchObject({ action: 'expect', selector: { labelContains: 'DATA COLLECTION' } });
  });

  it('parses ignoreCase: true on on-label and contains forms', () => {
    // 'Beranda' (capitalized) routes as a LABEL; lowercase single words are identifier-shaped
    const r = parseCaseYaml("name: t\nsteps:\n  - expect: { on: Beranda, ignoreCase: true }\n  - expect: { contains: 'data collection', ignoreCase: true }");
    expect(r.ok).toBe(true);
    expect(r.case!.steps[0]).toMatchObject({ selector: { label: 'Beranda', ignoreCase: true } });
    expect(r.case!.steps[1]).toMatchObject({ selector: { labelContains: 'data collection', ignoreCase: true } });
  });

  it('ignoreCase: false normalizes away', () => {
    const r = parseCaseYaml("name: t\nsteps:\n  - expect: { on: Beranda, ignoreCase: false }");
    expect(r.ok).toBe(true);
    expect(r.case!.steps[0]!.selector).toEqual({ label: 'Beranda' });
  });

  it('on + contains on one step → parse error (mutually exclusive)', () => {
    const r = parseCaseYaml("name: t\nsteps:\n  - expect: { on: Beranda, contains: 'DATA' }");
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.message.includes('mutually exclusive'))).toBe(true);
  });

  it("contains: '' → error", () => {
    const r = parseCaseYaml("name: t\nsteps:\n  - expect: { contains: '' }");
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.message.includes('non-empty fragment'))).toBe(true);
  });

  it('ignoreCase + identifier on: → parse error', () => {
    const r = parseCaseYaml("name: t\nsteps:\n  - tap: { point: [1, 2], on: ic_barcode, ignoreCase: true }");
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.message.includes('ignoreCase never applies to identifiers'))).toBe(true);
  });

  it('ignoreCase non-bool → parse error', () => {
    const r = parseCaseYaml("name: t\nsteps:\n  - expect: { on: Beranda, ignoreCase: 'yes' }");
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.message.includes('ignoreCase must be true or false'))).toBe(true);
  });

  it('scalar expect X unchanged (sugar carries no flags)', () => {
    const r = parseCaseYaml("name: t\nsteps:\n  - expect: Beranda");
    expect(r.ok).toBe(true);
    expect(r.case!.steps[0]).toMatchObject({ selector: { label: 'Beranda' } });
  });

  it('serializes contains + ignoreCase back as keys; round-trips', () => {
    const y = caseToYaml({ name: 't', tags: [], steps: [
      { idx: 0, action: 'expect', selector: { labelContains: 'DATA COLLECTION' } },
      { idx: 1, action: 'expect', selector: { labelContains: 'data collection', ignoreCase: true } },
      { idx: 2, action: 'expect', selector: { label: 'Beranda', ignoreCase: true } },
      { idx: 3, action: 'tap', x: 1, y: 2, selector: { labelContains: 'Log in' } },
    ] });
    expect(y).toContain('expect: { contains: DATA COLLECTION }');
    expect(y).toContain('expect: { contains: data collection, ignoreCase: true }');
    expect(y).toContain('expect: { on: Beranda, ignoreCase: true }');
    expect(y).toContain('tap: { point: [1, 2], contains: Log in }'); // spaces are plain-safe — no quotes needed
    const back = parseCaseYaml(y);
    expect(back.ok).toBe(true);
    expect(back.case!.steps[0]).toMatchObject({ selector: { labelContains: 'DATA COLLECTION' } });
    expect(back.case!.steps[1]).toMatchObject({ selector: { labelContains: 'data collection', ignoreCase: true } });
    expect(back.case!.steps[2]).toMatchObject({ selector: { label: 'Beranda', ignoreCase: true } });
    expect(back.case!.steps[3]).toMatchObject({ selector: { labelContains: 'Log in' } });
  });
});

describe('setup section + when guard (declared preconditions)', () => {
  const SETUP_CASE = `name: privacy drill
setup:
  - tap: { point: [196, 780], on: Continue, when: Continue }
steps:
  - expect: Beranda
`;

  it('parses setup: with when-guard into case.setup', () => {
    const r = parseCaseYaml(SETUP_CASE);
    expect(r.ok).toBe(true);
    expect(r.case!.setup).toHaveLength(1);
    expect(r.case!.setup![0]).toMatchObject({ action: 'tap', x: 196, y: 780, selector: { label: 'Continue' }, when: 'Continue' });
    expect(r.case!.steps).toHaveLength(1);
  });

  it('when: inside steps: is an error (setup-only guard)', () => {
    const r = parseCaseYaml(`name: x
steps:
  - tap: { point: [1, 2], when: Continue }
`);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.message.includes('when is a setup-only guard'))).toBe(true);
  });

  it('empty setup: is an error', () => {
    const r = parseCaseYaml(`name: x
setup: []
steps:
  - expect: Beranda
`);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.message.includes('setup, when present, needs at least one step'))).toBe(true);
  });

  it('when: on scroll/runFlow setup steps is an error', () => {
    const r = parseCaseYaml(`name: x
setup:
  - scroll: down
    when: Continue
steps:
  - expect: Beranda
`);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.message.includes('when only guards tap/type/expect'))).toBe(true);
  });

  it('runFlow inside setup is an error', () => {
    const r = parseCaseYaml(`name: x
setup:
  - runFlow: onboarding
steps:
  - expect: Beranda
`);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.message.includes('runFlow is not allowed in setup'))).toBe(true);
  });

  it('round-trips setup + when through caseToYaml', () => {
    const r = parseCaseYaml(SETUP_CASE);
    const y = caseToYaml(r.case! as never);
    const back = parseCaseYaml(y);
    expect(back.ok).toBe(true);
    expect(back.case!.setup).toHaveLength(1);
    expect(back.case!.setup![0]).toMatchObject({ when: 'Continue' });
  });

  it('unknown key inside a setup step errors', () => {
    const r = parseCaseYaml(`name: x
setup:
  - tap: { point: [1, 2], whne: oops }
steps:
  - expect: Beranda
`);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.message.includes('unknown key "whne"'))).toBe(true);
  });
});
