/** Smoke gate (brainstorm 20261008T004500Z): a green build whose app dies on
 *  launch is NOT a pass. After a successful simulator build: install the
 *  artifact on a booted sim (booting one if needed), launch, wait, verify
 *  the process is alive. Crash → 'crash' + the crash report's fatal line;
 *  probe-infra failure (no sim, simctl broken) → 'skipped' — the build's
 *  compile verdict stays honest and untouched. Lionidas is already a sim
 *  orchestrator; this is native capability, not new surface. */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type SmokeResult = 'ok' | 'crash' | 'skipped';

export interface SmokeOutcome {
  result: SmokeResult;
  detail: string; // log line for the build log
  crashLine: string | null; // extracted fatal error, when crash
}

const PROBE_WAIT_MS = 10_000;

function simctl(args: string[]): string {
  return execFileSync('xcrun', ['simctl', ...args], { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }).toString();
}

/** First booted device, else boot the first available iPhone sim. */
function resolveDevice(): { udid: string; name: string } | null {
  interface Dev { udid: string; name: string; state: string; isAvailable: boolean }
  let devices: Dev[];
  try {
    const j = JSON.parse(simctl(['list', 'devices', '-j'])) as { devices: Record<string, Dev[]> };
    devices = Object.values(j.devices).flat().filter((d) => d.isAvailable);
  } catch { return null; }
  const booted = devices.find((d) => d.state === 'Booted');
  if (booted) return { udid: booted.udid, name: booted.name };
  const iphone = devices.find((d) => /iPhone/i.test(d.name));
  if (!iphone) return null;
  try {
    simctl(['boot', iphone.udid]);
  } catch { /* already booted race — treat as usable */ }
  return { udid: iphone.udid, name: iphone.name };
}

/** Bundle id from the artifact's Info.plist (unzip + plutil). */
function bundleId(ipaPath: string): string | null {
  try {
    const plist = execFileSync('unzip', ['-p', ipaPath, 'Payload/*.app/Info.plist'], { maxBuffer: 16 * 1024 * 1024 });
    const json = execFileSync('plutil', ['-convert', 'json', '-o', '-', '-'], { input: plist, maxBuffer: 16 * 1024 * 1024 }).toString();
    return (JSON.parse(json) as { CFBundleIdentifier?: string }).CFBundleIdentifier ?? null;
  } catch { return null; }
}

/** Newest crash report for a process NEWER than the given epoch-ms —
 *  stale reports from earlier crashes must never speak for this launch. */
function newestCrashReport(processName: string, sinceMs: number): string | null {
  const roots = [
    join(homedir(), 'Library', 'Logs', 'DiagnosticReports'),
  ];
  let newest: { path: string; mtime: number } | null = null;
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let entries: string[] = [];
    try { entries = readdirSync(root); } catch { continue; }
    for (const f of entries) {
      if (!f.startsWith(processName)) continue;
      if (!f.endsWith('.ips') && !f.endsWith('.crash')) continue;
      try {
        const p = join(root, f);
        const mtime = statSync(p).mtimeMs;
        if (mtime < sinceMs) continue; // older than this launch — not ours
        if (!newest || mtime > newest.mtime) newest = { path: p, mtime };
      } catch { /* unreadable — next */ }
    }
  }
  return newest?.path ?? null;
}

/** Run the probe. Never throws — outcomes are data. */
export function smokeTestArtifact(ipaPath: string, log: (line: string) => void): SmokeOutcome {
  const dev = resolveDevice();
  if (!dev) return { result: 'skipped', detail: 'smoke: no simulator available — skipped (verdict unchanged)', crashLine: null };
  const bid = bundleId(ipaPath);
  if (!bid) return { result: 'skipped', detail: 'smoke: cannot read bundle id from artifact — skipped', crashLine: null };
  // simctl installs .ipa directly on modern Xcode
  try {
    log(`smoke: installing ${bid} on ${dev.name} (${dev.udid.slice(0, 8)}…)`);
    simctl(['install', dev.udid, ipaPath]);
  } catch (e) {
    return { result: 'skipped', detail: `smoke: install failed — skipped (${e instanceof Error ? e.message.split('\n')[0] : String(e)})`, crashLine: null };
  }
  let pid: number;
  const launchedAt = Date.now();
  try {
    const out = simctl(['launch', dev.udid, bid]).trim();
    // simctl prints "<bundle.id>: <pid>" (and console-pty variants append logs)
    const pidStr = /pid\s*=?\s*(\d+)/i.exec(out)?.[1] ?? /:\s*(\d+)\s*$/m.exec(out)?.[1] ?? /^(\d+)$/m.exec(out)?.[1];
    if (!pidStr) throw new Error(`launch output had no pid: ${out.slice(0, 120)}`);
    pid = Number(pidStr);
    log(`smoke: launched ${bid} pid=${pid}`);
  } catch (e) {
    const line = e instanceof Error ? e.message.split('\n')[0] : String(e);
    return { result: 'crash', detail: 'smoke: launch failed — the app died on launch (SMOKE_CRASH)', crashLine: line || 'launch failed' };
  }
  // wait, then check aliveness via `simctl spawn ... launchctl print` is heavy;
  // `simctl listapps` won't show state. ps on the host DOES show sim processes.
  try {
    execFileSync('sleep', [String(PROBE_WAIT_MS / 1000)], { timeout: PROBE_WAIT_MS + 5_000 });
  } catch { /* interrupted */ }
  let alive = false;
  try {
    const ps = execFileSync('ps', ['-p', String(pid), '-o', 'pid=,comm='], { timeout: 10_000 }).toString();
    alive = ps.trim().length > 0;
  } catch { alive = false; } // ps exits 1 when the process is gone
  if (alive) {
    try { simctl(['terminate', dev.udid, bid]); } catch { /* best effort */ }
    return { result: 'ok', detail: `smoke: ${bid} alive after ${PROBE_WAIT_MS / 1000}s on ${dev.name} — launch OK`, crashLine: null };
  }
  const processName = bid.split('.').pop() ?? bid;
  const report = newestCrashReport('LionParcel', launchedAt);
  let crashLine = 'process exited during probe window';
  if (report) {
    try {
      const text = readFileSync(report, 'utf8');
      const m = /Fatal error:[^\n"]+/.exec(text) ?? /"exception"[^\n]+/.exec(text);
      if (m) crashLine = m[0].slice(0, 300);
    } catch { /* unreadable */ }
  }
  return { result: 'crash', detail: `smoke: ${bid} DIED within ${PROBE_WAIT_MS / 1000}s of launch (SMOKE_CRASH): ${crashLine}`, crashLine };
}
