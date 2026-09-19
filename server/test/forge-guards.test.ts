/** Phase C0 — networking groundwork: guards PERSISTENCE (they existed in
 *  the matcher but nothing stored them), bodyContains request-body guards,
 *  proxy body buffering before matching, seq typing honesty. */
import { describe, it, expect } from 'vitest';
import { matchPreset, presetRowToSpec, type Preset } from '../src/forge/matcher.ts';

describe('presetRowToSpec — guards round-trip (T0.1)', () => {
  it('reads guards_json from a preset row', () => {
    const spec = presetRowToSpec({
      id: 'p1', method: 'GET', path_pattern: '/api/account', match: 'exact', status: 200,
      guards_json: JSON.stringify({ query: { state: 'active' }, headers: { 'x-app': 'ios' } }),
    });
    expect(spec.guards).toEqual({ query: { state: 'active' }, headers: { 'x-app': 'ios' } });
  });
  it('no guards_json → no guards (compat)', () => {
    const spec = presetRowToSpec({ id: 'p1', method: 'GET', path_pattern: '/x', match: 'exact', status: 200 });
    expect(spec.guards).toBeUndefined();
  });
  it('seq typing carries bodyPath/delayMs (T0.3 honesty)', () => {
    const spec = presetRowToSpec({
      id: 'p1', method: 'GET', path_pattern: '/x', match: 'exact', status: 200,
      seq_json: JSON.stringify([{ status: 500, delayMs: 100 }, { status: 200, bodyPath: '/tmp/b.json' }]),
    });
    expect(spec.seq?.[1]).toEqual({ status: 200, bodyPath: '/tmp/b.json' });
  });
});

describe('matchPreset — query/header guards reachable from specs (T0.1)', () => {
  const base = (over: Partial<Preset>): Preset => ({ id: 'p', method: 'GET', pathPattern: '/api/account', match: 'exact', status: 200, ...over });
  it('two same-path presets differentiate by query guard', () => {
    const presets = [
      base({ id: 'active', guards: { query: { state: 'active' } }, status: 200 }),
      base({ id: 'pending', guards: { query: { state: 'pending' } }, status: 422 }),
    ];
    const hit = matchPreset(presets, { method: 'GET', path: '/api/account', query: { state: 'pending' }, headers: {} });
    expect(hit?.preset.id).toBe('pending');
  });
});

describe('matchPreset — bodyContains guard (T0.2)', () => {
  const preset = (over: Partial<Preset>): Preset =>
    ({ id: 'p', method: 'POST', pathPattern: '/api/account', match: 'exact', status: 200, ...over });
  const req = (body?: string) => ({ method: 'POST', path: '/api/account', query: {}, headers: {}, ...(body !== undefined ? { body } : {}) });

  it('matches when ALL substrings present', () => {
    const p = preset({ guards: { bodyContains: ['"status":"pending"', 'account'] } });
    expect(matchPreset([p], req('{"account":1,"status":"pending"}'))?.preset.id).toBe('p');
  });
  it('no match when one substring missing', () => {
    const p = preset({ guards: { bodyContains: ['"status":"pending"'] } });
    expect(matchPreset([p], req('{"status":"active"}'))).toBeNull();
  });
  it('FAILS CLOSED: no buffered body → no match (never false-positive)', () => {
    const p = preset({ guards: { bodyContains: ['anything'] } });
    expect(matchPreset([p], req()) ).toBeNull(); // body absent entirely
  });
  it('unguarded preset still matches when body absent (compat)', () => {
    const p = preset({});
    expect(matchPreset([p], req())?.preset.id).toBe('p');
  });
  it('two same-path presets differentiate by body guard', () => {
    const presets = [
      preset({ id: 'active', guards: { bodyContains: ['"status":"active"'] } }),
      preset({ id: 'pending', guards: { bodyContains: ['"status":"pending"'] } }),
    ];
    expect(matchPreset(presets, req('{"status":"pending"}'))?.preset.id).toBe('pending');
    expect(matchPreset(presets, req('{"status":"active"}'))?.preset.id).toBe('active');
  });
});
