import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { isNetworkProfile } from '@crucible/shared/network-profiles';

/** Baguette network-conditioning shim (plan 20260928T153608Z rev 2).
 *  Wraps the `baguette network` CLI. Contracts:
 *  - EXIT CODES are the contract for set/clear; `status` stdout parsing is
 *    BEST-EFFORT DISPLAY ONLY (human prose incl. the device name — parse
 *    mismatch returns `{conditioned:'unknown', raw}`, never an error).
 *  - An absent binary NEVER throws: `{ok:false, reason:'baguette-absent'}`.
 *  - Per-app conditioning (VirtualNetwork.dylib): only apps launched AFTER
 *    `set` are conditioned; updates on a running app apply in ~100ms. */

const execFileP = promisify(execFile);

export type BaguetteNetworkOp =
  | { kind: 'set'; profile: string }
  | { kind: 'clear' }
  | { kind: 'status' };

export interface BaguetteNetworkResult {
  ok: boolean;
  reason?: 'baguette-absent' | 'bad-profile' | 'cli-error';
  detail?: string;
  /** status only: best-effort readback */
  conditioned?: 'yes' | 'no' | 'unknown';
  raw?: string;
}

/** test override: forces resolution (absent-binary drills). */
export let __baguettePathOverrideForTest: string | null | undefined;
export function __setBaguettePathForTest(v: string | null | undefined): void { __baguettePathOverrideForTest = v; }

/** Binary resolution (review F7): env → ~/.alloy/crucible.json baguettePath →
 *  sibling-repo default. null = absent (callers degrade honestly). */
export function resolveBaguettePath(): string | null {
  if (__baguettePathOverrideForTest !== undefined) return __baguettePathOverrideForTest;
  const env = process.env['BAGUETTE_PATH'];
  if (env && existsSync(env)) return env;
  try {
    const cfgPath = join(homedir(), '.alloy', 'crucible.json');
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as { baguettePath?: string };
      if (cfg.baguettePath && existsSync(cfg.baguettePath)) return cfg.baguettePath;
    }
  } catch { /* unreadable config = absent tier */ }
  const sibling = new URL('../../../../Baguette/Baguette', import.meta.url).pathname;
  if (existsSync(sibling)) return sibling;
  return null;
}

/** injectable runner for tests (argv assertions) */
export type BaguetteRunner = (bin: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
const defaultRunner: BaguetteRunner = async (bin, args) => {
  const { stdout, stderr } = await execFileP(bin, args, { timeout: 5_000 });
  return { stdout, stderr };
};

export async function baguetteNetwork(
  udid: string,
  op: BaguetteNetworkOp,
  runner: BaguetteRunner = defaultRunner,
): Promise<BaguetteNetworkResult> {
  if (op.kind === 'set' && !isNetworkProfile(op.profile)) {
    return { ok: false, reason: 'bad-profile', detail: `unknown network profile: ${op.profile}` };
  }
  const bin = resolveBaguettePath();
  if (!bin) return { ok: false, reason: 'baguette-absent', detail: 'baguette binary not found — set BAGUETTE_PATH or baguettePath in ~/.alloy/crucible.json' };
  const args =
    op.kind === 'set' ? ['network', 'set', '--udid', udid, '--profile', op.profile]
    : op.kind === 'clear' ? ['network', 'clear', '--udid', udid]
    : ['network', 'status', '--udid', udid];
  try {
    const { stdout, stderr } = await runner(bin, args);
    if (op.kind === 'status') {
      // baguette logs human lines on STDERR (verified live 2026-09-28) —
      // read both, stderr first
      const line = (stderr.trim() || stdout.trim()).split('\n').pop() ?? '';
      if (/no network conditioning applied/i.test(line)) return { ok: true, conditioned: 'no', raw: line };
      const m = /network:\s*(.+)$/i.exec(line);
      if (m) return { ok: true, conditioned: 'yes', raw: m[1]!.trim() };
      return { ok: true, conditioned: 'unknown', raw: line }; // F4: prose drifted — show raw, never error
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'cli-error', detail: e instanceof Error ? e.message : String(e) };
  }
}
