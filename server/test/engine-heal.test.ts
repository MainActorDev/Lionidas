import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { dispatchWithHeal } from '../src/alloy/heal.ts';
import { __setAlloyForTest, type AlloyExports } from '../src/alloy/client.ts';

// ⚔ REAL dispatch contract: engine errors are returned IN-BAND as
// {ok:false,error} — dispatch NEVER throws them (only config-level errors
// throw). The original tests faked a throwing dispatch, so the heal looked
// correct while never firing in production. Fakes here match the real shape.
let warnings: string[];
let resets: number;
const origWarn = console.warn;
beforeEach(() => {
  warnings = [];
  resets = 0;
  console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(' ')); };
});
afterEach(() => {
  console.warn = origWarn;
  __setAlloyForTest(null);
});

function fakeAlloy(failures: Array<{ code: string; message: string } | null>): AlloyExports {
  let calls = 0;
  return {
    dispatch: async () => {
      const f = failures[calls++] ?? null;
      if (f) return { ok: false, error: f };
      return { ok: true, result: {} };
    },
    resetEngineACache: () => { resets++; },
    resetEngineBCache: () => { resets++; },
  } as unknown as AlloyExports;
}

describe('dispatchWithHeal (in-band envelope contract)', () => {
  it('IN-BAND fetch failed → resets engine clients, retries once, succeeds', async () => {
    __setAlloyForTest(fakeAlloy([
      { code: 'COMMAND_FAILED', message: 'simulator-stream: fetch failed' }, null,
    ]));
    const r = await dispatchWithHeal('alloy_stream', { udid: 'x' }, null);
    expect(r.ok).toBe(true);
    expect(resets).toBe(2); // A + B cache reset
    expect(warnings.some((w) => w.includes('engine heal'))).toBe(true);
  });

  it('in-band session-bound signature heals too', async () => {
    __setAlloyForTest(fakeAlloy([
      { code: 'SESSION_HELD', message: 'Session "alloy" is already bound to apple device' }, null,
    ]));
    const r = await dispatchWithHeal('alloy_apps', {}, null);
    expect(r.ok).toBe(true);
    expect(resets).toBe(2);
  });

  it('in-band ECONNREFUSED heals', async () => {
    __setAlloyForTest(fakeAlloy([{ code: 'COMMAND_FAILED', message: 'connect ECONNREFUSED 127.0.0.1:52310' }, null]));
    const r = await dispatchWithHeal('alloy_stream', {}, null);
    expect(r.ok).toBe(true);
  });

  it('unknown in-band error passes through WITHOUT retry (no reset)', async () => {
    __setAlloyForTest(fakeAlloy([{ code: 'VALIDATION_FAILED', message: 'bad input' }]));
    const r = await dispatchWithHeal('alloy_stream', {}, null);
    expect(r.ok).toBe(false);
    expect(resets).toBe(0);
    expect(warnings.length).toBe(0);
  });

  it('second in-band failure returns it (single retry only)', async () => {
    __setAlloyForTest(fakeAlloy([
      { code: 'COMMAND_FAILED', message: 'simulator-stream: fetch failed' },
      { code: 'COMMAND_FAILED', message: 'simulator-stream: fetch failed' },
    ]));
    const r = await dispatchWithHeal('alloy_stream', {}, null);
    expect(r.ok).toBe(false);
    expect(r.error?.message).toContain('fetch failed');
  });

  it('thrown staleness error still heals (config-path throws)', async () => {
    let calls = 0;
    __setAlloyForTest({
      dispatch: async () => {
        calls++;
        if (calls === 1) throw new Error('simulator-stream: fetch failed');
        return { ok: true, result: {} };
      },
      resetEngineBCache: () => { resets++; },
    } as unknown as AlloyExports);
    const r = await dispatchWithHeal('alloy_stream', {}, null);
    expect(r.ok).toBe(true);
    expect(resets).toBe(1);
  });

  it('thrown unknown error propagates', async () => {
    __setAlloyForTest({
      dispatch: async () => { throw new Error('boom'); },
    } as unknown as AlloyExports);
    await expect(dispatchWithHeal('alloy_stream', {}, null)).rejects.toThrow('boom');
  });

  it('older alloy dist without reset seams still heals (local fallback reset)', async () => {
    let calls = 0;
    __setAlloyForTest({
      dispatch: async () => {
        calls++;
        if (calls === 1) return { ok: false, error: { code: 'COMMAND_FAILED', message: 'simulator-stream: fetch failed' } };
        return { ok: true, result: {} };
      },
      // no resetEngine*Cache exports — the optional-call seam must not throw
    } as unknown as AlloyExports);
    const r = await dispatchWithHeal('alloy_stream', {}, null);
    expect(r.ok).toBe(true);
    expect(warnings.some((w) => w.includes('engine heal'))).toBe(true);
  });
});
