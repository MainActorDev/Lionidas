import { describe, it, expect } from 'vitest';
import { isSimulator } from '../src/manual/keyboard-quiet.ts';
import { hasSimctl } from './helpers/capabilities.ts';
const describeIf = describe.skipIf(!(hasSimctl()));

// capability gate: needs simctl (install Xcode + a runtime)
describeIf('keyboard-quiet — simulator detection (simctl is the source of truth)', () => {
  it('a simulator UDID from THIS machine resolves as a simulator', async () => {
    // any real sim this machine has — no hardcoded device survives a clone
    const out = (await import('node:child_process')).execFileSync('xcrun', ['simctl', 'list', 'devices'], { encoding: 'utf8' });
    const m = /([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})/.exec(out);
    if (!m) { console.warn('no simulator devices on this machine — vacuous pass'); return; }
    expect(await isSimulator(m[1]!)).toBe(true);
  });

  it('an unknown UUID-shaped id (physical device pattern) is NOT a simulator', async () => {
    expect(await isSimulator('00008110-001A1D2E3F45B67E')).toBe(false);
  });

  it('garbage ids are rejected', async () => {
    expect(await isSimulator('local')).toBe(false);
  });
});
