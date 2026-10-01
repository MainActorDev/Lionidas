/** suite list|new|get|edit|play|delete — case packs (phase 2, plan
 *  20260930T092035Z). Play surfaces named-skips (drift/deprecated/dead
 *  pins) verbatim — honest batch semantics, exit 1 only on real failure. */
import type { CAC } from 'cac';
import { sub } from '../cmd.ts';
import { makeClient } from '../client.ts';
import { print, line } from '../output.ts';

export function suiteCommand(cli: CAC): void {
  const s = sub(cli, 'suite <action> [target]', 'suites');
  s.option('--app <bundle>', 'suite app scope (new)');
  s.option('--members <ids>', 'comma-separated case ids (new/edit)');
  s.option('--name <name>', 'suite name (new)');
  s.option('--desc <text>', 'description (new)');
  s.option('--device <udid>', 'device (play)');
  s.option('--no-wait', 'fire and print run ids');
  s.option('--timeout <seconds>', 'play wait timeout', { default: 1200 });
  s.option('--json', 'machine-readable output');
  s.action(async (action: string, target: string | undefined, opts: {
    app?: string; members?: string; name?: string; desc?: string; device?: string; wait?: boolean; timeout?: number; json?: boolean;
  }) => {
    const client = makeClient();

    if (action === 'list') {
      const r = await client.get<{ suites?: Array<{ id: string; name: string; memberCount?: number; appBundleId?: string | null }> }>('/api/suites');
      print(r.suites ?? [], () => {
        for (const su of r.suites ?? []) line(`${su.id}  ${su.name}  (${su.memberCount ?? 0} members${su.appBundleId ? `, ${su.appBundleId}` : ''})`);
      });
      return;
    }

    if (action === 'new') {
      if (!opts.name) throw new Error('suite new needs --name (and ideally --members id,id,…) [--app <bundle>]');
      const body: Record<string, unknown> = { name: opts.name };
      if (opts.desc) body['description'] = opts.desc;
      if (opts.app) body['appBundleId'] = opts.app;
      if (opts.members) body['members'] = opts.members.split(',').map((x) => x.trim()).filter(Boolean).map((templateId) => ({ templateId }));
      const r = await client.post<{ id?: string; name?: string; error?: string }>('/api/suites', body);
      print(r, () => line(`${r.id}  ${r.name}`));
      return;
    }

    if (action === 'get') {
      if (!target) throw new Error('suite get needs <id>');
      const r = await client.get<Record<string, unknown>>(`/api/suites/${encodeURIComponent(target)}`);
      print(r, () => line(JSON.stringify(r, null, 2)));
      return;
    }

    if (action === 'edit') {
      if (!target) throw new Error('suite edit needs <id>');
      const body: Record<string, unknown> = {};
      if (opts.name) body['name'] = opts.name;
      if (opts.desc !== undefined) body['description'] = opts.desc;
      if (opts.members) body['members'] = opts.members.split(',').map((x) => x.trim()).filter(Boolean).map((templateId) => ({ templateId }));
      const r = await client.request<Record<string, unknown>>('PATCH', `/api/suites/${encodeURIComponent(target)}`, body);
      print(r, () => line(`saved ${target}`));
      return;
    }

    if (action === 'delete') {
      if (!target) throw new Error('suite delete needs <id>');
      const r = await client.del<{ ok?: boolean; error?: string }>(`/api/suites/${encodeURIComponent(target)}`);
      print(r, () => line(`deleted ${target}`));
      return;
    }

    if (action === 'play') {
      if (!target) throw new Error('suite play needs <id>');
      const body: Record<string, unknown> = {};
      if (opts.device) body['udid'] = opts.device;
      const r = await client.post<{ runIds?: string[]; count?: number; batchId?: string; skippedDrifted?: string[]; skippedDeprecated?: string[]; skippedDeadVariants?: Array<{ templateId: string; dead: string[] }>; error?: string }>(`/api/suites/${encodeURIComponent(target)}/play`, body);
      print(r, () => {
        line(`batch ${r.batchId ?? ''}: ${r.count ?? 0} run(s) — ${(r.runIds ?? []).join(' ')}`);
        for (const d of r.skippedDrifted ?? []) line(`  skipped (drifted): ${d}`);
        for (const d of r.skippedDeprecated ?? []) line(`  skipped (deprecated): ${d}`);
        for (const g of r.skippedDeadVariants ?? []) line(`  skipped (dead pins): ${g.templateId} (${g.dead.join(',')})`);
      });
      if (opts.wait === false) return;
      const runIds = r.runIds ?? [];
      const deadline = Date.now() + (opts.timeout ?? 1200) * 1000;
      const states = new Map<string, string>();
      const terminal = ['passed', 'failed', 'aborted', 'error'];
      while (Date.now() < deadline && runIds.some((id) => !terminal.includes(states.get(id) ?? ''))) {
        for (const id of runIds) {
          if (terminal.includes(states.get(id) ?? '')) continue;
          const row = await client.get<{ run?: { status?: string }; status?: string }>(`/api/runs/${id}`);
          states.set(id, (row.run ?? row).status ?? '');
        }
        if (runIds.every((id) => terminal.includes(states.get(id) ?? ''))) break;
        await new Promise((res) => setTimeout(res, 2500));
      }
      const out = runIds.map((id) => ({ runId: id, status: states.get(id) ?? 'unknown' }));
      print(out, () => {
        for (const o of out) line(`run ${o.runId}: ${o.status}`);
        const passed = out.filter((o) => o.status === 'passed').length;
        line(`suite verdict: ${passed}/${out.length} passed`);
      });
      if (out.some((o) => o.status !== 'passed')) process.exitCode = 1;
      return;
    }

    throw new Error(`unknown suite action "${action}" (list | new | get | edit | play | delete)`);
  });
}
