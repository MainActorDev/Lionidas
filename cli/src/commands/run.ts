/** run get|steps|abort|list|triage|evidence|attach — reading runs, triaging
 *  failures, pulling evidence artifacts (phase 3, plan 20260930T092035Z). */
import type { CAC } from 'cac';
import { sub } from '../cmd.ts';
import { makeClient } from '../client.ts';
import { print, line } from '../output.ts';
import { writeFileSync } from 'node:fs';

export function runCommand(cli: CAC): void {
  const r = sub(cli, 'run <action> [runId] [arg]', 'runs');
  r.option('--status <s>', 'filter by status (list) — exact | active | blocked');
  r.option('--template <id>', 'filter by case (list)');
  r.option('--suite <id>', 'filter by suite (list; unassigned)');
  r.option('--variant <id>', 'filter by variant (list)');
  r.option('--ticket <key>', 'filter by ticket (list)');
  r.option('--limit <n>', 'page size (list)', { default: 25 });
  r.option('--out <file>', 'output path (evidence)');
  r.option('--json', 'machine-readable output');
  r.action(async (action: string, runId: string | undefined, arg: string | undefined, opts: {
    status?: string; template?: string; suite?: string; variant?: string; ticket?: string; limit?: number; out?: string; json?: boolean;
  }) => {
    const client = makeClient();

    if (action === 'list') {
      const q = new URLSearchParams();
      if (opts.status) q.set('status', opts.status);
      if (opts.template) q.set('template', opts.template);
      if (opts.suite) q.set('suite', opts.suite);
      if (opts.variant) q.set('variant', opts.variant);
      if (opts.ticket) q.set('ticket', opts.ticket);
      q.set('limit', String(opts.limit ?? 25));
      const res = await client.get<{ runs?: Array<{ id: string; status: string; started_at?: number | null; finished_at?: number | null; template_id?: string; note?: string | null; triggered_by?: string | null }> }>(`/api/runs?${q}`);
      const runs = res.runs ?? [];
      print(runs, () => {
        for (const run of runs) {
          const when = run.started_at ? new Date(run.started_at).toLocaleString() : '?';
          line(`${run.id}  ${run.status.padEnd(8)} ${when}  ${run.template_id ?? ''}${run.triggered_by ? `  (${run.triggered_by})` : ''}`);
        }
      });
      return;
    }

    if (!runId) throw new Error(`run ${action} needs <runId>`);

    if (action === 'get') {
      const run = await client.get<Record<string, unknown>>(`/api/runs/${runId}`);
      print(run, () => line(JSON.stringify(run, null, 2)));
      return;
    }

    if (action === 'steps') {
      const r2 = await client.get<{ steps?: Array<{ idx: number; name: string; status: string; reason?: string | null; narrate?: string | null; duration_ms?: number | null }> }>(`/api/runs/${runId}/steps`);
      print(r2.steps ?? [], () => {
        for (const s of r2.steps ?? []) line(`[${s.status}] ${s.idx}. ${s.name}${s.narrate ? ` — ${s.narrate}` : ''}${s.reason ? ` (${s.reason})` : ''}${s.duration_ms != null ? ` ${s.duration_ms}ms` : ''}`);
      });
      return;
    }

    if (action === 'abort') {
      const out = await client.post<{ ok?: boolean; error?: string }>(`/api/runs/${runId}/abort`);
      print(out, () => line(out.ok ? 'aborted' : (out.error ?? 'abort sent')));
      return;
    }

    if (action === 'triage') {
      if (arg === undefined) throw new Error('run triage needs <runId> <stepIdx>');
      const t = await client.get<{ step?: { idx: number; flow?: string; status: string; reason?: string | null; durationMs?: number; waitMs?: number | null; workMs?: number | null }; evidence?: Array<{ id: string; type: string; path?: string; bytes?: number }>; runEvidence?: Array<{ id: string; type: string }>; run?: Record<string, unknown> }>(`/api/runs/${runId}/steps/${arg}/triage`);
      print(t, () => {
        line(`step ${t.step?.idx}: ${t.step?.status}${t.step?.reason ? ` — ${t.step.reason}` : ''}`);
        line(`timing: ${t.step?.durationMs ?? '?'}ms (wait ${t.step?.waitMs ?? '?'}, work ${t.step?.workMs ?? '?'})`);
        for (const e of t.evidence ?? []) line(`  evidence ${e.id}  ${e.type}  ${e.bytes ?? 0}B`);
        for (const e of t.runEvidence ?? []) line(`  run-level ${e.id}  ${e.type}`);
        if (t.run?.ticket) line(`ticket: ${String(t.run.ticket)}`);
      });
      return;
    }

    if (action === 'evidence') {
      // `run evidence <evidenceId>` — the id lands in the runId positional
      const evid = arg ?? runId;
      if (!evid) throw new Error('run evidence needs <evidenceId>');
      const res = await client.request<Response>('GET', `/api/evidence/${encodeURIComponent(evid)}/file`, undefined, { raw: true, timeoutMs: 120_000 }) as unknown as Response;
      const buf = Buffer.from(await res.arrayBuffer());
      if (opts.out) { writeFileSync(opts.out, buf); print({ id: evid, out: opts.out, bytes: buf.length }, () => line(`written ${opts.out} (${buf.length} bytes)`)); return; }
      process.stdout.write(buf);
      return;
    }

    if (action === 'attach') {
      const out = await client.post<{ attached?: boolean; commentId?: string; ticket?: string; error?: string }>(`/api/runs/${runId}/attach`, {});
      print(out, () => line(out.attached ? `attached to ${out.ticket} (comment ${out.commentId})` : (out.error ?? 'attach failed')));
      if (!out.attached) process.exitCode = 1;
      return;
    }

    throw new Error(`unknown run action "${action}" (list | get | steps | abort | triage | evidence | attach)`);
  });
}

