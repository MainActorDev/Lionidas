import { describe, it, expect } from 'vitest';
import { isSimulator } from '../src/manual/keyboard-quiet.ts';

describe('keyboard-quiet — simulator detection (simctl is the source of truth)', () => {
  it('a booted simulator UDID resolves as a simulator', async () => {
    // the long-lived QA sim in this environment
    expect(await isSimulator('9737FC79-A4F2-44C6-B5A3-3BDA84E4AE2C')).toBe(true);
  });

  it('an unknown UUID-shaped id (physical device pattern) is NOT a simulator', async () => {
    expect(await isSimulator('00008110-001A1D2E3F45B67E')).toBe(false);
  });

  it('garbage ids are rejected', async () => {
    expect(await isSimulator('local')).toBe(false);
  });
});
