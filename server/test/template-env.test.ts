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
