import { describe, expect, it } from 'vitest';
import { caseToYaml, parseCaseYaml } from '../../shared/src/case-yaml.ts';

/** Bare `ensure logout:` (recipe via app registry — plan 20260929T080249Z rev 2 stage 1).
 *  Registry form: `ensure logout:` with empty body or `{}` → recipe marker.
 *  Inline form unchanged and WINS over the registry (case-level override). */

describe('ensure logout bare form (registry recipe)', () => {
  it('parses `ensure logout:` (empty body) and `ensure logout: {}` to the recipe marker', () => {
    for (const form of ['  - ensure logout:', '  - ensure logout: {}']) {
      const r = parseCaseYaml(['name: m', 'setup:', form, 'steps:', '  - expect: Done'].join('\n'));
      expect(r.ok, `${form}: ${r.errors.map((e: { message: string }) => e.message).join('; ')}`).toBe(true);
      const step = r.case!.setup![0] as unknown as { action: string; ensureLogout: Record<string, unknown> };
      expect(step.action).toBe('ensureLogout');
      expect(step.ensureLogout['recipe']).toBe('app');
      expect(step.ensureLogout['button']).toBeUndefined();
    }
  });

  it('marker round-trips: emit renders the bare form; re-parse keeps the marker', () => {
    const r = parseCaseYaml('name: m\nsetup:\n  - ensure logout:\nsteps:\n  - expect: Done');
    expect(r.ok).toBe(true);
    const yaml = caseToYaml(r.case!);
    expect(yaml).toContain('- ensure logout: {}');
    expect(yaml).not.toContain('button:');
    const back = parseCaseYaml(yaml);
    expect(back.ok).toBe(true);
    const step = back.case!.setup![0] as unknown as { ensureLogout: Record<string, unknown> };
    expect(step.ensureLogout['recipe']).toBe('app');
  });

  it('mixed recipe-marker + inline keys → error (one form per step)', () => {
    const r = parseCaseYaml('name: m\nsetup:\n  - ensure logout:\n      recipe: app\n      button: account_logout_button\nsteps:\n  - expect: Done');
    expect(r.ok).toBe(false);
    expect(r.errors.some((e: { message: string }) => e.message.includes('either') || e.message.includes('recipe'))).toBe(true);
  });

  it('inline form unchanged (regression): full keys still parse + round-trip', () => {
    const yaml = ['name: m', 'setup:', '  - ensure logout:', '      button: account_logout_button', '      confirm: account_logout_confirm_button', '      via: ic_tabbar_account_inactive', '      back: Home', 'steps:', '  - expect: Done'].join('\n');
    const r = parseCaseYaml(yaml);
    expect(r.ok, r.errors.map((e: { message: string }) => e.message).join('; ')).toBe(true);
    const step = r.case!.setup![0] as unknown as { ensureLogout: Record<string, unknown> };
    expect(step.ensureLogout['button']).toBe('account_logout_button');
    expect(step.ensureLogout['back']).toBe('Home');
    expect(step.ensureLogout['recipe']).toBeUndefined();
    const out = caseToYaml(r.case!);
    expect(out).toContain('button: account_logout_button');
    expect(out).toContain('back: Home');
    expect(out).not.toContain('recipe');
  });

  it('bare + no recipe available (predicate) → save-time error naming the fix; predicate absent → skip (back-compat)', () => {
    const doc = 'name: m\napp: com.example.app\nsetup:\n  - ensure logout:\nsteps:\n  - expect: Done';
    const strict = parseCaseYaml(doc, { hasLogoutRecipe: () => false });
    expect(strict.ok).toBe(false);
    expect(strict.errors.some((e: { message: string }) => e.message.includes('logout flow'))).toBe(true);
    const hasIt = parseCaseYaml(doc, { hasLogoutRecipe: () => true });
    expect(hasIt.ok).toBe(true);
    const legacy = parseCaseYaml(doc);
    expect(legacy.ok).toBe(true);
  });

  it('bare + case-owned back round-trips (registry recipe + return target)', () => {
    const y = ['name: m', 'setup:', '  - ensure logout: { back: Home }', 'steps:', '  - expect: Done'].join('\n');
    const r = parseCaseYaml(y);
    expect(r.ok, r.errors.map((e: { message: string }) => e.message).join('; ')).toBe(true);
    const step = r.case!.setup![0] as unknown as { ensureLogout: Record<string, unknown> };
    expect(step.ensureLogout['recipe']).toBe('app');
    expect(step.ensureLogout['back']).toBe('Home');
    const out = caseToYaml(r.case!);
    expect(out).toContain('- ensure logout: { back: Home }');
    const back = parseCaseYaml(out);
    expect(back.ok).toBe(true);
    expect((back.case!.setup![0] as unknown as { ensureLogout: Record<string, unknown> }).ensureLogout['back']).toBe('Home');
  });

  it('bare form survives steps section too (not setup-only)', () => {
    const r = parseCaseYaml('name: m\nsteps:\n  - ensure logout: {}\n  - expect: Done');
    expect(r.ok).toBe(true);
    const step = r.case!.steps[0] as unknown as { ensureLogout: Record<string, unknown> };
    expect(step.ensureLogout['recipe']).toBe('app');
  });
});
