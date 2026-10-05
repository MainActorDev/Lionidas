/** Explicit app install: direct simctl (no engine session/claim — avoids the
 *  DEVICE_IN_USE class, commit 74e0bf4), per-device in-flight guard,
 *  watchdog, catalog record on success only. The route owns package identity
 *  (readIpaIdentity for .ipa packages); this module only installs + records. */
import type Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { recordArtifact } from './app-catalog-store.ts';

const execFileAsync = promisify(execFile);
const INSTALL_TIMEOUT_MS = 10 * 60_000;

export type InstallResult =
  | { ok: true; version: string | null; durationMs: number }
  | { ok: false; code: 'INSTALL_IN_FLIGHT' | 'INSTALL_FAILED'; error: string };

const inFlight = new Map<string, Promise<InstallResult>>();

export function installApp(deps: { db: Database.Database }, req: { udid: string; appPath: string; identity: { bundleId: string; version: string | null } }): Promise<InstallResult> {
  const existing = inFlight.get(req.udid);
  if (existing) {
    return Promise.resolve({ ok: false, code: 'INSTALL_IN_FLIGHT', error: 'an install is already running on this device' });
  }
  const p = (async (): Promise<InstallResult> => {
    const t0 = Date.now();
    try {
      await execFileAsync('xcrun', ['simctl', 'install', req.udid, req.appPath], { timeout: INSTALL_TIMEOUT_MS });
    } catch (err) {
      const e = err as { code?: string | number; stderr?: string; message?: string };
      return { ok: false, code: 'INSTALL_FAILED', error: `simctl install failed (${e.code ?? '?'}): ${e.stderr ?? e.message ?? 'unknown'}` };
    }
    recordArtifact(deps.db, { bundleId: req.identity.bundleId, artifactPath: req.appPath, appVersion: req.identity.version });
    return { ok: true, version: req.identity.version, durationMs: Date.now() - t0 };
  })();
  inFlight.set(req.udid, p);
  void p.finally(() => { inFlight.delete(req.udid); });
  return p;
}
