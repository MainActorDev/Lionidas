import { describe, it, expect } from 'vitest';
import { mapExitCode, awaitRuns, fetchFailedStep, type RunSummary } from '../src/cli/runner.ts';

function fakeFetch(responses: Array<{ status: number; body: unknown }>): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const f = (async (url: string) => {
    calls.push(url);
    const r = responses[Math.min(i, responses.length - 1)]!;
    i++;
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

const runRow = (id: string, status: string) => ({ id, status, note: null, template_id: 'tpl_x', ticket_key: 'T', artifact_path: null, started_at: 1, finished_at: 2 });

describe('mapExitCode', () => {
  const rs = (statuses: string[]): RunSummary[] => statuses.map((s, i) => ({ runId: `r${i}`, status: s, note: null, templateId: null, ticketKey: null, artifactPath: null, startedAt: null, finishedAt: null }));
  it('all passed → 0', () => expect(mapExitCode(rs(['passed', 'passed']))).toBe(0));
  it('any failed → 1 (outranks infra)', () => {
    expect(mapExitCode(rs(['passed', 'failed']), { kind: 'timeout' })).toBe(1);
  });
  it('infra → 2', () => expect(mapExitCode(rs(['passed']), { kind: 'timeout' })).toBe(2));
  it('aborted without infra → 2', () => expect(mapExitCode(rs(['aborted']))).toBe(2));
  it('empty suite → 2', () => expect(mapExitCode([])).toBe(2));
});

describe('awaitRuns', () => {
  it('resolves when all runs are terminal; enriches failures with failed step', async () => {
    const { fetch } = fakeFetch([
      { status: 200, body: { runs: [runRow('r1', 'running'), runRow('r2', 'passed')] } },
      { status: 200, body: { runs: [runRow('r1', 'failed', ), runRow('r2', 'passed')] } },
      { status: 200, body: { steps: [{ idx: 2, name: 'expect contains: X', status: 'fail', reason: 'not found: X' }] } },
    ]);
    const out = await awaitRuns('http://x', ['r1', 'r2'], {
      fetch, pollMs: 1, timeoutMs: 1000,
      fetchSteps: (base, id) => fetchFailedStep(fetch, base, id),
    });
    expect(out.runs).toHaveLength(2);
    const failed = out.runs.find((r) => r.runId === 'r1')!;
    expect(failed.status).toBe('failed');
    expect(failed.failedStep).toEqual({ idx: 2, name: 'expect contains: X', reason: 'not found: X' });
    expect(out.infra).toBeUndefined();
  });

  it('timeout → infra {kind:timeout}, partial runs returned', async () => {
    const { fetch } = fakeFetch([{ status: 200, body: { runs: [runRow('r1', 'running')] } }]);
    const out = await awaitRuns('http://x', ['r1'], { fetch, pollMs: 1, timeoutMs: 10 });
    expect(out.infra).toEqual({ kind: 'timeout' });
  });

  it('endpoint not ok → infra connect', async () => {
    const { fetch } = fakeFetch([{ status: 503, body: { error: 'down' } }]);
    const out = await awaitRuns('http://x', ['r1'], { fetch, pollMs: 1, timeoutMs: 100 });
    expect(out.infra?.kind).toBe('connect');
  });
});

describe('fetchFailedStep', () => {
  it('returns first fail; null when endpoint refuses', async () => {
    const ok = fakeFetch([{ status: 200, body: { steps: [{ idx: 0, name: 'a', status: 'pass', reason: null }, { idx: 1, name: 'b', status: 'fail', reason: 'boom' }] } }]);
    expect(await fetchFailedStep(ok.fetch, 'http://x', 'r1')).toEqual({ idx: 1, name: 'b', reason: 'boom' });
    const bad = fakeFetch([{ status: 404, body: {} }]);
    expect(await fetchFailedStep(bad.fetch, 'http://x', 'r1')).toBeNull();
  });
});
