import { describe, it, expect } from 'vitest';
import { resolveAlertPolicy, parseAlertPolicy, NAMED_MATCHERS } from '@crucible/shared/alert-policy';

describe('resolveAlertPolicy', () => {
  it('null policy → fail (honesty default)', () => {
    expect(resolveAlertPolicy(null, 'Allow "Lion Parcel" to use your location?')).toBe('fail');
  });

  it('scalar-equivalent: default-only map answers everything', () => {
    const p = parseAlertPolicy('dismiss').policy!;
    expect(resolveAlertPolicy(p, 'Sign in to your Apple Account')).toBe('dismiss');
    expect(resolveAlertPolicy(p, 'anything at all')).toBe('dismiss');
  });

  it('named matcher beats default (location accepted, rest dismissed)', () => {
    const p = parseAlertPolicy({ location: 'accept', default: 'dismiss' }).policy!;
    expect(resolveAlertPolicy(p, 'Allow "Lion Parcel" to use your location?')).toBe('accept');
    expect(resolveAlertPolicy(p, 'Sign in to your Apple Account')).toBe('dismiss');
  });

  it('named matchers resolve via NAMED_MATCHERS substrings, case-insensitive', () => {
    const p = parseAlertPolicy({ apple: 'dismiss', default: 'fail' }).policy!;
    expect(resolveAlertPolicy(p, 'Sign in to your Apple Account')).toBe('dismiss');
    expect(resolveAlertPolicy(p, 'unrelated')).toBe('fail');
  });

  it('custom matcher matches literally; declaration order wins', () => {
    const p = parseAlertPolicy({ 'terms of service': 'accept', service: 'dismiss', default: 'fail' }).policy!;
    expect(resolveAlertPolicy(p, 'Please agree to the Terms of Service')).toBe('accept'); // first hit wins
    expect(resolveAlertPolicy(p, 'your service plan')).toBe('dismiss');
  });

  it('map with only default works', () => {
    const p = parseAlertPolicy({ default: 'accept' }).policy!;
    expect(resolveAlertPolicy(p, 'whatever')).toBe('accept');
  });
});

describe('parseAlertPolicy', () => {
  it('scalar valid values', () => {
    for (const v of ['accept', 'dismiss', 'fail'] as const) {
      const r = parseAlertPolicy(v);
      expect(r.error).toBeNull();
      expect(r.policy).toEqual({ entries: [['default', v]] });
    }
  });

  it('scalar invalid value errors', () => {
    expect(parseAlertPolicy('maybe').error).toContain('accept, dismiss or fail');
  });

  it('map missing default errors', () => {
    expect(parseAlertPolicy({ location: 'accept' }).error).toContain('exactly one default');
  });

  it('empty map errors', () => {
    expect(parseAlertPolicy({}).error).toContain('at least one entry');
  });

  it('map with bad action value errors', () => {
    expect(parseAlertPolicy({ location: 'yes', default: 'dismiss' }).error).toContain('accept, dismiss or fail');
  });

  it('number / array rejected', () => {
    expect(parseAlertPolicy(3).error).toContain('scalar');
    expect(parseAlertPolicy(['dismiss']).error).toContain('scalar');
  });

  it('undefined → null policy, no error', () => {
    expect(parseAlertPolicy(undefined)).toEqual({ policy: null, error: null });
  });
});

describe('NAMED_MATCHERS', () => {
  it('covers the closed permission set with substrings', () => {
    expect(NAMED_MATCHERS['location']).toContain('location');
    expect(NAMED_MATCHERS['apple']).toContain('apple account');
  });
});
