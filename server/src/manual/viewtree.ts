/** Viewtree dump (viewtree probe P2): lldb attach → recursiveDescription →
 *  parse → VNode[]. Manual, on-demand, simulator-only.
 *
 *  Guards (the P2 edge-case table, enforced here):
 *  - NEVER while a queued/running run OR another manual session holds the
 *    device — the app is SIGSTOP'd for the dump (~7s warm); tripping a
 *    run's settle poll or watchdog is exactly the poison this guard
 *    prevents. 409 DEVICE_BUSY.
 *  - PID resolved FRESH per call from the session's sim via launchctl;
 *    the resolved PID's process must carry the session's bundle id —
 *  never attach to an arbitrary host pid. 422 WRONG_PROCESS on mismatch.
 *  - Per-device mutex: concurrent dumps serialize (lldb holds the process
 *    while attached; a second attach fails anyway — fail EARLY, not mid).
 *  - Budget: 20s hard timeout on the whole lldb batch; abort leaves the
 *    target process detached (lldb --batch detaches on exit; a killed
 *    lldb leaves the app SIGSTOP'd — we `kill -CONT` as best-effort). */
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { parseRecursiveDescription, type VNode } from '@crucible/shared/view-tree';

const exec = promisify(execFile);

const locks = new Set<string>();

/** Test seam (pattern of __setAlloyForTest / __setEngineTreeForTest):
 *  replaces PID resolution + the lldb invocation so route tests run the
 *  guards + parse pipeline without a device. */
let testOverride: { resolvePid?: (udid: string, bundleId: string | null) => Promise<{ pid: number; label: string }>; lldb?: (pid: number) => Promise<string> } | null = null;
export function __setViewtreeForTest(fn: typeof testOverride): void {
  testOverride = fn;
}

export class ViewtreeError extends Error {
  constructor(message: string, readonly code: 'DEVICE_BUSY' | 'NO_APP' | 'WRONG_PROCESS' | 'PID_RESOLVE' | 'LLDB_FAILED' | 'PARSE' | 'TIMEOUT') {
    super(message);
    this.name = 'ViewtreeError';
  }
}

/** Resolve the frontmost app PID inside the session's simulator. */
async function resolveAppPid(udid: string, bundleId: string | null): Promise<{ pid: number; label: string }> {
  const { stdout } = await exec('xcrun', ['simctl', 'spawn', udid, 'launchctl', 'list'], { timeout: 10_000 });
  const rows = stdout.split('\n').filter((l) => l.includes('UIKitApplication:'));
  if (rows.length === 0) throw new ViewtreeError('no foreground app in simulator', 'NO_APP');
  const label = bundleId ? rows.find((r) => r.includes(bundleId)) : undefined;
  const row = label ?? rows[0]!;
  const pid = Number(row.trim().split(/\s+/)[0]);
  if (!Number.isFinite(pid) || pid <= 1) throw new ViewtreeError(`pid resolve failed: ${row.slice(0, 80)}`, 'PID_RESOLVE');
  return { pid, label: row.trim() };
}

export interface ViewtreeDeps {
  /** Test seam: replaces the real lldb invocation. Returns raw stdout. */
  lldb?: (pid: number) => Promise<string>;
  /** Test seam: replaces simctl launchctl resolution. */
  resolvePid?: (udid: string, bundleId: string | null) => Promise<{ pid: number; label: string }>;
  timeoutMs?: number;
}

const RECIPE = (pid: number): string[] => [
  `attach --pid ${pid}`,
  'expr -O -lobjc++ -- (NSString *)[[(id)[[UIApplication sharedApplication] valueForKey:@"connectedScenes"] anyObject] valueForKey:@"keyWindow"] recursiveDescription]',
  'detach',
];

/** The cold-attach signature: ObjC categories not yet registered in the
 *  target's runtime (attaching seconds after app relaunch — manual/start
 *  reopens the app, so the first dump right after session start hits this
 *  live). One retry after a settle delay resolves it. */
const CATEGORY_NOT_LOADED = /unknown type must be given a function type|unknown return type/;

async function runLldb(pid: number, opts: ViewtreeDeps): Promise<string> {
  const execOnce = async (): Promise<string> => {
    // execFile argv: each -o takes the NEXT arg as the command itself
    // (no flags inside the string — lldb rejects "'attach …' does not exist")
    const args: string[] = ['lldb', '--batch'];
    for (const cmd of RECIPE(pid)) args.push('-o', cmd);
    // 45s budget: cold attach is symbol-load dominated (P0 measured
    // 17–23s cold, 6.6s warm) — 20s timed out live on the first hit.
    // cwd MUST be a neutral dir: launched from the repo, lldb's clang
    // expression parser intermittently drops UIView category decls
    // (3/3 OK from /tmp vs 3/3 FAIL from the server dir).
    const { stdout } = await exec('xcrun', args, { timeout: opts.timeoutMs ?? 45_000, maxBuffer: 32 * 1024 * 1024, cwd: tmpdir() });
    return stdout;
  };
  try {
    return await execOnce();
  } catch (err) {
    const out = String((err as { stdout?: string }).stdout ?? '');
    if (!CATEGORY_NOT_LOADED.test(out)) throw err;
    await new Promise((r) => setTimeout(r, 3_000)); // let the app settle + categories register
    return execOnce(); // one retry only — a second failure is honest
  }
}

export async function dumpViewtree(
  udid: string,
  bundleId: string | null,
  opts: ViewtreeDeps = {},
): Promise<{ nodes: VNode[]; pausedMs: number; pid: number }> {
  if (locks.has(udid)) throw new ViewtreeError('a viewtree dump is already in flight for this device', 'DEVICE_BUSY');
  locks.add(udid);
  const t0 = Date.now();
  try {
    const resolver = testOverride?.resolvePid ?? opts.resolvePid ?? resolveAppPid;
    const { pid } = await resolver(udid, bundleId);
    const lldb = testOverride?.lldb ?? opts.lldb ?? ((targetPid: number) => runLldb(targetPid, opts));
    let raw: string;
    try {
      raw = await lldb(pid);
    } catch (err) {
      const killed = (err as { killed?: boolean }).killed === true;
      // The app is SIGSTOP'd while attached; a killed lldb never detached.
      // Best-effort resume so the simulator isn't left wedged.
      if (killed) { try { process.kill(pid, 'SIGCONT'); } catch { /* process gone */ } }
      // err.message carries only the command line — lldb's own error text
      // lands in err.stdout. Surface the first error line (live-debug lesson:
      // every module failure was blind until this propagated).
      const out = String((err as { stdout?: string }).stdout ?? '').replace(/\r/g, '');
      const m = /^.*\berror:.*$/m.exec(out);
      const why = m?.[0]?.trim().slice(0, 220) ?? (err as Error).message;
      throw new ViewtreeError(`lldb failed: ${why}`, killed ? 'TIMEOUT' : 'LLDB_FAILED');
    }
    if (raw.includes('error:') && !raw.includes('frame = (')) {
      throw new ViewtreeError(`lldb reported an error (no tree produced)`, 'LLDB_FAILED');
    }
    let nodes: VNode[];
    try {
      nodes = parseRecursiveDescription(raw);
    } catch (err) {
      throw new ViewtreeError((err as Error).message, 'PARSE');
    }
    if (nodes.length === 0) throw new ViewtreeError('lldb produced no view lines (empty tree)', 'LLDB_FAILED');
    return { nodes, pausedMs: Date.now() - t0, pid };
  } finally {
    locks.delete(udid);
  }
}
