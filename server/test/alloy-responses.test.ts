import { describe, it, expect } from 'vitest';
import { decodeSnapshotResult, decodeAlertInspect, classifyEngineError, type DispatchResult } from '../src/alloy/responses.ts';

describe('decodeSnapshotResult', () => {
  it('returns nodes from a well-shaped result', () => {
    const r = { ok: true, result: { nodes: [{ index: 0, label: 'A' }] } } as DispatchResult;
    expect(decodeSnapshotResult(r)).toEqual([{ index: 0, label: 'A' }]);
  });
  it('null on failed dispatch / missing nodes / wrong shape', () => {
    expect(decodeSnapshotResult({ ok: false, error: { message: 'x' } } as DispatchResult)).toBeNull();
    expect(decodeSnapshotResult({ ok: true, result: {} } as DispatchResult)).toBeNull();
    expect(decodeSnapshotResult({ ok: true, result: { nodes: 'nope' } } as DispatchResult)).toBeNull();
  });
});

describe('decodeAlertInspect', () => {
  it('ok + message = present', () => {
    expect(decodeAlertInspect({ ok: true, result: { message: 'Allow location?' } } as DispatchResult))
      .toEqual({ present: true, message: 'Allow location?' });
  });
  it('ok:false "alert not found" = absent (probed engine contract)', () => {
    expect(decodeAlertInspect({ ok: false, error: { message: 'alloy_alert: alert not found' } } as DispatchResult))
      .toEqual({ present: false });
  });
  it('ok without message = error, never presence', () => {
    const r = decodeAlertInspect({ ok: true, result: {} } as DispatchResult);
    expect('error' in r && r.error).toBeDefined();
  });
});

describe('classifyEngineError', () => {
  it('runner-busy by code or message (typed first)', () => {
    expect(classifyEngineError({ ok: false, error: { code: 'RUNNER_BUSY', message: 'whatever' } } as DispatchResult)).toBe('runner-busy');
    expect(classifyEngineError({ ok: false, error: { message: 'The iOS runner is still finishing a previous command' } } as DispatchResult)).toBe('runner-busy');
  });
  it('already-recording / session-claimed / fetch-failed', () => {
    expect(classifyEngineError({ ok: false, error: { message: 'A video recording is already active on device X' } } as DispatchResult)).toBe('already-recording');
    expect(classifyEngineError({ ok: false, error: { message: 'ios device X is owned by session "alloy"' } } as DispatchResult)).toBe('session-claimed');
    expect(classifyEngineError({ ok: false, error: { message: 'fetch failed' } } as DispatchResult)).toBe('fetch-failed');
  });
  it('unknown → other (fails closed)', () => {
    expect(classifyEngineError({ ok: false, error: { message: 'mystery' } } as DispatchResult)).toBe('other');
    expect(classifyEngineError({ ok: true, result: {} } as DispatchResult)).toBe('other');
  });
});