/** queue list|abort — the run queue. */
export function queueCommand(cli: CAC): void {
  const q = sub(cli, 'queue <action> [queueId]', 'run queue');
  q.option('--json', 'machine-readable output');
  q.action(async (action: string, queueId: string | undefined) => {
    const client = makeClient();
    if (action === 'list') {
      const r = await client.get<{ queue?: Array<Record<string, unknown>> }>('/api/queue');
      print(r.queue ?? [], () => { line(JSON.stringify(r.queue ?? [], null, 2)); });
      return;
    }
    if (action === 'abort') {
      if (!queueId) throw new Error('queue abort needs <queueId>');
      const r = await client.del<{ aborted?: boolean; error?: string }>(`/api/queue/${encodeURIComponent(queueId)}`);
      print(r, () => line(r.aborted ? `aborted ${queueId}` : (r.error ?? 'not abortable')));
      if (!r.aborted) process.exitCode = 1;
      return;
    }
    throw new Error(`unknown queue action "${action}" (list | abort)`);
  });
}

/** flake list|quarantine|release — per-flow flake scores. */
export function flakeCommand(cli: CAC): void {
  const f = sub(cli, 'flake <action> [flow]', 'flake scores + quarantine');
  f.option('--reason <text>', 'auditable reason (quarantine/release)');
  f.option('--json', 'machine-readable output');
  f.action(async (action: string, flow: string | undefined, opts: { reason?: string; json?: boolean }) => {
    const client = makeClient();
    if (action === 'list') {
      const r = await client.get<{ flakes?: Array<{ flow: string; score: number; recent: string[]; quarantined: boolean; quarantineReason?: string | null }> }>('/api/flakes');
      const list = r.flakes ?? [];
      print(list, () => {
        for (const x of list) line(`${x.quarantined ? '🔒' : '  '} ${x.flow}  score ${x.score}${x.quarantined ? `  — ${x.quarantineReason}` : ''}`);
      });
      return;
    }
    if (action === 'quarantine' || action === 'release') {
      if (!flow) throw new Error(`flake ${action} needs <flowKey>`);
      if (!opts.reason) throw new Error(`flake ${action} needs --reason (auditable decisions)`);
      if (action === 'quarantine') {
        const r = await client.post<{ quarantined?: boolean; error?: string }>(`/api/flows/${encodeURIComponent(flow)}/quarantine`, { reason: opts.reason });
        print(r, () => line(r.quarantined ? `quarantined ${flow}` : (r.error ?? 'failed')));
        if (!r.quarantined) process.exitCode = 1;
      } else {
        const r = await client.request<{ released?: boolean; error?: string }>('DELETE', `/api/flows/${encodeURIComponent(flow)}/quarantine`, { reason: opts.reason });
        print(r, () => line(r.released ? `released ${flow}` : (r.error ?? 'failed')));
        if (!r.released) process.exitCode = 1;
      }
      return;
    }
    throw new Error(`unknown flake action "${action}" (list | quarantine | release)`);
  });
}
