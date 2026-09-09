/** crucible-screenstream host — spawns and supervises our first-party H.264
 *  device stream engine (native/screenstream) for loopback-only streaming.
 *
 *  Replaces the baguette host as the ONLY engine: no MJPEG fallback, no
 *  alternative binary. Lifecycle mirrors the old supervisor (lazy spawn on
 *  first resolve, idle reap after 5 min, max-age recycle) but health is
 *  frame-flow truth from /healthz rather than a bare HTTP 200. */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_AGE_MS = Number(process.env['CRUCIBLE_SCREENSTREAM_MAX_AGE_MS'] ?? 2 * 60 * 60_000); // 2h

const BIN = process.env['CRUCIBLE_SCREENSTREAM_BIN']
  ?? join(dirname(fileURLToPath(import.meta.url)), '../../../native/screenstream/.build/release/CrucibleScreenstream');
const PORT = Number(process.env['CRUCIBLE_SCREENSTREAM_PORT'] ?? 8440);
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

/** Frame-flow health: /healthz reports whether the engine has EVER produced
 *  frames — a wedged instance (dead WS, encoder stall) still answers HTTP,
 *  so an ok response with zero served frames past warmup means recycle. */
async function probe(): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/healthz`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return false;
    const j = await r.json() as { framesServed?: number };
    // framesServed is cumulative across streams; zero is only credible while
    // the process is young. Old + zero = wedged.
    if ((j.framesServed ?? 0) === 0 && Date.now() - spawnedAt > 60_000) return false;
    return true;
  } catch { return false; }
}

/** Ensure the engine is listening; returns the port. Throws when the binary
 *  is missing or it never becomes healthy — callers surface, never fall back. */
export function ensureScreenstream(): Promise<number> {
  if (ensureOverride) return ensureOverride();
  touch();
  if (ready) return ready;
  if (!existsSync(BIN)) return Promise.reject(new Error(`crucible-screenstream binary not found: ${BIN} (build it: cd native/screenstream && swift build -c release)`));
  ready = (async () => {
    // reuse an already-healthy instance, UNLESS past max age — recycling costs
    // ~1s; silently riding a wedged engine kills every stream.
    if (await probe()) {
      if (Date.now() - spawnedAt < MAX_AGE_MS) return PORT;
      stop();
    }
    const p = spawn(BIN, ['serve', '--port', String(PORT)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });
    proc = p;
    spawnedAt = Date.now();
    p.on('exit', () => {
      proc = null;
      ready = null; // died after a successful ensure — next need must respawn
    });
    p.stdout?.on('data', () => { /* readiness via probe */ });
    p.stderr?.on('data', (d: Buffer) => { if (process.env['CRUCIBLE_LOG_LEVEL'] === 'debug') console.error('[screenstream]', d.toString().trim()); });
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (p.exitCode !== null) throw new Error(`crucible-screenstream exited (code ${p.exitCode})`);
      if (await probe()) return PORT;
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error('crucible-screenstream did not become healthy in 15s');
  })();
  // a failed start must not cache a rejected promise forever
  ready = ready.catch((err) => { ready = null; throw err; });
  return ready;
}

/** Engine AVCC WS URL for a booted udid (loopback only; the browser never
 *  reaches this port — the wall proxies or upgrades through the app origin). */
export function screenstreamUrl(udid: string): string {
  return `ws://127.0.0.1:${PORT}/devices/${udid}/stream`;
}

/** test seam */
export function __screenstreamTestState(): { running: boolean; bin: string } {
  return { running: proc !== null, bin: BIN };
}

/** test seam: replace ensureScreenstream entirely (route tests inject a fake
 *  engine host instead of spawning the real binary). */
let ensureOverride: (() => Promise<number>) | null = null;
export function __setScreenstreamEnsureForTest(fn: (() => Promise<number>) | null): void {
  ensureOverride = fn;
}
