/** runParallelBatch: per-device lane workers + batch registry (pool). */
import { describe, it, expect, beforeEach } from 'vitest';
import { runParallelBatch, abortBatch, getBatch, __resetBatchRegistry, __batchesForTest } from './pool.ts';

type Started = { runId: string; udid: string; done: Promise<void> };

function makeDeps(over: Record<string, unknown> = {}) {
  return { db: {}, bus: { emit: () => undefined }, dispatchDeps: null, artifactsDir: '/tmp/x', forgeState: { activeRunId: null }, ...over } as never;
}

/** controllable runOne: each case resolves when its gate fn fires */
function fakeRunner() {
  const gates: Array<{ resolve: () => void; reject: (e: unknown) => void }> = [];
  const calls: Array<{ templateId: string; udid: string; opts: Record<string, unknown> }> = [];
  const runOne = async (templateId: string, udid: string, opts: Record<string, unknown>): Promise<Started> => {
    calls.push({ templateId, udid, opts });
    const runId = `run_${calls.length}`;
    const done = new Promise<void>((resolve, reject) => gates.push({ resolve, reject }));
    return { runId, udid, done };
  };
  return { runOne, calls, gates };
}

const lane = (udid: string, cases: string[]) => ({
  device: { udid, name: udid },
  cases: cases.map((templateId) => ({ templateId, costMs: null })),
  costMs: 0,
});

beforeEach(() => __resetBatchRegistry());

describe('runParallelBatch (pool)', () => {
  it('runs lanes concurrently and returns per-lane results when all settle', async () => {
    const f = fakeRunner();
    const p = runParallelBatch(makeDeps(), { lanes: [lane('d1', ['a', 'b']), lane('d2', ['c'])], opts: {}, runOne: f.runOne });
    // lanes concurrent: a (d1) + c (d2) in flight; b waits for a (lane serial)
    await new Promise((r) => setTimeout(r, 20));
    expect(f.calls.map((c) => c.templateId).sort()).toEqual(['a', 'c']);
    f.gates.forEach((g) => g.resolve());
    await new Promise((r) => setTimeout(r, 20));
    f.gates.forEach((g) => g.resolve()); // b's gate
    const r = await p;
    expect(r.batchId).toBeTruthy();
    expect(r.lanes).toHaveLength(2);
    expect(r.runIds).toHaveLength(3);
    expect(getBatch(r.batchId)).toBeUndefined(); // registry cleaned on settle
  });

  it('lane is serial: case 2 dispatches only after case 1 settles', async () => {
    const f = fakeRunner();
    const p = runParallelBatch(makeDeps(), { lanes: [lane('d1', ['a', 'b'])], opts: {}, runOne: f.runOne });
    await new Promise((r) => setTimeout(r, 20));
    expect(f.calls.map((c) => c.templateId)).toEqual(['a']); // b NOT dispatched yet
    f.gates[0]!.resolve();
    await new Promise((r) => setTimeout(r, 20));
    expect(f.calls.map((c) => c.templateId)).toEqual(['a', 'b']);
    f.gates[1]!.resolve();
    await p;
  });

  it('DEVICE_BUSY on a lane halts THAT lane; siblings continue', async () => {
    const f = fakeRunner();
    const runOne: typeof f.runOne = async (templateId, udid, opts) => {
      if (templateId === 'a') {
        throw Object.assign(new Error('busy'), { code: 'DEVICE_BUSY' });
      }
      return f.runOne(templateId, udid, opts);
    };
    const p = runParallelBatch(makeDeps(), { lanes: [lane('d1', ['a', 'b']), lane('d2', ['c'])], opts: {}, runOne });
    await new Promise((r) => setTimeout(r, 20));
    f.gates.forEach((g) => g.resolve()); // settle d2's in-flight run
    const r = await p;
    expect(r.lanes.find((l) => l.device.udid === 'd1')?.haltedAt).toBe('a');
    expect(r.lanes.find((l) => l.device.udid === 'd1')?.skipped).toEqual(['b']);
    expect(r.lanes.find((l) => l.device.udid === 'd2')?.haltedAt).toBeUndefined();
    expect(r.runIds).toHaveLength(1); // only d2's run
  });

  it('rejects scenarioId when more than one lane', async () => {
    const f = fakeRunner();
    await expect(runParallelBatch(makeDeps(), {
      lanes: [lane('d1', ['a']), lane('d2', ['b'])],
      opts: { scenarioId: 'sc1' },
      runOne: f.runOne,
    })).rejects.toMatchObject({ code: 'PARALLEL_SCENARIO_UNSUPPORTED' });
    expect(f.calls).toHaveLength(0);
  });

  it('abort: pending cases skipped, in-flight results still collected', async () => {
    const f = fakeRunner();
    const p = runParallelBatch(makeDeps(), { lanes: [lane('d1', ['a', 'b'])], opts: {}, runOne: f.runOne });
    await new Promise((r) => setTimeout(r, 20));
    const bid = [...__batchesForTest().keys()][0]!;
    expect(abortBatch(bid)).toBe(true);
    f.gates[0]!.resolve();
    const r = await p;
    expect(r.aborted).toBe(true);
    expect(r.lanes[0]!.skipped).toContain('b');
    expect(f.calls.map((c) => c.templateId)).toEqual(['a']); // b never dispatched
  });
});
