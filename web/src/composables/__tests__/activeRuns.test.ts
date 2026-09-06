/** activeRuns tracker: seed → events → interlock lookups. Pure (test seams
 *  drive state; no WS/fetch in these tests). */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  useActiveRuns,
  __resetActiveRunsForTest,
  __onEventForTest,
  __seedForTest,
} from '../activeRuns.ts';

const ev = (type: string, payload: Record<string, unknown>) => ({ type, payload, at: Date.now() });

beforeEach(() => __resetActiveRunsForTest());

describe('activeRuns tracker', () => {
  it('run.started adds; isRunning + activeRun resolve by template', () => {
    __onEventForTest(ev('run.started', { runId: 'r1', templateId: 't1', udid: 'u' }));
    const t = useActiveRuns();
    expect(t.isRunning('t1')).toBe(true);
    expect(t.activeRun('t1')?.runId).toBe('r1');
    expect(t.isRunning('t2')).toBe(false);
  });

  it('run.started WITHOUT templateId still tracks the runId (no template index)', () => {
    __onEventForTest(ev('run.started', { runId: 'r2', ticketKey: 'X' }));
    const t = useActiveRuns();
    expect(t.isRunning('anything')).toBe(false);
    expect(t.all()).toHaveLength(1);
  });

  it('run.finished removes the run and its template index', () => {
    __onEventForTest(ev('run.started', { runId: 'r1', templateId: 't1' }));
    __onEventForTest(ev('run.finished', { runId: 'r1', status: 'passed' }));
    const t = useActiveRuns();
    expect(t.isRunning('t1')).toBe(false);
    expect(t.all()).toHaveLength(0);
  });

  it('run.aborted with runId removes (click-time ack path)', () => {
    __onEventForTest(ev('run.started', { runId: 'r1', templateId: 't1' }));
    __onEventForTest(ev('run.aborted', { queueId: 'r1', runId: 'r1', templateId: 't1' }));
    expect(useActiveRuns().isRunning('t1')).toBe(false);
  });

  it('run.aborted with ONLY queueId removes by that id (queue-dispatch path)', () => {
    __onEventForTest(ev('run.started', { runId: 'q9', templateId: 't9' }));
    __onEventForTest(ev('run.aborted', { queueId: 'q9' }));
    expect(useActiveRuns().isRunning('t9')).toBe(false);
  });

  it('template index does not dangle when a NEWER run replaced it and the OLD one finishes', () => {
    __onEventForTest(ev('run.started', { runId: 'r1', templateId: 't1' }));
    __onEventForTest(ev('run.started', { runId: 'r2', templateId: 't1' }));
    __onEventForTest(ev('run.finished', { runId: 'r1', status: 'passed' }));
    const t = useActiveRuns();
    expect(t.isRunning('t1')).toBe(true); // r2 still live
    expect(t.activeRun('t1')?.runId).toBe('r2');
  });

  it('seed rows populate lookups (refresh mid-run)', () => {
    __seedForTest([
      { runId: 'rA', templateId: 'tA', startedAt: 1 },
      { runId: 'rB', templateId: null, startedAt: 2 },
    ]);
    const t = useActiveRuns();
    expect(t.isRunning('tA')).toBe(true);
    expect(t.all()).toHaveLength(2);
  });

  it('unknown-template events are ignored (no crash, no state change)', () => {
    __onEventForTest(ev('step.started', { runId: 'zz', idx: 0 }));
    expect(useActiveRuns().all()).toHaveLength(0);
  });
});
