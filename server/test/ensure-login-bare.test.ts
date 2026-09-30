import { describe, expect, it } from 'vitest';
import { caseToYaml, parseCaseYaml } from '../../shared/src/case-yaml.ts';

/** Bare `ensure login: {}` (plan 20260930T044550Z rev 2 stage 2): the app's
 *  steps-recipe resolves at run time; screen-form stays as back-compat until
 *  cases migrate; inline selector form is gone with a pointing error. */

describe('ensure login bare form', () => {
  it('parses `ensure login:` (empty body) and `{}` to the recipe marker', () => {
    for (const form of ['  - ensure login:', '  - ensure login: {}']) {
      const r = parseCaseYaml(['name: m', 'setup:', form, 'steps:', '  - expect: Done'].join('\n'));
      expect(r.ok, `${form}: ${r.errors.map((e: { message: string }) => e.message).join('; ')}`).toBe(true);
      const step = r.case!.setup![0] as unknown as { action: string; ensureLogin: Record<string, unknown> };
      expect(step.action).toBe('ensureLogin');
      expect(step.ensureLogin['recipe']).toBe('app');
    }
  });

  it('marker round-trips: emit renders the bare form', () => {
    const r = parseCaseYaml('name: m\nsetup:\n  - ensure login: {}\nsteps:\n  - expect: Done');
    expect(r.ok).toBe(true);
    const yaml = caseToYaml(r.case!);
    expect(yaml).toContain('- ensure login: {}');
    const back = parseCaseYaml(yaml);
    expect(back.ok).toBe(true);
    expect((back.case!.setup![0] as unknown as { ensureLogin: Record<string, unknown> }).ensureLogin['recipe']).toBe('app');
  });

  it('bare + narrate round-trips (Given I am logged in)', () => {
    const r = parseCaseYaml('name: m\nsetup:\n  - ensure login: {}\nsteps:\n  - expect: Done');
    const c = r.case! as unknown as Record<string, unknown>;
    (c['setup'] as Array<Record<string, unknown>>)[0]!['narrate'] = 'Given I am logged in';
    const yaml = caseToYaml(c as never);
    expect(yaml).toContain('narrate');
    const back = parseCaseYaml(yaml);
    expect((back.case!.setup![0] as unknown as { narrate?: string }).narrate).toBe('Given I am logged in');
  });

  it('predicate: bare + no recipe → save-time error naming the fix; absent predicate → skip', () => {
    const doc = 'name: m\napp: com.example.app\nsetup:\n  - ensure login: {}\nsteps:\n  - expect: Done';
    const strict = parseCaseYaml(doc, { hasLoginRecipe: () => false });
    expect(strict.ok).toBe(false);
    expect(strict.errors.some((e: { message: string }) => e.message.includes('login flow'))).toBe(true);
    const hasIt = parseCaseYaml(doc, { hasLoginRecipe: () => true });
    expect(hasIt.ok).toBe(true);
    expect(parseCaseYaml(doc).ok).toBe(true);
  });

  it('screen-form (legacy) still parses pre-migration (back-compat)', () => {
    const y = ['name: m', 'setup:', '  - ensure login:', '      screen: auth', "      phone: '${env.DRILL_PHONE}'", "      password: '${env.DRILL_PASSWORD}'", 'steps:', '  - expect: Done'].join('\n');
    const r = parseCaseYaml(y);
    expect(r.ok, r.errors.map((e: { message: string }) => e.message).join('; ')).toBe(true);
    const step = r.case!.setup![0] as unknown as { ensureLogin: Record<string, unknown> };
    expect(step.ensureLogin['screen']).toBe('auth');
  });

  it('marker + extra keys → error', () => {
    const r = parseCaseYaml('name: m\nsetup:\n  - ensure login:\n      recipe: app\n      screen: auth\nsteps:\n  - expect: Done');
    expect(r.ok).toBe(false);
  });

  it('inline selector form → pointing error (gone)', () => {
    const r = parseCaseYaml(['name: m', 'setup:', '  - ensure login:', '      entry: home_login', '      phoneField: ph', '      passwordField: pw', '      submit: go', '      session: sess', "      phone: '${env.P}'", "      password: '${env.W}'", 'steps:', '  - expect: Done'].join('\n'));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e: { message: string }) => /screen|recipe/.test(e.message))).toBe(true);
  });
});
