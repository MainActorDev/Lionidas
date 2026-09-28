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

/** ensure login/logout emit as BLOCK steps — one field per line. The old
 *  flow-map emission crammed 7 selectors into one ~200-char line; block
 *  form keeps the YAML human-readable while parsing to the identical
 *  structure (both forms parse identically — the block form is now the
 *  canonical emission). */
describe('caseToYaml — ensure verbs block form', () => {
  it('ensure login emits one field per line and round-trips losslessly', () => {
    const src = [
      'name: li',
      'steps:',
      '  - ensure login:',
      '      entry: home_login_bar_login_button',
      '      phoneField: auth_login_phone_field',
      '      passwordField: auth_login_password_field',
      '      submit: auth_login_button',
      '      session: account_logout_button',
      "      phone: '${env.DRILL_PHONE}'",
      "      password: '${env.DRILL_PASSWORD}'",
    ].join('\n') + '\n';
    const parsed = parseCaseYaml(src);
    expect(parsed.ok).toBe(true);
    const out = caseToYaml({ name: 'li', tags: [], variants: [], steps: parsed.case!.steps as unknown[] });
    for (const line of [
      '  - ensure login:',
      '      entry: home_login_bar_login_button',
      '      phoneField: auth_login_phone_field',
      '      passwordField: auth_login_password_field',
      '      submit: auth_login_button',
      '      session: account_logout_button',
      "      phone: '${env.DRILL_PHONE}'",
      "      password: '${env.DRILL_PASSWORD}'",
    ]) expect(out).toContain(line);
    // no single-line flow form for the verb body
    expect(out).not.toMatch(/ensure login: *\{/);
    const back = parseCaseYaml(out);
    expect(back.ok).toBe(true);
    expect(JSON.stringify(back.case!.steps)).toBe(JSON.stringify(parsed.case!.steps));
  });

  it('ensure logout emits block form; stay renders only when set', () => {
    const mk = (stay: boolean) => parseCaseYaml([
      'name: lo',
      'steps:',
      '  - ensure logout:',
      '      button: account_logout_button',
      '      confirm: Confirm',
      ...(stay ? ['      stay: Log out?'] : []),
    ].join('\n') + '\n');
    const withStay = mk(true);
    expect(withStay.ok).toBe(true);
    const out = caseToYaml({ name: 'lo', tags: [], variants: [], steps: withStay.case!.steps as unknown[] });
    expect(out).toContain('  - ensure logout:');
    expect(out).toContain('      button: account_logout_button');
    expect(out).toContain('      confirm: Confirm');
    expect(out).toContain('      stay: \'Log out?\'');
    const back = parseCaseYaml(out);
    expect(JSON.stringify(back.case!.steps)).toBe(JSON.stringify(withStay.case!.steps));
    const noStay = mk(false);
    const out2 = caseToYaml({ name: 'lo', tags: [], variants: [], steps: noStay.case!.steps as unknown[] });
    expect(out2).not.toContain('stay:');
    expect(JSON.stringify(parseCaseYaml(out2).case!.steps)).toBe(JSON.stringify(noStay.case!.steps));
  });

  it('ensure logout via round-trips (cross-screen preflight tap)', () => {
    const parsed = parseCaseYaml([
      'name: lo2',
      'steps:',
      '  - ensure logout:',
      '      button: account_logout_button',
      '      confirm: account_logout_confirm_button',
      '      via: ic_tabbar_account_inactive',
    ].join('\n') + '\n');
    expect(parsed.ok).toBe(true);
    expect(parsed.case!.steps[0]).toMatchObject({ action: 'ensureLogout', ensureLogout: { via: 'ic_tabbar_account_inactive' } });
    const out = caseToYaml({ name: 'lo2', tags: [], variants: [], steps: parsed.case!.steps as unknown[] });
    expect(out).toContain('      via: ic_tabbar_account_inactive');
    const back = parseCaseYaml(out);
    expect(back.ok).toBe(true);
    expect(JSON.stringify(back.case!.steps)).toBe(JSON.stringify(parsed.case!.steps));
  });
});

/** screen-form ensure login (plan rev 2 S4): selectors resolve from the
 *  screens registry at play time; only env refs ride the step. Pins:
 *  compact emission, lossless round-trip, and the screen XOR inline rule. */
describe('caseToYaml — ensure login screen form', () => {
  it('screen form emits screen/phone/password and round-trips losslessly', () => {
    const src = [
      'name: sf',
      'steps:',
      '  - ensure login:',
      '      screen: auth',
      "      phone: '${env.DRILL_PHONE}'",
      "      password: '${env.DRILL_PASSWORD}'",
    ].join('\n') + '\n';
    const parsed = parseCaseYaml(src);
    expect(parsed.ok).toBe(true);
    const el = parsed.case!.steps[0] as unknown as { ensureLogin: { screen: string; phone: string; password: string; entry: string } };
    expect(el.ensureLogin.screen).toBe('auth');
    expect(el.ensureLogin.entry).toBe('');
    const out = caseToYaml({ name: 'sf', tags: [], variants: [], steps: parsed.case!.steps as unknown[] });
    expect(out).toContain('  - ensure login:');
    expect(out).toContain('      screen: auth');
    expect(out).not.toMatch(/entry:/);
    const back = parseCaseYaml(out);
    expect(back.ok).toBe(true);
    expect(JSON.stringify(back.case!.steps)).toBe(JSON.stringify(parsed.case!.steps));
  });

  it('screen + inline selectors → validator error (mutual exclusion)', () => {
    const src = [
      'name: both',
      'steps:',
      '  - ensure login:',
      '      screen: auth',
      '      entry: home_login_bar_login_button',
      "      phone: '${env.P}'",
      "      password: '${env.Q}'",
    ].join('\n') + '\n';
    const parsed = parseCaseYaml(src);
    expect(parsed.ok).toBe(false);
    expect(parsed.errors.some((e) => e.message.includes('mutually exclusive'))).toBe(true);
  });

  it('screen form without phone/password → validator error', () => {
    const src = 'name: bare\nsteps:\n  - ensure login:\n      screen: auth\n';
    const parsed = parseCaseYaml(src);
    expect(parsed.ok).toBe(false);
    expect(parsed.errors.some((e) => e.message.includes('phone/password env refs'))).toBe(true);
  });

  it('inline form still parses and emits unchanged (back-compat)', () => {
    const src = [
      'name: inline',
      'steps:',
      '  - ensure login:',
      '      entry: home_login_bar_login_button',
      '      phoneField: auth_login_phone_field',
      '      passwordField: auth_login_password_field',
      '      submit: auth_login_button',
      '      session: account_logout_button',
      "      phone: '${env.DRILL_PHONE}'",
      "      password: '${env.DRILL_PASSWORD}'",
    ].join('\n') + '\n';
    const parsed = parseCaseYaml(src);
    expect(parsed.ok).toBe(true);
    expect((parsed.case!.steps[0] as unknown as { ensureLogin: { screen?: string } }).ensureLogin.screen).toBeUndefined();
    const out = caseToYaml({ name: 'inline', tags: [], variants: [], steps: parsed.case!.steps as unknown[] });
    expect(out).toContain('entry: home_login_bar_login_button');
    expect(out).not.toContain('screen:');
  });
});

/** screenless ensure login (login-as-app-procedure F2): the step carries
 *  env refs only — the app's login flow supplies every selector. */
describe('ensure login — screenless app-procedure form', () => {
  it('parses, emits, round-trips', () => {
    const src = "name: sf\nsteps:\n  - ensure login:\n      phone: '${env.DRILL_PHONE}'\n      password: '${env.DRILL_PASSWORD}'\n";
    const parsed = parseCaseYaml(src);
    expect(parsed.ok).toBe(true);
    const el = parsed.case!.steps[0] as unknown as { ensureLogin: { screen?: string; phone: string } };
    expect(el.ensureLogin.screen).toBeUndefined();
    const out = caseToYaml({ name: 'sf', tags: [], variants: [], steps: parsed.case!.steps as unknown[] });
    expect(out).toContain('phone:');
    expect(out).not.toContain('screen:');
    const back = parseCaseYaml(out);
    expect(JSON.stringify(back.case!.steps)).toBe(JSON.stringify(parsed.case!.steps));
  });
  it('selectors in the screenless form → error (they live in the app flow)', () => {
    const src = "name: bad\nsteps:\n  - ensure login:\n      phone: '${env.P}'\n      password: '${env.Q}'\n      submit: some_button\n";
    const parsed = parseCaseYaml(src);
    expect(parsed.ok).toBe(false);
    expect(parsed.errors.some((e) => e.message.includes('partial selectors'))).toBe(true);
  });
});
