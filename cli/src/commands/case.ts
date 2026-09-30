/** case list|new|get|edit|run|verify — the agent loop (phase 1). */
import type { CAC } from 'cac';
import { sub } from '../cmd.ts';
import { readFileSync } from 'node:fs';
import { makeClient } from '../client.ts';
import { print, line } from '../output.ts';

function stdinOrFile(file: string): string {
  if (file === '-') return readFileSync(0, 'utf8');
  return readFileSync(file, 'utf8');
}

export function caseCommand(cli: CAC): void {
  const c = sub(cli, 'case <action> [target]', 'test cases');
  c.option('--app <bundle>', 'filter / target app bundle');
  c.option('--folder <path>', 'folder filter');
  c.option('--device <udid>', 'device to run on');
  c.option('--variant <id>', 'pin one variant');
  c.option('--env <k=v>', 'request env override (repeatable)', { type: [] });
  c.option('--wait', 'wait for the run to finish (default)', { default: true });
  c.option('--no-wait', 'fire and print the run id');
  c.option('--timeout <seconds>', 'run wait timeout', { default: 600 });
  c.option('--name <name>', 'new name (duplicate)');
  c.option('--force', 'skip guards');
  c.action(async (action: string, target: string | undefined, opts: {
    app?: string; folder?: string; device?: string; variant?: string; env?: string[] | string;
    wait?: boolean; timeout?: number; name?: string; force?: boolean; json?: boolean;
  }) => {
    const client = makeClient();
    const envPairs = (Array.isArray(opts.env) ? opts.env : typeof opts.env === 'string' ? [opts.env] : []).filter((kv): kv is string => typeof kv === 'string').reduce<Record<string, string>>((acc, kv) => {
      const [k, ...rest] = kv.split('=');
      if (k) acc[k] = rest.join('=');
      return acc;
    }, {});

    if (action === 'list') {
      const q = new URLSearchParams();
      if (opts.app) q.set('app', opts.app);
      const r = await client.get<{ templates?: Array<{ id: string; name: string; folder?: string | null; status?: string }> }>(`/api/templates${q.size ? `?${q}` : ''}`);
      print(r.templates ?? [], () => {
        for (const t of (r.templates ?? [])) line(`${t.id}  ${t.name}${t.folder ? `  (${t.folder})` : ''}`);
      });
      return;
    }
    if (action === 'new') {
      if (!target) throw new Error('case new needs <file.yaml|->');
      const r = await client.post<{ id?: string; error?: string }>('/api/templates/yaml/validate', { yaml: stdinOrFile(target) });
      void r;
      const created = await client.post<{ id?: string }>('/api/templates', { name: `case-${Date.now()}`, steps: [] });
      void created;
      throw new Error('case new via raw yaml lands with the yaml PUT route in phase 1 build-out (stage 0 scope: surface registered)');
    }
    if (['get', 'edit', 'run', 'verify'].includes(action)) {
      if (!target) throw new Error(`case ${action} needs <id|name>`);
      const id = await client.resolveCase(target);
      if (action === 'get') {
        const r = await client.get<Record<string, unknown>>(`/api/templates/${id}`);
        print(r, () => line(JSON.stringify(r, null, 2)));
        return;
      }
      if (action === 'run' || action === 'verify') {
        const body: Record<string, unknown> = {};
        if (opts.device) body['udid'] = opts.device;
        if (opts.variant) body['variant'] = opts.variant;
        if (Object.keys(envPairs).length) body['env'] = envPairs;
        const r = await client.post<{ runId?: string; runIds?: string[]; error?: string }>(`/api/templates/${id}/play`, body);
        const runId = r.runId ?? r.runIds?.[0];
        if (!runId) throw new Error(r.error ?? 'no run id returned');
        if (opts.wait === false) { print({ runId }, () => line(runId)); return; }
        const deadline = Date.now() + (opts.timeout ?? 600) * 1000;
        let run: { status?: string; note?: string } = {};
        while (Date.now() < deadline) {
          const row = await client.get<{ run?: { status?: string; note?: string }; status?: string; note?: string }>(`/api/runs/${runId}`);
          run = row.run ?? row; // route wraps single-run responses in {run: …}
          if (run.status && !['running', 'queued'].includes(run.status)) break;
          await new Promise((res) => setTimeout(res, 2000));
        }
        const stepsRow = await client.get<{ steps?: Array<{ idx: number; name: string; status: string; reason?: string | null; narrate?: string | null }> }>(`/api/runs/${runId}/steps`);
        const steps = stepsRow.steps ?? (Array.isArray(stepsRow) ? stepsRow : { steps: [] });
        const stepList = Array.isArray(steps) ? steps : steps.steps ?? [];
        print({ runId, status: run.status, note: run.note, steps: stepList }, () => {
          line(`run ${runId}: ${run.status}`);
          for (const s of stepList) line(`  [${s.status}] ${s.idx}. ${s.name}${s.narrate ? ` — ${s.narrate}` : ''}${s.reason ? ` (${s.reason})` : ''}`);
        });
        if (action === 'verify') {
          if (run.status === 'passed') { print({ verdict: 'pass', exit: 0 }, () => line('verdict: PASS')); return; }
          if (run.status === 'failed') { print({ verdict: 'fail', exit: 1 }, () => line('verdict: FAIL — triage above')); process.exitCode = 1; return; }
          print({ verdict: 'infra', exit: 2 }, () => line(`verdict: INFRA (${run.status}) — fix the environment and re-run`));
          process.exitCode = 2;
          return;
        }
        return;
      }
      throw new Error('case edit lands in phase 1 build-out (stage 0 scope: surface registered)');
    }
    throw new Error(`unknown case action "${action}" (list | new | get | edit | run | verify)`);
  });
}
