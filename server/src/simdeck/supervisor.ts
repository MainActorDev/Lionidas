/** simdeck host — spawns and supervises the wrapped device-surface server
 *  (Apache-2.0 sibling project; codename only per repo signature rules) as a
 *  loopback-only child process. Lifecycle mirrors the first-party engine
 *  supervisor it replaces: lazy spawn on first resolve, idle reap after 5 min,
 *  max-age recycle; health = HTTP 200 on /simulators.json (its own readiness
 *  surface — no frame counters to interpret).
 *
 *  The child is spawned with `--allowed-hosts localhost` because the proxy
 *  rewrites Origin to the child's own authority anyway (same-origin from the
 *  child's perspective); the flag is belt-and-braces for direct loopback
 *  probes (tests, drills). */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_AGE_MS = Number(process.env['CRUCIBLE_SIMDECK_MAX_AGE_MS'] ?? 2 * 60 * 60_000); // 2h

const BIN = process.env['CRUCIBLE_SIMDECK_BIN']
  ?? join(dirname(fileURLToPath(import.meta.url)), '../../../../baguette/Baguette');
const PORT = Number(process.env['CRUCIBLE_SIMDECK_PORT'] ?? 8422);
const IDLE_MS = 5 * 60_000;

let proc: ChildProcess | null = null;
let ready: Promise<number> | null = null;
let spawnedAt = 0;
let lastClientAt = Date.now();
let reaper: NodeJS.Timeout | null = null;

function touch(): void {
  lastClientAt = Date.now();
  if (!reaper) {
    reaper = setInterval(() => {
      if (proc && Date.now() - lastClientAt > IDLE_MS) stop();
    }, 30_000);
    reaper.unref();
  }
}

function stop(): void {
  if (reaper) { clearInterval(reaper); reaper = null; }
  if (proc) { proc.kill('SIGTERM'); proc = null; }
  ready = null;
}

/** Readiness probe: /simulators.json 200 = serving. */
async function probe(): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/simulators.json`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

/** Ensure the child is listening; returns the port. Throws when the binary is
 *  missing (permanent class) or it never becomes healthy — callers surface,
 *  never fall back. */
export function ensureSimdeck(): Promise<number> {
  if (ensureOverride) return ensureOverride();
  touch();
  if (ready) return ready;
  if (!existsSync(BIN)) {
    return Promise.reject(new Error(`simdeck binary not found: ${BIN} (build the sibling project, or set CRUCIBLE_SIMDECK_BIN)`));
  }
  ready = (async () => {
    // reuse an already-healthy instance, UNLESS past max age
    if (await probe()) {
      if (Date.now() - spawnedAt < MAX_AGE_MS) return PORT;
      stop();
    }
    // stdio ignore: the child logs volume on stdout (plugin scan etc.) — a
    // piped stdio nobody drains fills the OS pipe buffer and BLOCKS the child
    // (found live: manual spawn with file redirect worked, server spawn hung)
    // version pin visibility: one log line per spawn so a drifted checkout
    // is visible in server logs immediately (pin of record: see the plan doc)
    void execFile(BIN, ['--version'], (err, out) => {
      if (!err) console.log(`[simdeck] child version: ${String(out).trim()}`);
    });
    const p = spawn(BIN, ['serve', '--port', String(PORT), '--allowed-hosts', 'localhost'], {
      stdio: 'ignore',
      detached: false,
    });
    proc = p;
    spawnedAt = Date.now();
    p.on('exit', () => {
      proc = null;
      ready = null; // died after a successful ensure — next need must respawn
    });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (p.exitCode !== null) throw new Error(`simdeck exited (code ${p.exitCode})`);
      if (await probe()) return PORT;
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error('simdeck did not become healthy in 15s');
  })();
  // a failed start must not cache a rejected promise forever
  ready = ready.catch((err) => { ready = null; throw err; });
  return ready;
}

/** The child's base URL for server-side fetches (input dispatch). */
export function simdeckBase(): string {
  return `http://127.0.0.1:${PORT}`;
}

/** test seam */
export function __simdeckTestState(): { running: boolean; bin: string } {
  return { running: proc !== null, bin: BIN };
}

/** test seam: replace ensureSimdeck entirely (route tests inject a fake host
 *  instead of spawning the real binary). */
let ensureOverride: (() => Promise<number>) | null = null;
export function __setSimdeckEnsureForTest(fn: (() => Promise<number>) | null): void {
  ensureOverride = fn;
}

/** test seam: hard-reset module state between tests. */
export function __resetSimdeckForTest(): void {
  stop();
}
