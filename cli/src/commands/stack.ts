/** stack up|down|restart|status|doctor — process supervision (plan
 *  20260930T092035Z stage 1). Pidfile group at ~/.lionidas/stack.pids; lsof
 *  is the truth for listeners (F3): dead group pids pruned, foreign
 *  listeners reported and NEVER killed; down stops only pids it owns.
 *  Node ≥24.12 guard (better-sqlite3 ABI trap) refuses up. */
import type { CAC } from 'cac';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { Client } from '../client.ts';
import { readConfig, DEFAULT_URL } from '../config.ts';
import { print, line } from '../output.ts';
import { sub } from '../cmd.ts';

const SERVER_PORT = 9230;
const WEB_PORT = 5230;
const DIR = join(homedir(), '.lionidas');
const PIDFILE = join(DIR, 'stack.pids');
const LOG = join(DIR, 'stack.log');

interface Group { server: number | null; web: number | null }

function readGroup(): Group {
  if (!existsSync(PIDFILE)) return { server: null, web: null };
  try {
    return JSON.parse(readFileSync(PIDFILE, 'utf8')) as Group;
  } catch { return { server: null, web: null }; }
}
function writeGroup(g: Group): void {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  writeFileSync(PIDFILE, JSON.stringify(g, null, 2) + '\n');
}

function alive(pid: number | null): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function portHolders(port: number): Array<{ pid: string; command: string }> {
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).trim();
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

function repoRoot(): string {
  // <repo>/cli/src/commands/stack.ts → <repo>
  return join(import.meta.dirname, '..', '..', '..');
}

function spawnDetached(label: 'server' | 'web'): number {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  const root = repoRoot();
  const out = openSync(LOG, 'a');
  const child = spawn('pnpm', ['--filter', label, 'dev'], {
    cwd: root,
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, CRUCIBLE_SILENT: label === 'server' ? '0' : process.env['CRUCIBLE_SILENT'] },
  });
  child.unref();
  return child.pid ?? -1;
}

async function waitHealthy(baseUrl: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return true;
    } catch { /* not yet */ }
    await new Promise((res) => setTimeout(res, 1000));
  }
  return false;
}

function killGroup(g: Group): void {
  for (const pid of [g.server, g.web]) {
    if (pid && alive(pid)) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    }
  }
}

