/** Forge MITM manager: spawns mitmdump with the addon, writes the state file,
 *  tails traffic.ndjson into SQLite + WS (idempotent, offset-based re-tail). */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { openSync, readSync, fstatSync, closeSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { TypedEventBus, AppEvents } from '../../ws/bus.ts';
import type { Preset } from '../matcher.ts';
import { ensureForgeCa, disableSimRouting } from '../sim-routing.ts';

export interface MitmDeps {
  db: Database.Database;
  bus: TypedEventBus<AppEvents>;
  stateDir: string;
}

export interface MitmHandle {
  port: number;
  pid: number;
  stop(): Promise<void>;
}

let proc: ChildProcess | null = null;
let tailTimer: ReturnType<typeof setInterval> | null = null;
let tailOffset = 0;

export function writeStateFile(stateDir: string, mode: string, presets: Preset[]): string {
  const payload = { mode, presets, hash: createHash('sha256').update(JSON.stringify({ mode, presets })).digest('hex') };
  const path = join(stateDir, 'forge-mitm-state.json');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path, JSON.stringify(payload), 'utf8');
  return path;
}

function tailTraffic(deps: MitmDeps): void {
  const path = join(deps.stateDir, 'traffic.ndjson');
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return; // not created yet
  }
  try {
    const st = fstatSync(fd);
    if (st.size <= tailOffset) { closeSync(fd); return; }
    const buf = Buffer.alloc(st.size - tailOffset);
    readSync(fd, buf, 0, buf.length, tailOffset);
    tailOffset = st.size;
    closeSync(fd);
    for (const line of buf.toString('utf8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const row = JSON.parse(t) as Record<string, unknown>;
        const id = `t_mitm_${createHash('sha256').update(t).digest('hex').slice(0, 12)}`;
        deps.db
          .prepare(`INSERT OR IGNORE INTO traffic(id, run_id, ts, mode, method, host, path, matched_preset_id, status, latency_ms, req_sha, res_sha)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, (row['run_id'] as string) ?? null, row['ts'] as number, row['mode'] as string,
            row['method'] as string, row['host'] as string, row['path'] as string,
            (row['matched_preset_id'] as string) ?? null, row['status'] as number,
            row['latency_ms'] as number, null, null);
        deps.bus.emit('forge.traffic.hit', {
          id, runId: (row['run_id'] as string) ?? null, method: row['method'] as string,
          path: row['path'] as string, status: row['status'] as number,
          latencyMs: row['latency_ms'] as number, mode: row['mode'] as string,
          matchedPresetId: (row['matched_preset_id'] as string) ?? null,
        });
      } catch { /* malformed line — skip */ }
    }
  } catch { /* raced truncation */ }
}

export async function startMitm(deps: MitmDeps, port = 0): Promise<MitmHandle> {
  if (proc && !proc.killed) {
    return { port: (proc as { _port?: number })._port ?? 0, pid: proc.pid ?? 0, stop: async () => undefined };
  }
  const addonPath = join(dirname(new URL(import.meta.url).pathname), 'addon.py');
  mkdirSync(deps.stateDir, { recursive: true });
  // reset tail to end-of-file if a previous file exists (idempotent restart)
  try { tailOffset = fstatSync(openSync(join(deps.stateDir, 'traffic.ndjson'), 'r')).size; } catch { tailOffset = 0; }

  // CA bootstrap: generate the Apple-compliant hierarchy on first use. Without
  // this, a fresh confdir would make mitmdump silently create its DEFAULT CA
  // (leaf signed directly by root) — exactly the 'MissingIntermediate' failure
  // this whole rig exists to prevent.
  const confdir = process.env['CRUCIBLE_MITM_CONFDIR'] ?? `${process.env['HOME'] ?? '/tmp'}/.forge-ca`;
  ensureForgeCa(confdir);

  // pick a free port ourselves: mitmdump has no port-0 mode (0 → default 8080)
  let listenPort = port;
  if (!listenPort || listenPort <= 0) {
    const net = await import('node:net');
    listenPort = await new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, '127.0.0.1', () => {
        const p = (srv.address() as { port: number }).port;
        srv.close(() => resolve(p));
      });
      srv.on('error', reject);
    });
  }
  const args = [
    '-s', addonPath,
    '--set', `forge_state_dir=${deps.stateDir}`,
    // Custom CA hierarchy (root → intermediate → leaf). mitmproxy's default CA
    // signs leaves DIRECTLY with the root; Apple's strict TLS policy rejects
    // that ('leaf MissingIntermediate', -9802/-1200) — the Lion Parcel app's
    // API + Firebase calls failed exactly this way. A proper intermediate
    // serves an Apple-compliant chain. CA generated at the path below (see
    // scripts/setup-forge-tls.command); trust its ROOT once in the keychain.
    '--set', `confdir=${confdir}`,
    '--listen-host', '127.0.0.1',
    '--listen-port', String(listenPort),
    // TLS-passthrough fallback for hosts whose clients STILL reject MITM even
    // with a proper chain (pinned certs). Traffic routes but is not intercepted.
    // Extend via FORGE_IGNORE_HOSTS (regex, |-joined).
    '--ignore-hosts', process.env['FORGE_IGNORE_HOSTS'] ?? 'firebaseappcheck\\.googleapis\\.com',
  ];
  // mitmdump resolves via PATH in shells, but spawns from vitest/tsx may lack
  // /opt/homebrew/bin — prefer the discovered absolute path, fall back to PATH.
  const mitmdump = (() => {
    try { return execFileSync('which', ['mitmdump'], { encoding: 'utf8' }).trim(); } catch { return 'mitmdump'; }
  })();
  proc = spawn(mitmdump, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: false });

  // CRITICAL: drain both pipes continuously. mitmdump logs every TLS handshake;
  // if nobody reads, the 64KB OS pipe buffer fills and mitmdump's MAIN THREAD
  // blocks inside write() — the proxy wedges (socket listening, nothing served,
  // everything times out). Sampled live: _io_FileIO_write blocking the loop.
  proc.stdout?.on('data', (d: Buffer) => {
    const line = d.toString();
    if (/error|traceback/i.test(line)) process.stderr.write(`[forge-mitm] ${line}`);
  });
  proc.stderr?.on('data', (d: Buffer) => process.stderr.write(`[forge-mitm] ${d}`));

  // SAFETY NET: if the proxy dies while sim routing is ON, the host proxy points
  // at a dead port — the whole Mac loses internet. On unexpected exit, tear
  // routing down immediately. (Deliberate stop() clears routing itself.)
  proc.on('exit', (code) => {
    if ((proc as { _intentional?: boolean })._intentional) return;
    process.stderr.write(`[forge-mitm] proxy died (code ${code}) — clearing sim routing to restore internet\n`);
    try { disableSimRouting(); } catch { /* networksetup unavailable — nothing more we can do */ }
  });

  // health: CONNECT PROBE, not log parsing — mitmdump buffers stdout until the
  // first client connection, so the listen line is unreadable at startup.
  // (Same class as the Colony port lesson: probe by connecting, both ways.)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('mitmdump not connectable within 6s')), 6000);
    const attempt = async (n: number): Promise<void> => {
      if (proc?.exitCode !== null) {
        clearTimeout(timer);
        reject(new Error(`mitmdump exited early (code ${proc?.exitCode})`));
        return;
      }
      const { connect } = await import('node:net');
      const sock = connect({ port: listenPort, host: '127.0.0.1' });
      sock.once('connect', () => {
        sock.destroy();
        clearTimeout(timer);
        (proc as { _port?: number })._port = listenPort;
        resolve();
      });
      sock.once('error', () => {
        sock.destroy();
        if (n < 20) setTimeout(() => void attempt(n + 1), 300);
      });
    };
    void attempt(0);
  });

  tailTimer = setInterval(() => tailTraffic(deps), 1000);
  return {
    port: (proc as { _port?: number })._port ?? 0,
    pid: proc?.pid ?? 0,
    stop: async () => {
      if (tailTimer) { clearInterval(tailTimer); tailTimer = null; }
      tailTraffic(deps); // final drain
      if (proc && !proc.killed) {
        (proc as { _intentional?: boolean })._intentional = true; // deliberate — exit hook must not double-clear routing
        proc.kill('SIGTERM');
        await new Promise<void>((r) => { proc?.on('exit', () => r()); setTimeout(r, 2000); });
      }
      proc = null;
    },
  };
}

export function mitmRunning(): { pid: number; port: number } | null {
  if (proc && !proc.killed) return { pid: proc.pid ?? 0, port: (proc as { _port?: number })._port ?? 0 };
  return null;
}

export async function stopMitmIfRunning(): Promise<void> {
  if (proc && !proc.killed) {
    if (tailTimer) { clearInterval(tailTimer); tailTimer = null; }
    (proc as { _intentional?: boolean })._intentional = true;
    proc.kill('SIGTERM');
    await new Promise<void>((r) => { proc?.on('exit', () => r()); setTimeout(r, 2000); });
  }
  proc = null;
}
