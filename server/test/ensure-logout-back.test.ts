import { describe, expect, it } from 'vitest';
import { caseToYaml, parseCaseYaml } from '../../shared/src/case-yaml.ts';

/** ensure logout `back:` — after the preflight ends (either path), tap back to
 *  the screen the case was recorded from. Motivated live by tnc
 *  (tpl_5ad494cb): via: parks on the Account tab, first case step assumes
 *  Home, run fails at 'tap 356,247' (run_36e390f5/2ca91a88/7b4d4c7b). */

const BASE = `name: m
setup:
  - ensure logout:
      button: account_logout_button
      confirm: account_logout_confirm_button
      via: ic_tabbar_account_inactive
      back: Home
steps:
  - tap: { point: [356, 247] }
`;

describe('ensure logout back:', () => {
  it('parses, round-trips, and validates', () => {
    const r = parseCaseYaml(BASE);
    expect(r.ok, r.errors.map((e: { message: string }) => e.message).join('; ')).toBe(true);
    const step = r.case!.setup![0] as unknown as { ensureLogout: { back?: string } };
    expect(step.ensureLogout.back).toBe('Home');
    const yaml = caseToYaml(r.case!);
    expect(yaml).toContain('back: Home');
    const back = parseCaseYaml(yaml);
    expect(back.ok).toBe(true);
    expect((back.case!.setup![0] as unknown as { ensureLogout: { back?: string } }).ensureLogout.back).toBe('Home');
  });

  it('back omitted → key absent (byte-parity with existing emitter forms)', () => {
    const noBack = BASE.replace('      back: Home\n', '');
    const r = parseCaseYaml(noBack);
    expect(r.ok).toBe(true);
    const step = r.case!.setup![0] as unknown as { ensureLogout: { back?: string } };
    expect(step.ensureLogout.back).toBeUndefined();
    expect(caseToYaml(r.case!)).not.toContain('back:');
  });

  it('back with empty value → parse error naming the step', () => {
    const empty = BASE.replace('back: Home', 'back: ""');
    const r = parseCaseYaml(empty);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e: { message: string }) => e.message.includes('back'))).toBe(true);
  });
});
