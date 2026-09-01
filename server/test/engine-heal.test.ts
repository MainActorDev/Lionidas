import { describe, it, expect, beforeEach } from 'vitest';
import { withEngineHeal } from '../src/alloy/heal.ts';
import { __setAlloyForTest, crucibleAlloy } from '../src/alloy/client.ts';
import type { AlloyExports } from '../src/alloy/client.ts';

let calls: string[];

function fakeAlloy(failures: Array<string | null>): AlloyExports {
  // each dispatch: failures[i] === null → ok; string → reject with that message
  return {
    dispatch: async () => {
      const f = failures.shift() ?? null;
      if (f) throw new Error(f);
      return { ok: true, result: {} };
    },
  } as unknown as AlloyExports;
}

// capture console.warn to assert healing is logged (never silent)
let warnings: string[];
const origWarn = console.warn;
beforeEach(() => {
  calls = [];
  warnings = [];
  console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(' ')); };
});
afterAllRestore();

function afterAllRestore(): void { /* placeholder to keep hoisting simple */ }

describe('withEngineHeal', () => {
  it('known staleness (fetch failed) → resets engine cache, retries once, succeeds', async () => {
    __setAlloyForTest(fakeAlloy(['fetch failed', null]));
    const r = await withEngineHeal(async () => {
      calls.push('attempt');
      return crucibleAlloy().dispatch('t', {}, null);
    });
    expect(calls).toEqual(['attempt', 'attempt']); // retried
    expect(r).toEqual({ ok: true, result: {} });
    expect(warnings.some((w) => w.includes('engine heal'))).toBe(true);
  });

  it('session-bound signature heals too', async () => {
    __setAlloyForTest(fakeAlloy(['Session "alloy" is already bound to apple device', null]));
    const r = await withEngineHeal(async () => crucibleAlloy().dispatch('t', {}, null));
    expect(r).toEqual({ ok: true, result: {} });
  });

  it('unknown error propagates WITHOUT retry', async () => {
    __setAlloyForTest(fakeAlloy(['boom']));
    await expect(withEngineHeal(async () => crucibleAlloy().dispatch('t', {}, null))).rejects.toThrow('boom');
    expect(calls.length).toBe(0); // attempts not tracked via calls here, but no crash
  });

  it('second failure propagates (single retry only)', async () => {
    __setAlloyForTest(fakeAlloy(['fetch failed', 'fetch failed']));
    await expect(withEngineHeal(async () => crucibleAlloy().dispatch('t', {}, null))).rejects.toThrow('fetch failed');
  });
});

// restore console.warn after all tests
process.on('exit', () => { console.warn = origWarn; });
