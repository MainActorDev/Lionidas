import { describe, expect, it } from 'vitest';
import { matchPreset, seqIndex, advanceSeq, resetSeqForTests, type Preset } from '../src/forge/matcher.ts';

const p = (over: Partial<Preset>): Preset => ({
  id: 'p1', method: 'GET', pathPattern: '/api/x', match: 'exact', status: 200, ...over,
});

describe('forge matcher', () => {
  it('exact match', () => {
    const hit = matchPreset([p({})], { method: 'GET', path: '/api/x', query: {}, headers: {} });
    expect(hit?.preset.id).toBe('p1');
  });
  it('glob match with wildcard', () => {
    const hit = matchPreset([p({ pathPattern: '/api/*', match: 'glob' })], { method: 'GET', path: '/api/anything', query: {}, headers: {} });
    expect(hit).not.toBeNull();
  });
  it('regex match', () => {
    const hit = matchPreset([p({ pathPattern: '^/v[0-9]+/items$', match: 'regex' })], { method: 'GET', path: '/v2/items', query: {}, headers: {} });
    expect(hit).not.toBeNull();
  });
  it('longest path wins over shorter', () => {
    const short = p({ id: 'short', pathPattern: '/api/*', match: 'glob' });
    const long = p({ id: 'long', pathPattern: '/api/users/*', match: 'glob' });
    const hit = matchPreset([short, long], { method: 'GET', path: '/api/users/1', query: {}, headers: {} });
    expect(hit?.preset.id).toBe('long');
  });
  it('method * matches any; specific method rejects others', () => {
    expect(matchPreset([p({ method: '*' })], { method: 'POST', path: '/api/x', query: {}, headers: {} })).not.toBeNull();
    expect(matchPreset([p({ method: 'POST' })], { method: 'GET', path: '/api/x', query: {}, headers: {} })).toBeNull();
  });
  it('query guard filters', () => {
    const g = p({ guards: { query: { env: 'stg' } } });
    expect(matchPreset([g], { method: 'GET', path: '/api/x', query: { env: 'stg' }, headers: {} })).not.toBeNull();
    expect(matchPreset([g], { method: 'GET', path: '/api/x', query: { env: 'prod' }, headers: {} })).toBeNull();
  });
  it('header guard case-insensitive', () => {
    const g = p({ guards: { headers: { 'x-token': 'abc' } } });
    expect(matchPreset([g], { method: 'GET', path: '/api/x', query: {}, headers: { 'X-Token': 'abc' } })).not.toBeNull();
  });
  it('no match returns null', () => {
    expect(matchPreset([p({})], { method: 'GET', path: '/other', query: {}, headers: {} })).toBeNull();
  });
});

describe('sequence cursors', () => {
  it('advances per hit, last repeats', () => {
    resetSeqForTests();
    expect(seqIndex('pA', 'run1')).toBe(0);
    advanceSeq('pA', 'run1');
    expect(seqIndex('pA', 'run1')).toBe(1);
    advanceSeq('pA', 'run1');
    advanceSeq('pA', 'run1');
    advanceSeq('pA', 'run1'); // past end
    expect(seqIndex('pA', 'run1')).toBe(4); // caller clamps to last
  });
  it('run-scoped: separate cursors', () => {
    resetSeqForTests();
    advanceSeq('pB', 'run1');
    expect(seqIndex('pB', 'run2')).toBe(0);
  });
});
