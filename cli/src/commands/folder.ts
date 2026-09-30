/** folder list|new|rename|move|delete|run — testcase organization (phase 2,
 *  plan 20260930T092035Z). Folders are app-scoped; every guard surfaces the
 *  server's named-409 verbatim. */
import type { CAC } from 'cac';
import { sub } from '../cmd.ts';
import { makeClient } from '../client.ts';
import { print, line } from '../output.ts';

export function folderCommand(cli: CAC): void {
  const f = sub(cli, 'folder <action> [target]', 'testcase folders');
  f.option('--app <bundle>', 'app bundle (new/list)');
  f.option('--parent <id|path>', 'parent folder');
  f.option('--name <name>', 'new name (new/rename)');
  f.option('--device <udid>', 'device (run)');
  f.option('--no-wait', 'fire and print run ids');
  f.option('--timeout <seconds>', 'run wait timeout', { default: 900 });
  f.option('--cases <ids>', 'comma-separated case ids (move)');
  f.option('--json', 'machine-readable output');
  f.action(async (action: string, target: string | undefined, opts: {
    app?: string; parent?: string; name?: string; device?: string; wait?: boolean; timeout?: number; cases?: string; json?: boolean;
  }) => {
    const client = makeClient();

    if (action === 'list') {
      if (!opts.app) throw new Error('folder list needs --app <bundle>');
      const out: Array<{ id: string; name: string; depth: number; caseCount: number; path: string }> = [];
      const walk = async (parentId: string | null, path: string, depth: number): Promise<void> => {
        const q = new URLSearchParams({ app: opts.app! });
        if (parentId) q.set('parentId', parentId);
        const r = await client.get<{ folders?: Array<{ id: string; name: string; caseCount: number }>; caseIds?: string[] }>(`/api/folders?${q}`);
        for (const fo of r.folders ?? []) {
          const p = path ? `${path}/${fo.name}` : fo.name;
          out.push({ id: fo.id, name: fo.name, depth, caseCount: fo.caseCount, path: p });
          await walk(fo.id, p, depth + 1);
        }
      };
      await walk(null, '', 0);
      print(out, () => {
        for (const fo of out) line(`${'  '.repeat(fo.depth)}${fo.name}  ${fo.id}  (${fo.caseCount} case${fo.caseCount === 1 ? '' : 's'})`);
      });
      return;
    }

    if (action === 'new') {
      if (!opts.app || !opts.name) throw new Error('folder new needs --app <bundle> --name <name>');
      let parentId: string | null = null;
      if (opts.parent) parentId = await resolveFolder(client, opts.app, opts.parent);
      const r = await client.post<{ id?: string; name?: string }>('/api/folders', { appBundleId: opts.app, parentId, name: opts.name });
      print(r, () => line(`${r.id}  ${r.name}`));
      return;
    }

    if (action === 'rename') {
      if (!target || !opts.name) throw new Error('folder rename needs <id> --name <new>');
      const r = await client.request<{ id?: string; name?: string }>('PATCH', `/api/folders/${target}`, { name: opts.name });
      print(r, () => line(`renamed → ${r.name}`));
      return;
    }

    if (action === 'delete') {
      if (!target) throw new Error('folder delete needs <id>');
      const r = await client.del<{ deleted?: string; error?: string }>(`/api/folders/${target}`);
      print(r, () => line(`deleted ${r.deleted ?? target}`));
      return;
    }

    if (action === 'move') {
      if (!opts.cases) throw new Error('folder move needs --cases <id,id,…> (target = folder id|path, or "root" to unfile)');
      let folderId: string | null = null;
      if (target && target !== 'root') {
        if (!opts.app) throw new Error('folder move with a path target needs --app');
        folderId = await resolveFolder(client, opts.app, target);
      }
      const templateIds = opts.cases.split(',').map((s) => s.trim()).filter(Boolean);
      const r = await client.post<{ moved?: number; folderId?: string | null; error?: string }>('/api/folders/move', { templateIds, folderId });
      print(r, () => line(`moved ${r.moved ?? 0} case(s) → ${r.folderId ?? 'root'}`));
      return;
    }

    if (action === 'run') {
      if (!target) throw new Error('folder run needs <folderId>');
      const body: Record<string, unknown> = {};
      if (opts.device) body['udid'] = opts.device;
      const r = await client.post<{ runIds?: string[]; count?: number; error?: string; code?: string }>(`/api/folders/${target}/run`, body);
      print(r, () => line(`batch: ${r.count ?? 0} run(s) — ${(r.runIds ?? []).join(' ')}`));
      if (opts.wait === false) return;
      // wait: all runs terminal
      const runIds = r.runIds ?? [];
      const deadline = Date.now() + (opts.timeout ?? 900) * 1000;
      const states = new Map<string, string>();
      while (Date.now() < deadline && runIds.some((id) => !['passed', 'failed', 'aborted', 'error'].includes(states.get(id) ?? ''))) {
        for (const id of runIds) {
          if (['passed', 'failed', 'aborted', 'error'].includes(states.get(id) ?? '')) continue;
          const row = await client.get<{ run?: { status?: string }; status?: string }>(`/api/runs/${id}`);
          states.set(id, (row.run ?? row).status ?? '');
        }
        if (runIds.every((id) => ['passed', 'failed', 'aborted', 'error'].includes(states.get(id) ?? ''))) break;
        await new Promise((res) => setTimeout(res, 2500));
      }
      const out = runIds.map((id) => ({ runId: id, status: states.get(id) ?? 'unknown' }));
      print(out, () => {
        for (const o of out) line(`run ${o.runId}: ${o.status}`);
        const passed = out.filter((o) => o.status === 'passed').length;
        line(`folder verdict: ${passed}/${out.length} passed`);
      });
      if (out.some((o) => o.status !== 'passed')) process.exitCode = 1;
      return;
    }

    throw new Error(`unknown folder action "${action}" (list | new | rename | delete | move | run)`);
  });

}

async function resolveFolder(client: ReturnType<typeof makeClient>, app: string, idOrPath: string): Promise<string> {
  if (idOrPath.startsWith('fld_')) {
    const r = await client.get<{ folders?: Array<{ id: string }>; path?: Array<{ id: string; name: string }> }>(`/api/folders?app=${encodeURIComponent(app)}`);
    void r;
    return idOrPath; // ids are trusted as-is; server 409s unknown parents
  }
  // path resolve: walk segments
  const segs = idOrPath.split('/').map((s) => s.trim()).filter(Boolean);
  let parent: string | null = null;
  for (const seg of segs) {
    const q = new URLSearchParams({ app });
    if (parent) q.set('parentId', parent);
    const r = await client.get<{ folders?: Array<{ id: string; name: string }> }>(`/api/folders?${q}`);
    const hit = (r.folders ?? []).find((fo) => fo.name === seg);
    if (!hit) throw new Error(`folder "${seg}" not found under ${parent ?? 'root'} (path: ${idOrPath})`);
    parent = hit.id;
  }
  if (!parent) throw new Error(`folder path "${idOrPath}" is empty`);
  return parent;
}
