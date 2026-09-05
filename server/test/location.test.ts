import { describe, it, expect } from 'vitest';
import { buildSetArgs, buildClearArgs, formatCoord, setLocation, clearLocation, type Execute } from '../src/manual/location.js';

/** T3 (Tier 2.3): simctl location wrappers. Arg vectors are PURE —
 *  locale pinning (dot decimals, always), negative latitudes, wrapper
 *  error propagation with stderr. Executor is injected (no spawn in tests). */

const calls: Array<{ cmd: string; args: string[] }> = [];
const fakeOk: Execute = async (cmd, args) => { calls.push({ cmd, args }); return { stdout: '', stderr: '' }; };
const fakeFail: Execute = async () => { throw Object.assign(new Error('spawn failed'), { stderr: 'no device' }); };

describe('buildSetArgs / buildClearArgs (pure)', () => {
  it('set: full simctl arg vector with dot-decimal pair', () => {
    expect(buildSetArgs('UDID-1', -6.1754, 106.8272)).toEqual([
      'simctl', 'location', 'UDID-1', 'set', '-6.175400,106.827200',
    ]);
  });

  it('set: negative latitude AND negative longitude (SF)', () => {
    expect(buildSetArgs('UDID-1', 37.7749, -122.4194)[4]).toBe('37.774900,-122.419400');
  });

  it('set: integers stay dot-formatted to 6dp', () => {
    expect(buildSetArgs('U', 0, 0)[4]).toBe('0.000000,0.000000');
  });

  it('clear: minimal arg vector', () => {
    expect(buildClearArgs('UDID-1')).toEqual(['simctl', 'location', 'UDID-1', 'clear']);
  });

  it('formatCoord pins dot decimals regardless of host locale', () => {
    expect(formatCoord(-6.1754)).toBe('-6.175400');
    expect(formatCoord(106.8272)).toBe('106.827200');
  });
});

describe('setLocation / clearLocation (wrappers, injected executor)', () => {
  it('spawns xcrun with the set vector and reports the coordinate', async () => {
    calls.length = 0;
    const r = await setLocation(fakeOk, 'UDID-1', -6.1754, 106.8272);
    expect(r).toEqual({ set: true, coordinate: '-6.175400,106.827200' });
    expect(calls).toEqual([{ cmd: 'xcrun', args: ['simctl', 'location', 'UDID-1', 'set', '-6.175400,106.827200'] }]);
  });

  it('clear spawns the clear vector', async () => {
    calls.length = 0;
    const r = await clearLocation(fakeOk, 'UDID-1');
    expect(r).toEqual({ cleared: true });
    expect(calls[0]!.args).toContain('clear');
  });

  it('non-zero exit propagates as an Error (step fails honestly)', async () => {
    await expect(setLocation(fakeFail, 'UDID-1', 0, 0)).rejects.toThrow('spawn failed');
  });
});
