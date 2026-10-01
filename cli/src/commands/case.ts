/** case list|yaml|new|get|edit|duplicate|delete|versions|export|import|run|verify
 *  — the authoring + agent-loop surface (plan 20260930T092035Z phase 2).
 *  yaml round-trip is THE write path: validate → PUT. */
import type { CAC } from 'cac';
import { sub } from '../cmd.ts';
import { readFileSync, writeFileSync } from 'node:fs';
import { makeClient } from '../client.ts';
import { print, line } from '../output.ts';

function stdinOrFile(file: string): string {
  if (file === '-') return readFileSync(0, 'utf8');
  return readFileSync(file, 'utf8');
}

export function caseCommand(cli: CAC): void {
  const c = sub(cli, 'case <action> [target] [file]', 'test cases');
  c.option('--app <bundle>', 'filter / target app bundle');
  c.option('--folder <path>', 'folder filter (list)');
  c.option('--device <udid>', 'device to run on');
  c.option('--variant <id>', 'pin one variant');
  c.option('--env <k=v>', 'request env override (repeatable)', { type: [] });
  c.option('--no-wait', 'fire and print the run id');
  c.option('--timeout <seconds>', 'run wait timeout', { default: 600 });
  c.option('--name <name>', 'new name (duplicate)');
  c.option('--force', 'skip guards');
  c.option('--out <file>', 'output path (yaml/export)');
  c.action(async (action: string, target: string | undefined, file: string | undefined, opts: {
    app?: string; folder?: string; device?: string; variant?: string; env?: string[] | string;
    wait?: boolean; timeout?: number; name?: string; force?: boolean; out?: string; json?: boolean;
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
      let list = r.templates ?? [];
      if (opts.folder) list = list.filter((t) => (t.folder ?? '') === opts.folder || (t.folder ?? '').startsWith(`${opts.folder}/`));
      print(list, () => { for (const t of list) line(`${t.id}  ${t.status === 'deprecated' ? '[deprecated] ' : ''}${t.name}${t.folder ? `  (${t.folder})` : ''}`); });
      return;
    }

    if (action === 'yaml') {
      if (!target) throw new Error('case yaml needs <id|name>');
      const id = await client.resolveCase(target);
      const r = await client.get<{ yaml?: string }>(`/api/templates/${id}/yaml`);
      const yaml = r.yaml ?? '';
      if (opts.out) { writeFileSync(opts.out, yaml); print({ id, out: opts.out }, () => line(`written ${opts.out}`)); return; }
      print(yaml, () => process.stdout.write(yaml));
      return;
    }

    if (action === 'new') {
      if (!target) throw new Error('case new needs <file.yaml|->');
      const yaml = stdinOrFile(target);
      // one validator: the server's PUT path (create shell via import-style single doc → same seam)
      const v = await client.post<{ ok?: boolean; errors?: Array<{ message?: string } | string> }>('/api/templates/yaml/validate', { yaml });
      if (!v.ok) {
        const msgs = (v.errors ?? []).map((e) => (typeof e === 'string' ? e : e.message ?? '')).join('; ');
        throw new Error(`invalid case yaml: ${msgs}`);
      }
      // import IS the create-from-yaml seam (single doc, single transaction, folder chain resolve-or-create)
      const imp = await client.post<{ imported?: Array<{ id: string; name: string }>; error?: string }>('/api/templates/import', { yaml });
      const row = imp.imported?.[0];
      if (!row) throw new Error(imp.error ?? 'import failed');
      print(row, () => line(`${row.id}  ${row.name}`));
      return;
    }

    if (action === 'get') {
      if (!target) throw new Error('case get needs <id|name>');
      const id = await client.resolveCase(target);
      const r = await client.get<Record<string, unknown>>(`/api/templates/${id}`);
      print(r, () => line(JSON.stringify(r, null, 2)));
      return;
    }

    if (action === 'edit') {
      if (!target || !file) throw new Error('case edit needs <id|name> <file.yaml|->');
      const id = await client.resolveCase(target);
      const yaml = stdinOrFile(file);
      const saved = await client.put<Record<string, unknown>>(`/api/templates/${id}/yaml`, { yaml });
      print(saved, () => line(`saved ${id}`));
      return;
    }

    if (action === 'duplicate') {
      if (!target) throw new Error('case duplicate needs <id|name>');
      const id = await client.resolveCase(target);
      const r = await client.post<{ id?: string; name?: string }>(`/api/templates/${id}/duplicate`, opts.name ? { name: opts.name } : {});
      print(r, () => line(`${r.id}  ${r.name ?? ''}`));
      return;
    }

    if (action === 'delete') {
      if (!target) throw new Error('case delete needs <id|name>');
      const id = await client.resolveCase(target);
      const r = await client.del<{ ok?: boolean; error?: string }>(`/api/templates/${id}`);
      print(r, () => line(`deleted ${id}`));
      return;
    }

    if (action === 'versions') {
      if (!target) throw new Error('case versions needs <id|name>');
      const id = await client.resolveCase(target);
      const r = await client.get<{ versions?: Array<{ revision: number; source: string; createdBy: string | null; createdAt: number; runCount: number; stepsSha: string }> }>(`/api/templates/${id}/versions`);
      print(r.versions ?? [], () => {
        for (const v of r.versions ?? []) line(`r${v.revision}  ${new Date(v.createdAt).toLocaleString()}  ${v.source}  ${v.runCount} run${v.runCount === 1 ? '' : 's'}  ${v.createdBy ?? ''}`);
      });
      return;
    }

    if (action === 'export') {
      const ids = target ? target.split(',').map((s) => s.trim()).filter(Boolean).join(',') : undefined;
      const q = ids ? `?ids=${encodeURIComponent(ids)}` : '';
      const res = await client.request<Response>('GET', `/api/templates/export${q}`, undefined, { raw: true }) as unknown as Response;
      const buf = Buffer.from(await res.arrayBuffer());
      if (opts.out) { writeFileSync(opts.out, buf); print({ out: opts.out, bytes: buf.length }, () => line(`written ${opts.out} (${buf.length} bytes)`)); return; }
      process.stdout.write(buf);
      return;
    }

    if (action === 'import') {
      const input = file ?? target; // single positional lands in target
      if (!input) throw new Error('case import needs <zip path | yaml path | ->');
      // zip (binary magic PK) vs yaml (text): read as BUFFER, decide, then
      // utf8 only for the text path (utf8-reading a zip corrupts it).
      const buf = input === '-' ? readFileSync(0) : readFileSync(input);
      const isZip = buf.length > 1 && buf[0] === 0x50 && buf[1] === 0x4b;
      const body = isZip
        ? { zipBase64: buf.toString('base64') }
        : { yaml: buf.toString('utf8') };
      const r = await client.post<{ imported?: Array<{ id: string; name: string }>; renamed?: Array<{ from: string; to: string }>; error?: string }>('/api/templates/import', body);
      print(r, () => {
        for (const i of r.imported ?? []) line(`imported ${i.id}  ${i.name}`);
        for (const n of r.renamed ?? []) line(`renamed ${n.from} → ${n.to}`);
      });
      return;
    }

    if (action === 'run' || action === 'verify') {
      if (!target) throw new Error(`case ${action} needs <id|name>`);
      const id = await client.resolveCase(target);
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
        run = row.run ?? row;
        if (run.status && !['running', 'queued'].includes(run.status)) break;
        await new Promise((res) => setTimeout(res, 2000));
      }
      const stepsRow = await client.get<{ steps?: Array<{ idx: number; name: string; status: string; reason?: string | null; narrate?: string | null }> }>(`/api/runs/${runId}/steps`);
      const stepList = stepsRow.steps ?? [];
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

    throw new Error(`unknown case action "${action}" (list | yaml | new | get | edit | duplicate | delete | versions | export | import | run | verify)`);
  });
}
