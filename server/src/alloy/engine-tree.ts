/** Engine-tree client (AX-depth adoption T2): fetch the wrapped engine's
 *  describe_ui tree for a simulator on demand. CLI subprocess per call —
 *  measured 0.45–0.76s cold (spike P1); a long-lived serve/WS client is a
 *  future optimization ONLY if a poll cadence demands it. Errors THROW —
 *  callers (tree route, playback settle) own the alloy fallback decision;
 *  a partial tree is never returned. Simulators only — physical devices
 *  must never reach this path (callers gate on the devices table). */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { engineTreeToSnapNodes, type SnapNode } from '@crucible/shared/engine-tree';

const BIN = process.env['CRUCIBLE_SIMDECK_BIN']
  ?? join(dirname(fileURLToPath(import.meta.url)), '../../../../baguette/Baguette');

/** Resolve the engine binary path (shared with the viewtree probe client).
 *  Exported so the probe's arm/disarm spawns the SAME binary the tree
 *  client uses — one resolution, no drift. */
export function engineBin(): string {
  return BIN;
}

const TIMEOUT_MS = 10_000;

/** Test seam (same pattern as __setAlloyForTest): overrides the CLI spawn
 *  entirely so route tests exercise dual-source logic without a device. */
let testOverride: ((udid: string) => Promise<SnapNode[]>) | null = null;
export function __setEngineTreeForTest(fn: ((udid: string) => Promise<SnapNode[]>) | null): void {
  testOverride = fn;
}

export class EngineTreeError extends Error {
  constructor(message: string, readonly code: 'BIN_MISSING' | 'SPAWN' | 'TIMEOUT' | 'PARSE') {
    super(message);
    this.name = 'EngineTreeError';
  }
}

/** Stdout lines that are NOT the JSON payload (engine logs to stdout). */
const stripLogLines = (stdout: string): string => {
  // describe-ui prints one JSON object; log lines (e.g. "[baguette] [ax] …")
  // precede it. Keep from the first '{' at column 0 to the end.
  const start = stdout.indexOf('{');
  if (start < 0) throw new EngineTreeError(`engine tree: no JSON in output`, 'PARSE');
  return stdout.slice(start);
};

export async function fetchEngineTree(
  udid: string,
  opts: { bin?: string; timeoutMs?: number } = {},
): Promise<SnapNode[]> {
  if (testOverride) return testOverride(udid);
  const bin = opts.bin ?? BIN;
  if (!existsSync(bin)) throw new EngineTreeError(`engine binary not found: ${bin}`, 'BIN_MISSING');
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(bin, ['describe-ui', '--udid', udid], { timeout: opts.timeoutMs ?? TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err, out) => {
      if (err) {
        const timedOut = (err as NodeJS.ErrnoException & { killed?: boolean }).killed === true;
        reject(new EngineTreeError(`describe-ui failed: ${err.message}`, timedOut ? 'TIMEOUT' : 'SPAWN'));
      } else resolve(out);
    });
  });
  let json: unknown;
  try {
    json = JSON.parse(stripLogLines(stdout));
  } catch (e) {
    throw new EngineTreeError(`engine tree JSON parse failed: ${(e as Error).message}`, 'PARSE');
  }
  try {
    return engineTreeToSnapNodes(json);
  } catch (e) {
    throw new EngineTreeError((e as Error).message, 'PARSE');
  }
}
