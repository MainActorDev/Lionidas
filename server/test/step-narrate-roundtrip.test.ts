import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { caseToYaml, parseCaseYaml } from '../../shared/src/case-yaml.ts';

/** F4 fixture: PRE-CHANGE emitter output for the full action-kind matrix —
 *  captured on main before any narrate code landed. Absent-narrate emit must
 *  stay byte-identical to these. */
const PRE = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'narrate-prechange-emit.json'), 'utf8')) as Record<string, string>;

const KINDS: Array<[string, unknown]> = [
  ['tap-point', { idx: 0, action: 'tap', x: 1, y: 2 }],
  ['tap-sel', { idx: 0, action: 'tap', selector: { label: 'Go' } }],
  ['tap-id', { idx: 0, action: 'tap', selector: { identifier: 'btn_ok' } }],
  ['tap-opt-when', { idx: 0, action: 'tap', x: 3, y: 4, optional: true, when: 'Welcome' }],
  ['type-sel', { idx: 0, action: 'type', text: 'hi', selector: { label: 'Field' } }],
  ['type-point', { idx: 0, action: 'type', text: 'hi', x: 5, y: 6 }],
  ['expect-label', { idx: 0, action: 'expect', selector: { label: 'Done' } }],
  ['expect-contains', { idx: 0, action: 'expect', selector: { labelContains: 'ship' } }],
  ['expect-count', { idx: 0, action: 'expect', selector: { label: 'Row' }, count: 3 }],
  ['expect-at-least', { idx: 0, action: 'expect', selector: { label: 'Row' }, atLeast: 2 }],
  ['expect-ignore-case', { idx: 0, action: 'expect', selector: { label: 'Done', ignoreCase: true } }],
  ['scroll', { idx: 0, action: 'scroll', direction: 'down' }],
  ['alert', { idx: 0, action: 'alert', alertAction: 'accept' }],
  ['location', { idx: 0, action: 'location', location: { latitude: 1.5, longitude: 2.5 } }],
  ['arrive', { idx: 0, action: 'arrive', screen: 'home' }],
  ['refresh', { idx: 0, action: 'refresh', screen: 'home' }],
  ['swap', { idx: 0, action: 'swap', swap: 'logged-out' }],
  ['expect-screen', { idx: 0, action: 'expectScreen', expectScreen: { screen: 'home', state: 'guest' } }],
  ['expect-screen-neg', { idx: 0, action: 'expectScreen', expectScreen: { screen: 'home', state: 'guest', negate: true } }],
  ['run-flow', { idx: 0, action: 'runFlow', templateId: 'tpl_login' }],
  ['run-flow-opt', { idx: 0, action: 'runFlow', templateId: 'tpl_login', optional: true }],
  ['ensure-logout', { idx: 0, action: 'ensureLogout', ensureLogout: { button: 'Log out', stay: '', confirm: 'Confirm' } }],
  ['ensure-logout-via', { idx: 0, action: 'ensureLogout', ensureLogout: { button: 'Log out', stay: '', confirm: 'Confirm', via: 'ic_tabbar_account_inactive' } }],
  ['ensure-login-short', { idx: 0, action: 'ensureLogin', ensureLogin: { entry: '', phoneField: '', passwordField: '', submit: '', session: '', phone: '111', password: 'x', screen: 'home' } }],
];

