/** CI runner core — poll runs to terminal state, map to CI exit codes.
 *  Pure (fetch injected) so tests drive it without a server. */

export interface FetchLike {
  (url: string, init?: RequestInit): Promise<Response>;
}

export interface RunSummary {
  runId: string;
  status: string;          // queued|running|passed|failed|aborted
  note: string | null;
  templateId: string | null;
  templateName?: string | null;
  ticketKey: string | null;
  artifactPath: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  failedStep?: FailedStep | null | undefined;
}

export type InfraError = { kind: 'timeout' } | { kind: 'connect'; message: string } | { kind: 'batch'; message: string };

/** 0 = all passed · 1 = any app failure · 2 = infra. App failure outranks
 *  infra when both occur in one invocation (edge 3, plan). */
export function mapExitCode(runs: RunSummary[], infra?: InfraError): number {
  if (runs.some((r) => r.status === 'failed')) return 1;
  if (infra) return 2;
  if (runs.length === 0) return 2; // empty suite = config error
  if (runs.some((r) => r.status !== 'passed')) return 2; // aborted/unknown
  return 0;
}

export interface AwaitRunsOpts {
  fetch?: FetchLike;
  timeoutMs?: number;
  pollMs?: number;
  fetchSteps?: (baseUrl: string, runId: string) => Promise<FailedStep | null | undefined>;
}
export interface FailedStep { idx: number; name: string; reason: string | null }

/** Poll GET /api/runs?limit=200 once per tick; resolve when every runId is
 *  terminal. Failed runs get their first failed step fetched (one extra
 *  request each, after terminality — not during). */
export async function awaitRuns(
  baseUrl: string,
  runIds: string[],
  opts: AwaitRunsOpts,
): Promise<{ runs: RunSummary[]; infra?: InfraError }> {
  const doFetch: FetchLike = opts.fetch ?? ((u: string, i?: RequestInit) => fetch(u, i));
  const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
  const pollMs = opts.pollMs ?? 1000;
  const deadline = Date.now() + timeoutMs;
  const terminal = new Set(['passed', 'failed', 'aborted']);
  const pending = new Set(runIds);
  const byId = new Map<string, RunSummary>();

  while (pending.size > 0) {
    if (Date.now() > deadline) {
      return { runs: [...byId.values()], infra: { kind: 'timeout' } };
    }
    let resp: Response;
    try {
      resp = await doFetch(`${baseUrl}/api/runs?limit=200`);
    } catch (err) {
      if (pending.size > 0 && Date.now() > deadline - timeoutMs + 30_000) {
        // server vanished mid-run — brief blips retry, sustained loss fails infra
        return { runs: [...byId.values()], infra: { kind: 'connect', message: err instanceof Error ? err.message : String(err) } };
      }
      await new Promise((r) => setTimeout(r, pollMs));
      continue;
    }
    if (!resp.ok) {
      return { runs: [...byId.values()], infra: { kind: 'connect', message: `runs endpoint ${resp.status}` } };
    }
    const body = (await resp.json()) as { runs?: Array<Record<string, unknown>> };
    for (const row of body.runs ?? []) {
      const id = row['id'] as string;
      if (!pending.has(id)) continue;
      const status = row['status'] as string;
      if (!terminal.has(status)) continue;
      pending.delete(id);
      byId.set(id, {
        runId: id,
        status,
        note: (row['note'] as string | null) ?? null,
        templateId: (row['template_id'] as string | null) ?? null,
        ticketKey: (row['ticket_key'] as string | null) ?? null,
        artifactPath: (row['artifact_path'] as string | null) ?? null,
        startedAt: (row['started_at'] as number | null) ?? null,
        finishedAt: (row['finished_at'] as number | null) ?? null,
      });
    }
    if (pending.size > 0) await new Promise((r) => setTimeout(r, pollMs));
  }

  // enrich failures with their first failed step
  const runs = [...byId.values()];
  for (const r of runs) {
    if (r.status === 'failed' && opts.fetchSteps) {
      r.failedStep = await opts.fetchSteps(baseUrl, r.runId).catch(() => null);
    }
  }
  return { runs };
}

/** First failed step via GET /api/runs/:id/steps (Task 4 endpoint). */
export async function fetchFailedStep(fetcher: FetchLike, baseUrl: string, runId: string): Promise<RunSummary['failedStep']> {
  const resp = await fetcher(`${baseUrl}/api/runs/${runId}/steps`);
  if (!resp.ok) return null;
  const body = (await resp.json()) as { steps?: Array<{ idx: number; name: string; status: string; reason: string | null }> };
  const fail = (body.steps ?? []).find((s) => s.status === 'fail');
  return fail ? { idx: fail.idx, name: fail.name, reason: fail.reason } : null;
}
