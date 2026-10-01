/** device list|boot|shutdown|restart|pin|unpin — simulator wall (phase 3,
 *  plan 20260930T092035Z). Power ops guard against active runs/sessions and
 *  are simulator-only — the server enforces; we surface. */
import type { CAC } from 'cac';
import { sub } from '../cmd.ts';
import { makeClient } from '../client.ts';
import { print, line } from '../output.ts';

export function deviceCommand(cli: CAC): void {
  const d = sub(cli, 'device <action> [udid]', 'simulators');
  d.option('--booted', 'list booted only');
  d.option('--json', 'machine-readable output');
  d.action(async (action: string, udid: string | undefined, opts: { booted?: boolean; json?: boolean }) => {
    const client = makeClient();

    if (action === 'list') {
      const r = await client.get<{ devices?: Array<{ udid: string; name: string | null; state: string | null; os_version?: string | null; lease_display?: string | null; lastUsed?: number | null }> }>('/api/devices');
      let list = r.devices ?? [];
      if (opts.booted) list = list.filter((x) => x.state === 'Booted');
      print(list, () => {
        for (const dev of list) {
          const lease = dev.lease_display && !dev.lease_display.startsWith('manual:') ? `  [${dev.lease_display}]` : dev.lease_display ? '  [manual]' : '';
          line(`${dev.state === 'Booted' ? '●' : '○'} ${dev.udid}  ${dev.name ?? '?'}${dev.os_version ? `  (${dev.os_version})` : ''}${lease}`);
        }
      });
      return;
    }

    if (action === 'boot' || action === 'shutdown' || action === 'restart' || action === 'power') {
      const target = udid;
      if (!target) throw new Error(`device ${action} needs <udid>`);
      const act = action === 'power' ? (udid && ['boot', 'shutdown', 'restart'].includes(udid) ? udid : null) : action;
      if (!act) throw new Error('device power action must be boot|shutdown|restart (got "' + String(udid) + '")');
      const dev = act === action ? target : udid; // `device power boot <udid>` form
      const r = await client.post<{ ok?: boolean; error?: string }>(`/api/devices/${encodeURIComponent(dev)}/power`, { action: act });
      print(r, () => line(r.ok ? `${act} → ${dev}` : (r.error ?? `${act} failed`)));
      if (!r.ok) process.exitCode = 1;
      return;
    }

    if (action === 'pin' || action === 'unpin') {
      if (!udid) throw new Error(`device ${action} needs <udid>`);
      if (action === 'pin') {
        const r = await client.put<{ ok?: boolean }>(`/api/devices/${encodeURIComponent(udid)}/pin`, {});
        print(r, () => line(`pinned ${udid}`));
      } else {
        const r = await client.del<{ ok?: boolean }>(`/api/devices/${encodeURIComponent(udid)}/pin`);
        print(r, () => line(`unpinned ${udid}`));
      }
      return;
    }

    throw new Error(`unknown device action "${action}" (list | boot | shutdown | restart | pin | unpin)`);
  });
}
