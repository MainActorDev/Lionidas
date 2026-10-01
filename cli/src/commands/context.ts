/** context — the agent's orientation dump (phase 1): apps, booted devices,
 *  case tree, env keys, active runs. One call, one JSON doc. */
import type { CAC } from 'cac';
import { sub } from '../cmd.ts';
import { makeClient } from '../client.ts';
import { print, line } from '../output.ts';

export function contextCommand(cli: CAC): void {
  const ctx = sub(cli, 'context', 'orientation dump: everything an agent needs first');
  ctx.option('--app <bundle>', 'narrow the case tree + env to one app');
  ctx.action(async (opts: { app?: string }) => {
    const client = makeClient();
    const [devices, templates, env] = await Promise.all([
      client.get<{ devices?: Array<{ udid: string; name: string | null; state?: string | null; kind?: string | null }> }>('/api/devices').catch(() => ({ devices: [] })),
      client.get<{ templates?: Array<{ id: string; name: string; app?: string | null; folder?: string | null; status?: string }> }>(`/api/templates${opts.app ? `?app=${encodeURIComponent(opts.app)}` : ''}`).catch(() => ({ templates: [] })),
      client.get<{ vars?: Array<{ key: string; scope: string }> }>(`/api/env-vars?scope=${opts.app ? 'app' : 'global'}${opts.app ? `&app=${encodeURIComponent(opts.app)}` : ''}`).catch(() => ({ vars: [] })),
    ]);
    const runs = await client.get<{ runs?: Array<{ id: string; status: string; template_id?: string | null }> }>('/api/runs?limit=10').catch(() => ({ runs: [] }));
    const booted = (devices.devices ?? []).filter((d) => d.state === 'Booted');
    const out = {
      apps: [...new Set((templates.templates ?? []).map((t) => t.app).filter((a): a is string => !!a))],
      bootedDevices: booted,
      cases: templates.templates ?? [],
      envKeys: env.vars ?? [],
      activeRuns: (runs.runs ?? []).filter((r) => ['running', 'queued'].includes(r.status)),
    };
    print(out, () => {
      line(`apps: ${out.apps.join(', ') || '—'}`);
      line(`booted: ${booted.map((d) => `${d.name ?? d.udid} (${d.udid.slice(0, 8)}…)`).join(', ') || '—'}`);
      line(`cases: ${out.cases.length}${opts.app ? ` (${opts.app})` : ''}`);
      line(`env keys: ${out.envKeys.map((v) => v.key).join(', ') || '—'}`);
      line(`active runs: ${out.activeRuns.map((r) => r.id).join(', ') || '—'}`);
    });
  });
}
