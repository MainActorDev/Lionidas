/** Explicit app install: direct simctl (no engine session/claim — avoids the
 *  DEVICE_IN_USE class, commit 74e0bf4), per-device in-flight guard,
 *  watchdog, catalog record on success only. */
import type Database from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readBundleIdentity } from './apps.ts';
import { recordArtifact } from './app-catalog-store.ts';

const execFileAsync = promisify(execFile);
const INSTALL_TIMEOUT_MS = 10 * 60_000;

export type InstallResult =
  | { ok: true; version: string | null; durationMs: number }
  | { ok: false; code: 'INSTALL_IN_FLIGHT' | 'INSTALL_FAILED' | 'ARTIFACT_UNREADABLE'; error: string };

const inFlight = new Map<string, Promise<InstallResult>>();

export function installApp(deps: { db: Database.Database }, req: { udid: string; appPath: string }): Promise<InstallResult> {
  const existing = inFlight.get(req.udid);
  if (existing) {
    return Promise.resolve({ ok: false, code: 'INSTALL_IN_FLIGHT', error: 'an install is already running on this device' });
  }
  const p = (async (): Promise<InstallResult> => {
    const identity = readBundleIdentity(req.appPath);
    if (!identity) return { ok: false, code: 'ARTIFACT_UNREADABLE', error: `cannot read bundle identity from ${req.appPath}` };
    const t0 = Date.now();
    try {
      await execFileAsync('xcrun', ['simctl', 'install', req.udid, req.appPath], { timeout: INSTALL_TIMEOUT_MS });
    } catch (err) {
      const e = err as { code?: string | number; stderr?: string; message?: string };
      return { ok: false, code: 'INSTALL_FAILED', error: `simctl install failed (${e.code ?? '?'}): ${e.stderr ?? e.message ?? 'unknown'}` };
    }
    recordArtifact(deps.db, { bundleId: identity.bundleId, artifactPath: req.appPath, appVersion: identity.version });
    return { ok: true, version: identity.version, durationMs: Date.now() - t0 };
  })();
  inFlight.set(req.udid, p);
  void p.finally(() => { inFlight.delete(req.udid); });
  return p;
}
