/** Baguette stream host — spawns and supervises `baguette serve` for H.264
 *  device streaming (loopback only; the browser never reaches this port).
 *
 *  Lifecycle: lazily spawned on first avcc resolve; idles out after 5 min
 *  with zero connected upstreams; respawns on next need. One instance max. */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_AGE_MS = Number(process.env['CRUCIBLE_BAGUETTE_MAX_AGE_MS'] ?? 2 * 60 * 60_000); // 2h

const BIN = process.env['CRUCIBLE_BAGUETTE_BIN']
  ?? join(dirname(fileURLToPath(import.meta.url)), '../../../../baguette/Baguette');
const PORT = Number(process.env['CRUCIBLE_BAGUETTE_PORT'] ?? 8430);
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

async function probe(): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/simulators.json`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

/** Ensure `baguette serve` is listening; returns the port. Throws when the
 *  binary is missing or the server never becomes healthy. */
export function ensureBaguette(): Promise<number> {
  touch();
  if (ready) return ready;
  if (!existsSync(BIN)) return Promise.reject(new Error(`baguette binary not found: ${BIN} (set CRUCIBLE_BAGUETTE_BIN)`));
  ready = (async () => {
    // reuse an already-healthy instance, UNLESS past max age — a WEDGED instance
    // (dead-socket accumulation, encoder stall) still answers the HTTP probe
    // while streaming seed-only. Recycling costs ~1.5s; zombie reuse kills every
    // stream silently. spawnedAt=0 (not ours) also recycles once, then ages.
    if (await probe()) {
      if (Date.now() - spawnedAt < MAX_AGE_MS) return PORT;
      stop();
    }
    const p = spawn(BIN, ['serve', '--port', String(PORT), '--host', '127.0.0.1'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });
    proc = p;
    spawnedAt = Date.now();
    p.on('exit', () => { proc = null; ready = null; }); // next need respawns
    p.stdout?.on('data', () => { /* readiness via probe */ });
    p.stderr?.on('data', (d: Buffer) => { if (process.env['CRUCIBLE_LOG_LEVEL'] === 'debug') console.error('[baguette]', d.toString().trim()); });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (p.exitCode !== null) throw new Error(`baguette serve exited (code ${p.exitCode})`);
      if (await probe()) return PORT;
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error('baguette serve did not become healthy in 15s');
  })();
  // a failed start must not cache a rejected promise forever
  ready = ready.catch((err) => { ready = null; throw err; });
  return ready;
}

/** baguette avcc WS URL for a booted udid. */
export function baguetteStreamUrl(udid: string): string {
  return `ws://127.0.0.1:${PORT}/simulators/${udid}/stream?format=avcc`;
}

/** test seam */
export function __baguetteTestState(): { running: boolean; bin: string } {
  return { running: proc !== null, bin: BIN };
}
