/** screen list|register|remove|yaml|login-flow|logout-flow — the app
 *  screen registry (phase 2, plan 20260930T092035Z). screens.yaml is the
 *  round-trip surface (yaml import/export covers recipes too); structured
 *  PUT for register/remove/login/logout keeps revision honesty. */
import type { CAC } from 'cac';
import { sub } from '../cmd.ts';
import { readFileSync, writeFileSync } from 'node:fs';
import { makeClient } from '../client.ts';
import { print, line } from '../output.ts';

function stdinOrFile(file: string): string {
  if (file === '-') return readFileSync(0, 'utf8');
  return readFileSync(file, 'utf8');
}

/** recipe yaml (entry/steps/verify doc) → structured object for the
 *  server's structured PUT (it re-validates against its own grammar). */
async function parseRecipeDoc(yaml: string): Promise<Record<string, unknown>> {
  const YAML = await import('yaml');
  const doc = YAML.parse(yaml) as Record<string, unknown> | null;
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('recipe yaml must be a mapping (entry/steps/verify)');
  return doc;
}

export function screenCommand(cli: CAC): void {
  const s = sub(cli, 'screen <action> [target] [file]', 'screen registry + app recipes');
  s.option('--app <bundle>', 'app bundle (register/login-flow/logout-flow/yaml)');
  s.option('--name <name>', 'screen name (register)');
  s.option('--id <id>', 'screen id (register)');
  s.option('--entry <json>', 'entry steps json (register)');
  s.option('--states <json>', 'states map json (register)');
  s.option('--out <file>', 'output path (yaml)');
  s.option('--json', 'machine-readable output');
  s.action(async (action: string, target: string | undefined, file: string | undefined, opts: {
    app?: string; name?: string; id?: string; entry?: string; states?: string; out?: string; json?: boolean;
  }) => {
    const client = makeClient();

    if (action === 'list') {
      const bundle = target ?? opts.app;
      if (!bundle) throw new Error('screen list needs <bundle> or --app');
      const r = await client.get<{ screens?: Array<{ id: string; entry?: unknown; states?: unknown }> }>(`/api/apps/${encodeURIComponent(bundle)}/screens`);
      print(r.screens ?? [], () => {
        for (const sc of r.screens ?? []) line(`${sc.id}${sc.states && Object.keys(sc.states as object).length ? `  states: ${Object.keys(sc.states as object).join(', ')}` : ''}`);
      });
      return;
    }

    if (action === 'register') {
      if (!opts.app || !opts.name) throw new Error('screen register needs --app <bundle> --name <screenId> [--entry <json>] [--states <json>]');
      const cur = await client.get<{ screens?: Array<Record<string, unknown>>; revision?: number }>(`/api/apps/${encodeURIComponent(opts.app)}/screens`);
      const screens = cur.screens ?? [];
      const entry = opts.entry ? JSON.parse(opts.entry) as unknown : { navigate: [] };
      const states = opts.states ? JSON.parse(opts.states) as unknown : {};
      const screen = { id: opts.name, entry, states };
      const next = [...screens.filter((x) => x.id !== opts.name), screen];
      const r = await client.put<{ ok?: boolean; count?: number; revision?: number }>(`/api/apps/${encodeURIComponent(opts.app)}/screens`, { screens: next, revision: cur.revision });
      print(r, () => line(`registered ${opts.name} (${r.count} screens, rev ${r.revision})`));
      return;
    }

    if (action === 'remove') {
      // positional: screen remove <bundle> <screenId> — or --app + <screenId>
      const bundle = opts.app ?? target;
      const screenId = opts.app ? target : file;
      if (!bundle || !screenId) throw new Error('screen remove needs <bundle> <screenId>');
      const r = await client.del<{ ok?: boolean }>(`/api/apps/${encodeURIComponent(bundle)}/screens/${encodeURIComponent(screenId)}`);
      print(r, () => line(`removed ${screenId} from ${bundle}`));
      return;
    }

    if (action === 'yaml' || action === 'export') {
      const bundle = target ?? opts.app;
      if (!bundle) throw new Error(`screen ${action} needs <bundle> or --app`);
      const res = await client.request<Response>('GET', `/api/apps/${encodeURIComponent(bundle)}/screens.yaml`, undefined, { raw: true }) as unknown as Response;
      const yaml = await res.text();
      if (opts.out) { writeFileSync(opts.out, yaml); print({ out: opts.out }, () => line(`written ${opts.out}`)); return; }
      print(yaml, () => process.stdout.write(yaml));
      return;
    }

    if (action === 'import') {
      const bundle = target ?? opts.app;
      if (!bundle || !file) throw new Error('screen import needs <bundle> <file.yaml|->');
      const yaml = stdinOrFile(file);
      const r = await client.put<{ ok?: boolean; count?: number; login?: boolean; logout?: boolean }>(`/api/apps/${encodeURIComponent(bundle)}/screens.yaml`, { yaml });
      print(r, () => line(`imported screens.yaml for ${bundle} (${r.count} screens${r.login ? ' + login' : ''}${r.logout ? ' + logout' : ''})`));
      return;
    }

    if (action === 'login-flow' || action === 'logout-flow') {
      const kind = action === 'login-flow' ? 'login' : 'logout';
      const bundle = target ?? opts.app;
      if (!bundle) throw new Error(`screen ${action} needs <bundle> or --app`);
      const path = `/api/apps/${encodeURIComponent(bundle)}/${kind}`;
      if (file) {
        // write: file holds the recipe doc (login: entry/steps/verify;
        // logout: button/confirm/sheet or steps) — server re-validates.
        const doc = await parseRecipeDoc(stdinOrFile(file));
        const r = await client.put<{ ok?: boolean; revision?: number }>(path, { [kind]: doc });
        const n = Array.isArray(doc['steps']) ? (doc['steps'] as unknown[]).length : 0;
        print(r, () => line(`saved ${kind} recipe${n ? ` (${n} steps` : ''}${r.revision ? `, rev ${r.revision}` : ''}) for ${bundle}`));
        return;
      }
      const r = await client.get<{ [k: string]: unknown }>(path);
      print(r, () => line(JSON.stringify(r, null, 2)));
      return;
    }

    throw new Error(`unknown screen action "${action}" (list | register | remove | yaml | import | export | login-flow | logout-flow)`);
  });
}
