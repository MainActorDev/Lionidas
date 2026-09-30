/** run get|steps|abort — reading and stopping runs. */
import type { CAC } from 'cac';
import { sub } from '../cmd.ts';
import { makeClient } from '../client.ts';
import { print, line } from '../output.ts';

export function runCommand(cli: CAC): void {
  const r = sub(cli, 'run <action> <runId>', 'runs');
  r.action(async (action: string, runId: string) => {
    const client = makeClient();
    if (action === 'get') {
      const run = await client.get<Record<string, unknown>>(`/api/runs/${runId}`);
      print(run, () => line(JSON.stringify(run, null, 2)));
      return;
    }
    if (action === 'steps') {
      const r2 = await client.get<{ steps?: Array<{ idx: number; name: string; status: string; reason?: string | null; narrate?: string | null; duration_ms?: number | null }> }>(`/api/runs/${runId}/steps`);
      print(r2.steps ?? [], () => {
        for (const s of (r2.steps ?? [])) line(`[${s.status}] ${s.idx}. ${s.name}${s.narrate ? ` — ${s.narrate}` : ''}${s.reason ? ` (${s.reason})` : ''}${s.duration_ms != null ? ` ${s.duration_ms}ms` : ''}`);
      });
      return;
    }
    if (action === 'abort') {
      const out = await client.post<{ ok?: boolean; error?: string }>(`/api/runs/${runId}/abort`);
      print(out, () => line(out.ok ? 'aborted' : (out.error ?? 'abort sent')));
      return;
    }
    throw new Error(`unknown run action "${action}" (get | steps | abort)`);
  });
}
