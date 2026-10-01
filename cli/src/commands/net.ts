/** net presets|scenarios|condition|traffic|mitm — the network forge surface
 *  (phase 3, plan 20260930T092035Z). Read-mostly; condition set/clear drives
 *  baguette; mitm start/stop are the proxy lifecycle. */
import type { CAC } from 'cac';
import { sub } from '../cmd.ts';
import { makeClient } from '../client.ts';
import { print, line } from '../output.ts';

export function netCommand(cli: CAC): void {
  const n = sub(cli, 'net <action> [target]', 'network forge');
  n.option('--udid <udid>', 'device (condition)');
  n.option('--profile <name>', 'network profile (condition set)');
  n.option('--run <runId>', 'filter traffic by run');
  n.option('--q <text>', 'search traffic');
  n.option('--limit <n>', 'page size', { default: 50 });
  n.option('--page <n>', 'page number', { default: 1 });
  n.option('--json', 'machine-readable output');
  n.action(async (action: string, target: string | undefined, opts: {
    udid?: string; profile?: string; run?: string; q?: string; limit?: number; page?: number; json?: boolean;
  }) => {
    const client = makeClient();

    if (action === 'presets') {
      const r = await client.get<{ presets?: Array<{ id: string; name?: string; method?: string; path?: string; status?: number }> }>('/api/forge/presets');
      print(r.presets ?? [], () => {
        for (const p of r.presets ?? []) line(`${p.id}  ${p.method ?? ''} ${p.path ?? p.name ?? ''}${p.status != null ? ` → ${p.status}` : ''}`);
      });
      return;
    }

    if (action === 'preset') {
      if (!target) throw new Error('net preset needs <id>');
      const r = await client.get<Record<string, unknown>>(`/api/forge/presets/${encodeURIComponent(target)}`);
      print(r, () => line(JSON.stringify(r, null, 2)));
      return;
    }

    if (action === 'scenarios') {
      const r = await client.get<{ scenarios?: Array<Record<string, unknown>> }>('/api/forge/scenarios');
      const list = (r.scenarios ?? (r as unknown as { scenarios?: unknown[] }).scenarios ?? []) as Array<{ id?: string; name?: string }>;
      print(list, () => { for (const s of list) line(`${s.id ?? '?'}  ${s.name ?? ''}`); });
      return;
    }

    if (action === 'condition') {
      // no target + no --profile: status. --profile <p>: set. target "clear": clear.
      if (target === 'clear' || opts.profile === 'clear') {
        if (!opts.udid) throw new Error('net condition clear needs --udid');
        const r = await client.post<{ ok?: boolean; cleared?: boolean; error?: string }>('/api/forge/network-condition', { udid: opts.udid, profile: null });
        print(r, () => line(r.cleared ? `cleared condition on ${opts.udid}` : (r.error ?? 'clear failed')));
        return;
      }
      if (opts.profile) {
        if (!opts.udid) throw new Error('net condition set needs --udid and --profile');
        const r = await client.post<{ ok?: boolean; profile?: string; error?: string }>('/api/forge/network-condition', { udid: opts.udid, profile: opts.profile });
        print(r, () => line(r.ok ? `conditioned ${opts.udid} → ${r.profile}` : (r.error ?? 'set failed')));
        if (!r.ok) process.exitCode = 1;
        return;
      }
      if (!opts.udid) throw new Error('net condition needs --udid (status) / --profile <p> (set) / clear');
      const r = await client.get<{ available?: boolean; ok?: boolean; conditioned?: string; detail?: string; error?: string }>(`/api/forge/network-condition?udid=${encodeURIComponent(opts.udid)}`);
      print(r, () => {
        if (r.available === false) line('baguette not found — set BAGUETTE_PATH or baguettePath in ~/.alloy/crucible.json');
        else if (r.ok) line(`${opts.udid}: ${r.conditioned}`);
        else line(`${opts.udid}: ${r.detail ?? r.error ?? 'unknown'}`);
      });
      return;
    }

    if (action === 'traffic') {
      const q = new URLSearchParams();
      if (opts.run) q.set('runId', opts.run);
      if (opts.q) q.set('q', opts.q);
      q.set('limit', String(opts.limit ?? 50));
      q.set('page', String(opts.page ?? 1));
      const r = await client.get<{ traffic?: Array<{ id: string; ts: number; method?: string; path?: string; host?: string | null; status?: number }>; total?: number; page?: number }>(`/api/forge/traffic?${q}`);
      const list = r.traffic ?? [];
      print({ traffic: list, total: r.total, page: r.page }, () => {
        for (const t of list) line(`${new Date(t.ts).toLocaleTimeString()}  ${t.method ?? ''} ${t.host ?? ''}${t.path ?? ''} → ${t.status ?? '?'}`);
        line(`(${r.total ?? list.length} total, page ${r.page ?? 1})`);
      });
      return;
    }

    if (action === 'freeze') {
      // net freeze <trafficId>: save the captured response as a preset
      if (!target) throw new Error('net freeze needs <trafficId>');
      const r = await client.post<{ ok?: boolean; presetId?: string; error?: string }>(`/api/forge/traffic/${encodeURIComponent(target)}/save-preset`, {});
      print(r, () => line(r.presetId ? `preset ${r.presetId} now serves this response forever` : (r.error ?? 'freeze failed')));
      if (!r.ok && r.error) process.exitCode = 1;
      return;
    }

    if (action === 'mitm') {
      const sub2 = target ?? 'status';
      if (sub2 === 'status') {
        const r = await client.get<{ running?: boolean; port?: number; pid?: number }>('/api/forge/mitm/status');
        print(r, () => line(r.running ? `mitm running (:${r.port}, pid ${r.pid})` : 'mitm not running'));
        return;
      }
      if (sub2 === 'start' || sub2 === 'stop') {
        const r = await client.post<{ running?: boolean; port?: number; pid?: number; error?: string }>(`/api/forge/mitm/${sub2}`);
        print(r, () => line(r.error ?? (r.running ? `mitm running (:${r.port})` : 'mitm stopped')));
        if (r.error) process.exitCode = 1;
        return;
      }
      throw new Error('net mitm needs status | start | stop');
    }

    throw new Error(`unknown net action "${action}" (presets | preset | scenarios | condition | traffic | freeze | mitm)`);
  });
}
