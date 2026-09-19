import { describe, it, expect } from 'vitest';
import { expandEnvText, substituteStep } from '../src/manual/template-env.ts';

describe('expandEnvText', () => {
  it('resolves ${env.KEY} inside surrounding text', () => {
    expect(expandEnvText('user=${env.USER}!', { USER: 'budi' })).toBe('user=budi!');
  });
  it('multiple refs in one string', () => {
    expect(expandEnvText('${env.A}-${env.B}', { A: 'x', B: 'y' })).toBe('x-y');
  });
  it('returns null on missing key (deterministic fail, no partial typing)', () => {
    expect(expandEnvText('${env.MISSING}', {})).toBeNull();
  });
  it('plain text without refs passes through', () => {
    expect(expandEnvText('hello', {})).toBe('hello');
  });
});

describe('substituteStep', () => {
  it('substitutes text on type steps, leaves tap/scroll untouched', () => {
    const s = substituteStep({ idx: 1, action: 'type', x: 5, y: 6, text: '${env.PW}' }, { PW: 's3cret' });
    expect(s).toEqual({ idx: 1, action: 'type', x: 5, y: 6, text: 's3cret' });
    expect(substituteStep({ idx: 2, action: 'tap', x: 1, y: 2 }, {})).toEqual({ idx: 2, action: 'tap', x: 1, y: 2 });
  });
  it('returns error field on missing key instead of throwing', () => {
    const r = substituteStep({ idx: 1, action: 'type', text: '${env.NOPE}' }, {});
    expect(r.error).toBe('missing env: NOPE');
  });
});

describe('substituteStep selector env (variant-world assertions)', () => {
  it('resolves ${env.X} inside expect contains', () => {
    const r = substituteStep({ idx: 0, action: 'expect', selector: { labelContains: 'Shipping rates from ${env.CITY}' } }, { CITY: 'Kuala Lumpur' });
    expect(r).toEqual({ idx: 0, action: 'expect', selector: { labelContains: 'Shipping rates from Kuala Lumpur' } });
  });
  it('resolves ${env.X} inside exact label', () => {
    const r = substituteStep({ idx: 0, action: 'expect', selector: { label: '${env.TITLE}' } }, { TITLE: 'Account Active' });
    expect(r).toEqual({ idx: 0, action: 'expect', selector: { label: 'Account Active' } });
  });
  it('fails closed on missing selector key — never asserts a half-resolved fragment', () => {
    const r = substituteStep({ idx: 0, action: 'expect', selector: { labelContains: 'rate to ${env.WORLD}' } }, {});
    expect(r.error).toBe('missing env: WORLD');
    expect(r.selector).toBeUndefined();
  });
  it('identifier and type pass through untouched', () => {
    const r = substituteStep({ idx: 0, action: 'tap', selector: { identifier: 'home_login_bar', type: 'Button' } }, { identifier: 'x' });
    expect(r).toEqual({ idx: 0, action: 'tap', selector: { identifier: 'home_login_bar', type: 'Button' } });
  });
  it('plain selector without refs is byte-identical (backward compat)', () => {
    const r = substituteStep({ idx: 0, action: 'expect', selector: { labelContains: 'Shipping rates from' } }, {});
    expect(r).toEqual({ idx: 0, action: 'expect', selector: { labelContains: 'Shipping rates from' } });
  });
});
