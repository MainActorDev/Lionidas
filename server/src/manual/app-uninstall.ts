/** Explicit app uninstall: direct simctl (no engine session/claim — mirrors
 *  app-install.ts). Destructive, so the route layer guards WHAT can be
 *  uninstalled (system-app allowlist) and WHEN (booted, not busy); this
 *  module only performs the host op and reports honestly. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const UNINSTALL_TIMEOUT_MS = 60_000;

export type UninstallResult =
  | { ok: true; durationMs: number }
  | { ok: false; code: 'UNINSTALL_FAILED'; error: string };

export async function uninstallApp(udid: string, bundleId: string): Promise<UninstallResult> {
  const t0 = Date.now();
  try {
    await execFileAsync('xcrun', ['simctl', 'uninstall', udid, bundleId], { timeout: UNINSTALL_TIMEOUT_MS });
    return { ok: true, durationMs: Date.now() - t0 };
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    const msg = (err.stderr ?? err.message ?? 'unknown').trim().slice(0, 500);
    return { ok: false, code: 'UNINSTALL_FAILED', error: `simctl uninstall failed: ${msg}` };
  }
}
