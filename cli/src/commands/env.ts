/** env list|set|delete — secrets ALWAYS masked (server contract; F5). */
import type { CAC } from 'cac';
import { sub } from '../cmd.ts';
import { makeClient } from '../client.ts';
import { print, line } from '../output.ts';

export function envCommand(cli: CAC): void {
  const e = sub(cli, 'env <action> [key] [value]', 'environment variables');
  e.option('--scope <scope>', 'global | app | plan', { default: 'global' });
  e.option('--app <bundle>', 'app scope target');
  e.option('--secret', 'mark the value secret (set)');
  e.action(async (action: string, key: string | undefined, value: string | undefined, opts: { scope?: string; app?: string; secret?: boolean }) => {
    const client = makeClient();
    if (action === 'list') {
      const q = new URLSearchParams({ scope: opts.scope ?? 'global' });
      if (opts.app) q.set('app', opts.app);
      const r = await client.get<{ vars?: Array<{ key: string; value: string; secret: boolean }> }>(`/api/env-vars?${q}`);
      print(r.vars ?? [], () => { for (const v of (r.vars ?? [])) line(`${v.key}  ${v.value}${v.secret ? '  (secret)' : ''}`); });
      return;
    }
    if (action === 'set') {
      if (!key || value === undefined) throw new Error('env set needs <KEY> <VALUE>');
      const body: Record<string, unknown> = { key, value, scope: opts.scope ?? 'global' };
      if (opts.app) body['app'] = opts.app;
      if (opts.secret) body['secret'] = true;
      const r = await client.post<{ ok?: boolean; error?: string }>('/api/env-vars', body);
      print(r, () => line(`set ${key}`));
      return;
    }
    if (action === 'delete') {
      if (!key) throw new Error('env delete needs <KEY>');
      const list = await client.get<{ vars?: Array<{ id: string; key: string }> }>(`/api/env-vars?scope=${opts.scope ?? 'global'}${opts.app ? `&app=${encodeURIComponent(opts.app)}` : ''}`);
      const hit = (list.vars ?? []).find((v) => v.key === key);
      if (!hit) throw new Error(`no ${opts.scope ?? 'global'} env var "${key}"`);
      const r = await client.del<{ ok?: boolean }>(`/api/env-vars/${hit.id}`);
      print(r, () => line(`deleted ${key}`));
      return;
    }
    throw new Error(`unknown env action "${action}" (list | set | delete)`);
  });
}