describe('step narrate: grammar + round-trip', () => {
  it('absent narrate → emitted yaml is byte-identical to pre-change fixtures (F4)', () => {
    for (const [key, step] of KINDS) {
      // inverse of the fixture generator's camelCase keys — exact, not pattern-guessed
      const ALIAS: Record<string, string> = {"tap-point": "tapPoint", "tap-sel": "tapSel", "tap-id": "tapId", "tap-opt-when": "tapOptWhen", "type": "type", "type-point": "typePoint", "expect-label": "expectLabel", "expect-contains": "expectContains", "expect-count": "expectCount", "expect-at-least": "expectAtLeast", "expect-ignore-case": "expectIgnoreCase", "scroll": "scroll", "alert": "alert", "location": "location", "arrive": "arrive", "refresh": "refresh", "swap": "swap", "expect-screen": "expectScreen", "expect-screen-neg": "expectScreenNeg", "run-flow": "runFlow", "run-flow-opt": "runFlowOpt", "ensure-logout": "ensureLogout", "ensure-logout-via": "ensureLogoutVia", "ensure-login-short": "ensureLoginShort", "setup-section": "setupSection", "type-sel": "type"};
      const preKey = ALIAS[key] ?? key.replace(/-(\w)/g, (_m, c: string) => c.toUpperCase());
      const expected = PRE[preKey];
      expect(expected, `fixture missing for ${key} (looked up ${preKey})`).toBeDefined();
      const yaml = caseToYaml({ name: 'm', tags: [], steps: [step] });
      expect(yaml, key).toBe(expected);
    }
  });

  it('present narrate → survives parse→emit→parse on every action kind (incl. quoted text)', () => {
    for (const [key, step] of KINDS) {
      const withNarrate = { ...(step as Record<string, unknown>), narrate: 'When I do the thing' };
      // `when` is a setup-only guard — steps carrying it must ride the setup section
      const isSetupOnly = 'when' in (step as Record<string, unknown>);
      const yaml = isSetupOnly
        ? caseToYaml({ name: 'm', tags: [], steps: [{ idx: 0, action: 'expect', selector: { label: 'Done' } }], setup: [withNarrate] } as never)
        : caseToYaml({ name: 'm', tags: [], steps: [withNarrate] });
      const back = parseCaseYaml(yaml);
      expect(back.ok, `${key}: ${back.errors.map((e: { message: string }) => e.message).join('; ')}`).toBe(true);
      const list = isSetupOnly ? back.case!.setup : back.case!.steps;
      const got = ((list![0] ?? {}) as unknown as Record<string, unknown>).narrate;
      expect(got, key).toBe('When I do the thing');
    }
  });

  it('quoted scalar text round-trips (colons, quotes)', () => {
    const step = { idx: 0, action: 'expect', selector: { label: 'Done' }, narrate: 'Then "Done: ship" is visible' } as never;
    const back = parseCaseYaml(caseToYaml({ name: 'm', tags: [], steps: [step] }));
    expect(back.ok).toBe(true);
    expect((back.case!.steps[0] as unknown as Record<string, unknown>).narrate).toBe('Then "Done: ship" is visible');
  });

  it('setup-section steps carry narrate too (parseStepList shared — review F1)', () => {
    const yaml = [
      'name: m', 'steps:', "  - tap: { point: [9, 9], narrate: 'Given the welcome sheet is up' }",
      "  - expect: { on: Done, narrate: 'Then Done shows' }",
    ].join('\n');
    const r = parseCaseYaml(yaml);
    expect(r.ok, r.errors.map((e: { message: string }) => e.message).join('; ')).toBe(true);
    const out = caseToYaml(r.case!);
    expect(out).toContain('narrate: Given the welcome sheet is up');
    const back = parseCaseYaml(out);
    expect(back.ok).toBe(true);
    expect((back.case!.steps[0] as unknown as Record<string, unknown>).narrate).toBe('Given the welcome sheet is up');
  });

  it('parse guardrails: non-string / empty / multiline narrate → error naming the step', () => {
    const bad: Array<[string, string]> = [
      ['steps:', '  - tap: { point: [1, 2], narrate: 42 }'],
      ['steps:', '  - tap: { point: [1, 2], narrate: "   " }'],
    ];
    for (const [head, body] of bad) {
      const r = parseCaseYaml([ 'name: m', head, body ].join('\n'));
      expect(r.ok).toBe(false);
      expect(r.errors.some(e => e.message.includes('narrate'))).toBe(true);
    }
    // multiline via a folded scalar is a yaml-level construct — emulate with an embedded newline in a quoted scalar
    const r2 = parseCaseYaml('name: m\nsteps:\n  - tap: { point: [1, 2], narrate: "line1\\nline2" }');
    expect(r2.ok).toBe(false);
    expect(r2.errors.some(e => e.message.includes('narrate'))).toBe(true);
  });

  it('non-Gherkin narrate → warning, never an error (F2)', () => {
    const r = parseCaseYaml('name: m\nsteps:\n  - tap: { point: [1, 2], narrate: do the tap thing }');
    expect(r.ok).toBe(true);
    expect((r.warnings ?? []).some(w => w.message.includes('Gherkin'))).toBe(true);
    // keyworded variants never warn
    for (const kw of ['Given', 'When', 'Then', 'And', 'But', 'when', 'THEN']) {
      const ok = parseCaseYaml(`name: m\nsteps:\n  - tap: { point: [1, 2], narrate: ${kw} something }`);
      expect((ok.warnings ?? []).length, kw).toBe(0);
    }
  });
});
