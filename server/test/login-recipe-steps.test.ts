import { describe, expect, it } from 'vitest';
import { validateAppLogin } from '../../shared/src/app-screens.ts';

/** Login recipe as steps (plan 20260930T044550Z rev 2 stage 1): steps-form
 *  validation — any app's login form is a step list; the 5-slot phone/
 *  password/submit shape is rejected post-migration with a pointing error. */

const SCREENS = [
  { id: 'home', entry: { tab: { label: 'Home' } }, states: { guest: { all: [{ label: 'welcome' }] } } },
  { id: 'auth', entry: { tab: { label: 'Log In' } }, states: { logged_out: { all: [{ label: 'log_in' }] }, session_on: { all: [{ label: 'balance' }] } } },
];

const OK_STEPS = {
  entry: { navigate: [{ on: 'home_login_bar_login_button' }] },
  steps: [
    { type: { on: 'auth_login_phone_field', text: '${env.DRILL_PHONE}' } },
    { type: { on: 'auth_login_password_field', text: '${env.DRILL_PASSWORD}' } },
    { tap: { on: 'auth_login_button' } },
  ],
  verify: { screen: 'auth', state: 'session_on' },
};

describe('validateAppLogin — steps form', () => {
  it('accepts the canonical steps recipe (phone+password app)', () => {
    expect(validateAppLogin(OK_STEPS, SCREENS)).toEqual([]);
  });

  it('accepts an OTP-shaped recipe (type→tap→type→tap) — the rigidity fix', () => {
    const otp = {
      entry: { tab: { label: 'Log In' } },
      steps: [
        { type: { on: 'phone_field', text: '${env.OTP_PHONE}' } },
        { tap: { on: 'send_code' } },
        { type: { on: 'code_field', text: '${env.OTP_CODE}' } },
        { tap: { on: 'verify_button' } },
      ],
      verify: { screen: 'auth', state: 'session_on' },
    };
    expect(validateAppLogin(otp, SCREENS)).toEqual([]);
  });

  it('keeps verify.via optional (F4)', () => {
    const withVia = { ...OK_STEPS, verify: { screen: 'auth', state: 'session_on', via: 'ic_tabbar_account_inactive' } };
    expect(validateAppLogin(withVia, SCREENS)).toEqual([]);
  });

  it('rejects the legacy 5-slot shape with a pointing error', () => {
    const legacy = { entry: { tab: { label: 'Log In' } }, phone: 'ph', password: 'pw', submit: 'go', verify: { screen: 'auth', state: 'session_on' } };
    const errs = validateAppLogin(legacy, SCREENS);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.join(' ')).toContain('steps');
  });

  it('empty steps → error (a recipe must do something)', () => {
    const errs = validateAppLogin({ ...OK_STEPS, steps: [] }, SCREENS);
    expect(errs.join(' ')).toContain('steps');
  });

  it('invalid step grammar → step-indexed error prefix (F3)', () => {
    const bad = { ...OK_STEPS, steps: [{ tap: { on: 'ok' } }, { teleport: { on: 'x' } }] };
    const errs = validateAppLogin(bad, SCREENS);
    expect(errs.join(' ')).toMatch(/step 2/);
  });

  it('steps subset: runFlow/scroll rejected pre-login', () => {
    const bad = { ...OK_STEPS, steps: [{ runFlow: { name: 'tpl_login' } }] };
    const errs = validateAppLogin(bad, SCREENS);
    expect(errs.join(' ')).toMatch(/runFlow|not allowed/);
  });

  it('verify cross-checks still fire (unknown screen/state)', () => {
    const bad = { ...OK_STEPS, verify: { screen: 'nope', state: 'session_on' } };
    expect(validateAppLogin(bad, SCREENS).join(' ')).toContain('nope');
    const bad2 = { ...OK_STEPS, verify: { screen: 'auth', state: 'nope' } };
    expect(validateAppLogin(bad2, SCREENS).join(' ')).toContain('nope');
  });

  it('unknown top-level keys rejected', () => {
    const bad = { ...OK_STEPS, extra: 1 } as unknown as Record<string, unknown>;
    expect(validateAppLogin(bad, SCREENS).join(' ')).toContain('unknown key');
  });
});
