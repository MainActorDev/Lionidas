import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const LOCATION_TIMEOUT_MS = 10_000;

/** Executor contract (injected for tests): run a command, reject on
 *  non-zero exit. Production binding = promisified execFile. */
export type Execute = (cmd: string, args: string[], opts?: { timeout?: number }) => Promise<{ stdout: string; stderr: string }>;

export const prodExecute: Execute = (cmd, args, opts) =>
  execFileAsync(cmd, args, { timeout: opts?.timeout ?? LOCATION_TIMEOUT_MS });

/** Locale-independent coordinate formatting — always `.` decimals.
 *  6 decimals ≈ 11cm precision, far beyond GPS spoofing needs. */
export function formatCoord(n: number): string {
  return n.toFixed(6);
}

/** simctl location set — arg vector (pure, testable). */
export function buildSetArgs(udid: string, lat: number, lon: number): string[] {
  return ['simctl', 'location', udid, 'set', `${formatCoord(lat)},${formatCoord(lon)}`];
}

/** simctl location clear — arg vector (pure, testable). */
export function buildClearArgs(udid: string): string[] {
  return ['simctl', 'location', udid, 'clear'];
}

/** Set the simulated GPS position. The verb is write-only (no read-back);
 *  verification is by step result + post-run clear check. */
export async function setLocation(execute: Execute, udid: string, lat: number, lon: number): Promise<{ set: true; coordinate: string }> {
  await execute('xcrun', buildSetArgs(udid, lat, lon));
  return { set: true, coordinate: `${formatCoord(lat)},${formatCoord(lon)}` };
}

/** Clear any location override (run-end hygiene — best-effort by design). */
export async function clearLocation(execute: Execute, udid: string): Promise<{ cleared: true }> {
  await execute('xcrun', buildClearArgs(udid));
  return { cleared: true };
}
