import { describe, it, expect } from 'vitest';
import { classifyBlocked } from '../src/db/blocked.ts';

describe('classifyBlocked (infra vs app failure)', () => {
  it('open failure = blocked', () => {
    expect(classifyBlocked('open failed: alloy_apps: Session "alloy" is already bound to apple device "iPhone 14 Plus"')).toBe(true);
  });
  it('device busy message without code = blocked', () => {
    expect(classifyBlocked('device busy — manual session holds it')).toBe(true);
  });
  it('explicit DEVICE_BUSY code = blocked', () => {
    expect(classifyBlocked('DEVICE_BUSY: device busy')).toBe(true);
  });
  it('lease lost = blocked', () => {
    expect(classifyBlocked('tap failed: LEASE_LOST engine lost the device')).toBe(true);
  });
  it('step timeout = blocked', () => {
    expect(classifyBlocked('step timeout after 90s: tap 100,200')).toBe(true);
  });
  it('connection refused = blocked', () => {
    expect(classifyBlocked('fetch failed: connection refused 127.0.0.1:9230')).toBe(true);
  });
  it('expect not-found = APP failure, not blocked', () => {
    expect(classifyBlocked('not found: {"label":"Login"}')).toBe(false);
  });
  it('expect ambiguous = APP failure, not blocked', () => {
    expect(classifyBlocked('ambiguous (2 matches): {"label":"Login"}')).toBe(false);
  });
  it('missing env = config, not infra', () => {
    expect(classifyBlocked('missing env KEY=USERNAME')).toBe(false);
  });
  it('null/undefined/empty = not blocked', () => {
    expect(classifyBlocked(null)).toBe(false);
    expect(classifyBlocked(undefined)).toBe(false);
    expect(classifyBlocked('')).toBe(false);
  });
});