export function stackCommand(cli: CAC): void {
  const stack = sub(cli, 'stack <action>', 'local stack lifecycle');
  stack.action(async (action: string) => {
    const baseUrl = process.env['LIONIDAS_URL'] ?? readConfig()?.baseUrl ?? DEFAULT_URL;

    if (action === 'status' || action === 'doctor') {
      const node = nodeVersionOk();
      const group = readGroup();
      const pidAlive = { server: alive(group.server), web: alive(group.web) };
      const holders9230 = portHolders(SERVER_PORT);
      const holders5230 = portHolders(WEB_PORT);
      let health: { ok?: boolean; version?: string } | null = null;
      try { health = await new Client(baseUrl).get<{ ok?: boolean; version?: string }>('/api/health'); } catch { health = null; }
      const foreign = [...holders9230, ...holders5230].filter((h) => String(group.server) !== h.pid && String(group.web) !== h.pid);
      if (action === 'doctor') {
        // prune dead group entries (F3 reconciliation)
        const next: Group = { server: pidAlive.server ? group.server : null, web: pidAlive.web ? group.web : null };
        if (next.server !== group.server || next.web !== group.web) {
          writeGroup(next);
          if (next.server === null && next.web === null && existsSync(PIDFILE)) rmSync(PIDFILE);
          line('pruned dead pidfile entries');
        } else {
          line('pidfile consistent with live processes');
        }
      }
      const out = {
        server: { port: SERVER_PORT, up: !!health, health, listeners: holders9230, ourPid: group.server, pidAlive: pidAlive.server },
        web: { port: WEB_PORT, up: holders5230.length > 0, listeners: holders5230, ourPid: group.web, pidAlive: pidAlive.web },
        node, foreignListeners: foreign, baseUrl, pidfile: PIDFILE,
      };
      print(out, () => {
        line(`server  :${SERVER_PORT} ${health ? `UP (${health.version ?? '?'})` : holders9230.length ? 'PORT BUSY (foreign or unhealthy)' : 'down'}`);
        line(`web     :${WEB_PORT} ${holders5230.length ? 'up' : 'down'}`);
        line(`node    ${node.version} ${node.ok ? 'ok' : `TOO OLD — need ${node.need} (better-sqlite3 ABI)`}`);
        if (foreign.length) line(`note    foreign listeners (left untouched): ${foreign.map((f) => `${f.pid}/${f.command}`).join(', ')}`);
        if (!health) line('start with: lionidas stack up');
      });
      return;
    }

    if (action === 'up') {
      const node = nodeVersionOk();
      if (!node.ok) throw new Error(`node ${node.version} is too old — need ${node.need} (better-sqlite3 ABI); upgrade node first`);
      const group = readGroup();
      const sHolders = portHolders(SERVER_PORT);
      const wHolders = portHolders(WEB_PORT);
      const serverUp = sHolders.length > 0 || alive(group.server);
      const webUp = wHolders.length > 0 || alive(group.web);
      const started: string[] = [];
      const next: Group = { server: group.server, web: group.web };
      if (!serverUp) { next.server = spawnDetached('server'); started.push('server'); }
      else if (sHolders.length && String(group.server) !== sHolders[0]!.pid) {
        line(`note    :${SERVER_PORT} already held by pid ${sHolders[0]!.pid} (${sHolders[0]!.command}) — adopting as foreign, not spawning`);
      }
      if (!webUp) { next.web = spawnDetached('web'); started.push('web'); }
      else if (wHolders.length && String(group.web) !== wHolders[0]!.pid) {
        line(`note    :${WEB_PORT} already held by pid ${wHolders[0]!.pid} (${wHolders[0]!.command}) — adopting as foreign, not spawning`);
      }
      writeGroup(next);
      const healthy = started.includes('server') ? await waitHealthy(baseUrl, 60_000) : true;
      print({ started, serverPid: next.server, webPid: next.web, healthy, log: LOG, baseUrl }, () => {
        if (started.length === 0) line('stack already up (adopted existing processes)');
        else line(`started: ${started.join(', ')} — logs at ${LOG}`);
        line(healthy ? `server healthy at ${baseUrl}` : `server did not become healthy in 60s — check ${LOG}`);
      });
      if (!healthy) process.exitCode = 1;
      return;
    }

    if (action === 'down' || action === 'restart') {
      if (action === 'restart') {
        killGroup(readGroup());
        await new Promise((res) => setTimeout(res, 2500));
      }
      const group = readGroup();
      if (action === 'down') killGroup(group);
      await new Promise((res) => setTimeout(res, 500));
      const sHolders = portHolders(SERVER_PORT);
      const wHolders = portHolders(WEB_PORT);
      const foreign = [...sHolders, ...wHolders];
      if (action === 'restart') {
        const next: Group = { server: spawnDetached('server'), web: spawnDetached('web') };
        writeGroup(next);
        const healthy = await waitHealthy(baseUrl, 60_000);
        print({ restarted: true, serverPid: next.server, webPid: next.web, healthy, foreign: foreign.map((f) => f.pid) }, () => {
          line(`restarted (server ${next.server}, web ${next.web})${healthy ? ' — healthy' : ` — NOT healthy in 60s, check ${LOG}`}`);
        });
        if (!healthy) process.exitCode = 1;
      } else {
        if (existsSync(PIDFILE)) rmSync(PIDFILE);
        print({ stopped: true, foreign: foreign.map((f) => f.pid) }, () => {
          line('stack stopped (owned pids signalled)');
          if (foreign.length) line(`note    foreign listeners remain (untouched): ${foreign.map((f) => `${f.pid}/${f.command}`).join(', ')}`);
        });
      }
      return;
    }

    throw new Error(`unknown stack action "${action}" (up | down | restart | status | doctor)`);
  });
}
