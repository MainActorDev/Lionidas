/** stack up|down|restart|status|doctor — supervision (pidfile group at
 *  ~/.lionidas/stack.pids), health polling, Node-ABI guard, port truth via
 *  lsof. Stage 0 ships read-only `status`; up/down/restart land in phase 1. */
import type { CAC } from 'cac';
import { sub } from '../cmd.ts';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { Client } from '../client.ts';
import { readConfig, DEFAULT_URL } from '../config.ts';
import { print, line } from '../output.ts';

const SERVER_PORT = 9230;
const WEB_PORT = 5230;

function portHolders(port: number): Array<{ pid: string; command: string }> {
  try {
    const out = execFileSync('lsof', [`-nP`, `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).trim();
    return out.split('\n').filter(Boolean).map((pid) => {
      let command = '';
      try { command = execFileSync('ps', ['-p', pid, '-o', 'comm='], { encoding: 'utf8' }).trim(); } catch { command = '?'; }
      return { pid, command };
    });
  } catch { return []; }
}

function nodeVersionOk(): { ok: boolean; version: string; need: string } {
  const v = process.versions.node;
  const [major, minor] = v.split('.').map(Number);
  return { ok: (major ?? 0) > 24 || ((major ?? 0) === 24 && (minor ?? 0) >= 12), version: v, need: '24.12.0+' };
}

export function stackCommand(cli: CAC): void {
  const stack = sub(cli, 'stack <action>', 'local stack lifecycle');
  stack.action(async (action: string) => {
    if (action === 'status') {
      const node = nodeVersionOk();
      const pidPath = join(homedir(), '.lionidas', 'stack.pids');
      const pidGroup = existsSync(pidPath) ? readFileSync(pidPath, 'utf8').trim().split('\n').filter(Boolean) : [];
      const holders9230 = portHolders(SERVER_PORT);
      const holders5230 = portHolders(WEB_PORT);
      const baseUrl = process.env['LIONIDAS_URL'] ?? readConfig()?.baseUrl ?? DEFAULT_URL;
      let health: { status?: string; version?: string } | null = null;
      try { health = await new Client(baseUrl).get<{ status?: string; version?: string }>('/api/health'); } catch { health = null; }
      const foreign = [...holders9230, ...holders5230].filter((h) => !pidGroup.includes(h.pid));
      const out = {
        server: { port: SERVER_PORT, up: !!health, health, listeners: holders9230 },
        web: { port: WEB_PORT, up: holders5230.length > 0, listeners: holders5230 },
        node, pidGroup, foreignListeners: foreign, baseUrl,
      };
      print(out, () => {
        line(`server  :${SERVER_PORT} ${health ? `UP (${health.version ?? '?'})` : holders9230.length ? 'PORT BUSY (not Lionidas or unhealthy)' : 'down'}`);
        line(`web     :${WEB_PORT} ${holders5230.length ? 'up' : 'down'}`);
        line(`node    ${node.version} ${node.ok ? 'ok' : `TOO OLD — need ${node.need} (better-sqlite3 ABI)`}`);
        if (foreign.length) line(`note    foreign listeners on our ports (left untouched): ${foreign.map((f) => `${f.pid}/${f.command}`).join(', ')}`);
        if (!health) line('start with: lionidas stack up');
      });
      return;
    }
    if (['up', 'down', 'restart', 'doctor'].includes(action)) {
      throw new Error(`stack ${action} lands in phase 1 (plan 20260930T092035Z stage 1) — status is the stage-0 surface`);
    }
    throw new Error(`unknown stack action "${action}" (up | down | restart | status | doctor)`);
  });
}
