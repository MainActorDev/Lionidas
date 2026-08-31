/** Watchdog lifecycle: converge the machine toward "launchd agent installed,
 *  loaded, running the repo's current script" — invoked at server start so
 *  the dead-man switch exists even if the operator never ran the installer.
 *
 *  Idempotent and cheap: one launchctl probe + file compares when already
 *  converged (tsx watch restarts must be free). Script updates need NO
 *  launchd reload — StartInterval jobs re-exec the script from disk every
 *  tick; only a plist change does. Fail-open: callers log, never throw.
 *
 *  Quirk handling: some machines (observed: macOS with a secondary-volume
 *  home, e.g. /Volumes/<disk>/Users/<user>) reject bootstrap of ANY plist
 *  from the home volume ("Input/output error 5") while accepting the same
 *  plist from the root volume — stock agents fail there too. Fallback: stage
 *  the plist under /var/tmp/crucible/ (root volume). Trade-off on such
 *  machines: the fallback agent is NOT auto-loaded at reboot (launchd only
 *  scans standard dirs) — server start re-establishes it; the boot/close
 *  heal covers the gap. Normal machines use the home path and survive
 *  reboots standalone.
 *
 *  CRUCIBLE_WATCHDOG=0 at the caller opts out entirely (CI, sandboxes). */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const LABEL = 'com.crucible.forge-watchdog';

export interface WatchdogPaths { scriptSrc: string; scriptDest: string; plistSrc: string; plistDest: string }

/** import.meta.dirname = server/src/forge → three ups = crucible/ root. */
export function watchdogPaths(home: string = homedir()): WatchdogPaths {
  const repoRoot = join(import.meta.dirname, '..', '..', '..');
  return {
    scriptSrc: join(repoRoot, 'scripts', 'forge-watchdog.sh'),
    scriptDest: join(home, '.crucible', 'forge-watchdog.sh'),
    plistSrc: join(repoRoot, 'scripts', `${LABEL}.plist`),
    plistDest: join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`),
  };
}

/** Root-volume fallback dir for machines whose home launchd cannot load. */
function fallbackPlistDir(override?: string): string {
  // /var/tmp survives reboots (unlike $TMPDIR), is user-writable, root volume
  return override ?? '/var/tmp/crucible';
}

/** True when the agent is present in the caller's launchd domain. */
function agentLoaded(): boolean {
  try {
    execFileSync('launchctl', ['list', LABEL], { stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch { return false; }
}

function bootstrap(p: string): boolean {
  const uid = execFileSync('id', ['-u']).toString().trim();
  try {
    execFileSync('launchctl', ['bootstrap', `gui/${uid}`, p]);
    return true;
  } catch {
    return false;
  }
}

export type WatchdogAction = 'none' | 'installed' | 'updated' | 'load-failed';

export interface EnsureResult { action: WatchdogAction; loaded: boolean; detail?: string }

export function ensureWatchdog(opts: { home?: string; load?: boolean; fallbackDir?: string } = {}): EnsureResult {
  const home = opts.home ?? homedir();
  const fallbackDir = fallbackPlistDir(opts.fallbackDir);
  const p = watchdogPaths(home);
  if (!existsSync(p.scriptSrc) || !existsSync(p.plistSrc)) {
    return { action: 'none', loaded: false, detail: 'source files missing under scripts/ (repo layout changed?)' };
  }

  // 1. converge the script copy (StartInterval re-execs from disk — no reload)
  const srcScript = readFileSync(p.scriptSrc, 'utf8');
  const scriptCurrent = existsSync(p.scriptDest) && readFileSync(p.scriptDest, 'utf8') === srcScript;
  let action: WatchdogAction = 'none';
  if (!scriptCurrent) {
    mkdirSync(join(home, '.crucible'), { recursive: true });
    copyFileSync(p.scriptSrc, p.scriptDest);
    chmodSync(p.scriptDest, 0o755);
    action = existsSync(p.plistDest) ? 'updated' : 'installed';
  }

  // 2. build the wanted plist (placeholder → stable script path) and converge
  //    BOTH candidate locations: home LaunchAgents (normal machines, survives
  //    reboot) and the root-volume fallback (machines whose home won't load).
  const wantPlist = readFileSync(p.plistSrc, 'utf8').replace('CRUCIBLE_WATCHDOG_SCRIPT_PATH', p.scriptDest);
  const loadDirs = [join(home, 'Library', 'LaunchAgents'), fallbackDir];
  let plistChanged = false;
  for (const dir of loadDirs) {
    const dest = join(dir, `${LABEL}.plist`);
    const have = existsSync(dest) ? readFileSync(dest, 'utf8') : null;
    if (have !== wantPlist) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(dest, wantPlist);
      execFileSync('plutil', ['-lint', dest], { stdio: ['ignore', 'pipe', 'ignore'] });
      plistChanged = true;
    }
  }
  if (plistChanged && action === 'none') action = 'installed';

  // 3. load if needed: home first, root-volume fallback on I/O-error homes
  let loaded = agentLoaded();
  if (opts.load !== false && (!loaded || plistChanged)) {
    const uid = execFileSync('id', ['-u']).toString().trim();
    try { execFileSync('launchctl', ['bootout', `gui/${uid}/${LABEL}`], { stdio: 'ignore' }); } catch { /* not loaded */ }
    loaded = bootstrap(p.plistDest);
    let detail: string | undefined;
    if (!loaded) {
      loaded = bootstrap(join(fallbackDir, `${LABEL}.plist`));
      if (loaded) detail = 'home LaunchAgents not loadable on this machine (secondary-volume home) — running from /var/tmp/crucible fallback; reboot needs one server start to re-establish';
    }
    if (loaded) { if (action === 'none') action = 'installed'; return { action, loaded: true, ...(detail ? { detail } : {}) }; }
    return { action: 'load-failed', loaded: false, detail: 'launchctl bootstrap failed from both home and /var/tmp fallback — set CRUCIBLE_WATCHDOG=0 or debug launchd' };
  }
  return { action, loaded };
}

/** Remove agent + copies everywhere (installer --uninstall). Never throws.
 *  bootout is machine-global per user (one agent, one label) — tests MUST
 *  pass unload:false to avoid killing the live agent managed by server start. */
export function uninstallWatchdog(home: string = homedir(), fallbackDir: string = fallbackPlistDir(), opts: { unload?: boolean } = {}): void {
  const p = watchdogPaths(home);
  if (opts.unload !== false) {
    const uid = execFileSync('id', ['-u']).toString().trim();
    try { execFileSync('launchctl', ['bootout', `gui/${uid}/${LABEL}`], { stdio: 'ignore' }); } catch { /* not loaded */ }
  }
  const targets = [p.plistDest, join(fallbackDir, `${LABEL}.plist`), p.scriptDest];
  for (const f of targets) if (existsSync(f)) rmSync(f);
}
