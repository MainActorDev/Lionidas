import { describe, it, expect } from 'vitest';
import { presetRowToSpec } from '../src/forge/matcher.ts';

/** B8: ONE shared row→preset mapper. The drift this kills: playback's local
 *  mapper omitted throttle_kbps, so throttling presets silently lost their
 *  throttling in runs. Every consumer (routes sync, scenario activate,
 *  playback attribution writes) maps through this function. */
describe('presetRowToSpec (B8 shared mapper)', () => {
  it('carries throttleKbps — the field playback used to drop', () => {
    const spec = presetRowToSpec({ id: 'p1', method: 'GET', path_pattern: '/api/x', match: 'exact', status: 200, throttle_kbps: 256 });
    expect(spec.throttleKbps).toBe(256);
  });

  it('omits throttleKbps key entirely when absent (exactOptionalPropertyTypes)', () => {
    const spec = presetRowToSpec({ id: 'p1', method: 'GET', path_pattern: '/api/x', match: 'exact', status: 200 });
    expect('throttleKbps' in spec).toBe(false);
  });

  it('parses headers_json and seq_json', () => {
    const spec = presetRowToSpec({
      id: 'p2', method: 'POST', path_pattern: '/api/y', match: 'glob', status: 201,
      headers_json: '{"content-type":"application/json"}',
      seq_json: '[{"status":500},{"status":200}]',
    });
    expect(spec.headers).toEqual({ 'content-type': 'application/json' });
    expect(spec.seq).toEqual([{ status: 500 }, { status: 200 }]);
  });

  it('keeps the failure cast sound', () => {
    const spec = presetRowToSpec({ id: 'p3', method: 'GET', path_pattern: '/z', match: 'exact', status: 200, failure: 'throttle' });
    expect(spec.failure).toBe('throttle');
  });

  it('carries bodyPath + delayMs when present, absent otherwise', () => {
    const withAll = presetRowToSpec({ id: 'p4', method: 'GET', path_pattern: '/b', match: 'exact', status: 200, body_path: '/data/preset-bodies/p4.body', delay_ms: 120 });
    expect(withAll.bodyPath).toBe('/data/preset-bodies/p4.body');
    expect(withAll.delayMs).toBe(120);
    const bare = presetRowToSpec({ id: 'p5', method: 'GET', path_pattern: '/b', match: 'exact', status: 200 });
    expect('bodyPath' in bare).toBe(false);
    expect('delayMs' in bare).toBe(false);
  });
});
