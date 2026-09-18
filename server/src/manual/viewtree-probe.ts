/** Viewtree probe client (P3 mechanism B): arm/disarm the injected probe
 *  via the wrapped engine CLI, and request dumps by rewriting the intent
 *  file with a fresh id and polling the dylib's atomic response.
 *
 *  The app is NEVER paused — that is the entire point (the lldb path
 *  SIGSTOPs it for 7–25s). Latency = stat-poll cadence (0.1s) + main-thread
 *  walk (single-digit ms), budgeted at 3s.
 *
 *  Honest errors, never partial trees: timeouts, stale responses, wrong
 *  apps, and malformed payloads all THROW with distinct codes — the route
 *  decides how to surface them. */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { engineBin } from '../alloy/engine-tree.ts';
import { nodesFromProbe, type ProbeNode, type VNode } from '@crucible/shared/view-tree';

const exec = promisify(execFile);

export class ProbeError extends Error {
  constructor(message: string, readonly code:
    | 'ARM_FAILED' | 'DISARM_FAILED' | 'BIN_MISSING'
    | 'NO_RESPONSE' | 'STALE' | 'WRONG_APP' | 'EMPTY' | 'NO_KEY_WINDOW' | 'PARSE') {
    super(message);
    this.name = 'ProbeError';
  }
}

/** Udids armed by THIS server process (session-start wiring). The launchctl
 *  env is the real armed state; this set exists so route calls can refuse
 *  honestly with a flag hint when the session never armed, and so finish
 *  knows what to disarm. Not persisted — a DB column would lie across
 *  server restarts while the env stays real. */
const armed = new Set<string>();
export function probeArmed(udid: string): boolean { return armed.has(udid); }

/** Test seam (pattern of __setViewtreeForTest): replaces the CLI spawn AND
 *  the file IO so client tests run without a device or the engine binary. */
let testOverride: {
  cli?: (args: string[]) => Promise<void>;
  writeRequest?: (udid: string, body: string) => void;
  readResponse?: (udid: string) => string | null;
  sleep?: (ms: number) => Promise<void>;
} | null = null;
export function __setViewtreeProbeForTest(fn: typeof testOverride): void {
  testOverride = fn;
}

const requestPath = (udid: string): string => `/tmp/BaguetteViewTree-${udid}.json`;
const responsePath = (udid: string): string => `/tmp/BaguetteViewTree-${udid}.dump.json`;

/** Run one engine CLI verb (viewtree arm|disarm). Any failure is honest —
 *  and MAPPED for both the real spawn and the test seam, so the route's
 *  ProbeError→HTTP mapping is exercised identically in tests. */
async function cli(args: string[]): Promise<void> {
  const run = testOverride?.cli ?? ((argv: string[]) => exec(engineBin(), argv, { timeout: 10_000 }).then(() => undefined));
  try {
    await run(args);
  } catch (err) {
    if (err instanceof ProbeError) throw err;
    const out = String((err as { stdout?: string; stderr?: string }).stdout
      ?? (err as { stderr?: string }).stderr ?? '');
    throw new ProbeError(`viewtree ${args[1]} failed: ${out.slice(0, 200) || (err as Error).message}`,
      args[1] === 'arm' ? 'ARM_FAILED' : 'DISARM_FAILED');
  }
}

export async function armProbe(udid: string, bundleId: string): Promise<void> {
  await cli(['viewtree', 'arm', '--udid', udid, '--bundle', bundleId]);
  armed.add(udid);
}

export async function disarmProbe(udid: string): Promise<void> {
  if (!armed.has(udid)) return; // nothing this process armed — env may still hold older state; that's the sim-reboot/edge case, surfaced by status
  try {
    await cli(['viewtree', 'disarm', '--udid', udid]);
  } finally {
    armed.delete(udid);
  }
}

const sleep = (ms: number): Promise<void> => testOverride?.sleep?.(ms) ?? new Promise((r) => setTimeout(r, ms));

interface ProbeResponse {
  id?: string;
  bundleId?: string;
  nodes?: ProbeNode[];
  error?: string;
}

/** Request one dump: fresh id → atomic intent write → poll the response for
 *  THAT id → validate → normalize. Throws ProbeError on every failure
 *  mode; returns {nodes, waitMs} plus nothing it cannot honestly claim. */
export async function fetchProbeViewtree(
  udid: string,
  bundleId: string | null,
  opts: { timeoutMs?: number } = {},
): Promise<{ nodes: VNode[]; waitMs: number }> {
  const timeoutMs = opts.timeoutMs ?? 3_000;
  const id = randomUUID();
  const write = testOverride?.writeRequest ?? ((ud: string, body: string) => writeFileSync(requestPath(ud), body));
  const read = testOverride?.readResponse ?? ((ud: string) => {
    try { return readFileSync(responsePath(ud), 'utf8'); } catch { return null; }
  });
  write(udid, JSON.stringify({ id, bundleId }));
  const t0 = Date.now();
  for (;;) {
    await sleep(50);
    const raw = read(udid);
    if (raw !== null && raw.length > 0) {
      try {
        const response = JSON.parse(raw) as ProbeResponse;
        if (response.id === id) {
          if (response.error === 'no-key-window') {
            throw new ProbeError('probe reports no key window (app backgrounded?)', 'NO_KEY_WINDOW');
          }
          if (response.error) {
            throw new ProbeError(`probe error: ${response.error}`, 'PARSE');
          }
          if (typeof response.bundleId === 'string' && bundleId && response.bundleId !== bundleId) {
            throw new ProbeError(`probe answered for ${response.bundleId}, session targets ${bundleId}`, 'WRONG_APP');
          }
          if (!Array.isArray(response.nodes) || response.nodes.length === 0) {
            throw new ProbeError('probe produced no nodes (empty tree)', 'EMPTY');
          }
          let nodes: VNode[];
          try {
            nodes = nodesFromProbe(response.nodes);
          } catch (err) {
            throw new ProbeError((err as Error).message, 'PARSE');
          }
          return { nodes, waitMs: Date.now() - t0 };
        }
        // A response for an EARLIER id: stale file, keep polling.
      } catch (err) {
        if (err instanceof ProbeError) throw err;
        // Unparseable JSON: the atomic write contract says this is a torn
        // read that cannot happen; treat as transient and keep polling.
      }
    }
    if (Date.now() - t0 >= timeoutMs) {
      // Never silently fall back to lldb — the caller chose the probe.
      throw new ProbeError(
        `probe did not answer within ${timeoutMs}ms (app not relaunched since arming, or not injected)`,
        'NO_RESPONSE');
    }
  }
}
