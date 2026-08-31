/** Install/uninstall the forge dead-man watchdog LaunchAgent.
 *
 *  Copies scripts/forge-watchdog.sh to ~/.crucible/ (the plist must reference
 *  a stable path — repo checkouts move), rewrites the placeholder, lints the
 *  plist, and loads it. Idempotent: unload-before-load.
 *
 *  Flags: --uninstall   remove agent + copies
 *         --no-load     stage files only (verify without activating)
 *         --home DIR    override HOME (sandboxed verification) */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const repoRoot = join(import.meta.dirname, '..', '..'); // crucible/
const srcSh = join(repoRoot, 'scripts', 'forge-watchdog.sh');
const srcPlist = join(repoRoot, 'scripts', 'com.crucible.forge-watchdog.plist');
const homeArgIdx = process.argv.indexOf('--home');
const home = homeArgIdx >= 0 ? process.argv[homeArgIdx + 1] : homedir();
const destDir = join(home, '.crucible');
const destSh = join(destDir, 'forge-watchdog.sh');
const destPlist = join(home, 'Library', 'LaunchAgents', 'com.crucible.forge-watchdog.plist');

const uninstall = process.argv.includes('--uninstall');
const noLoad = process.argv.includes('--no-load');

if (uninstall) {
  try { execFileSync('launchctl', ['unload', '-w', destPlist], { stdio: 'ignore' }); } catch { /* not loaded */ }
  for (const f of [destPlist, destSh]) if (existsSync(f)) rmSync(f);
  console.log(`watchdog uninstalled (home: ${home})`);
} else {
  if (!existsSync(srcSh) || !existsSync(srcPlist)) throw new Error(`source files missing under ${repoRoot}/scripts`);
  mkdirSync(destDir, { recursive: true });
  mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
  copyFileSync(srcSh, destSh);
  execFileSync('chmod', ['755', destSh]);
  writeFileSync(destPlist, readFileSync(srcPlist, 'utf8').replace('CRUCIBLE_WATCHDOG_SCRIPT_PATH', destSh));
  execFileSync('plutil', ['-lint', destPlist]);
  if (noLoad) {
    console.log(`watchdog staged WITHOUT loading: ${destPlist} (script ${destSh})`);
  } else {
    try { execFileSync('launchctl', ['unload', '-w', destPlist], { stdio: 'ignore' }); } catch { /* not yet loaded */ }
    execFileSync('launchctl', ['load', '-w', destPlist]);
    console.log(`watchdog installed + loaded: ${destPlist} (script ${destSh})`);
  }
}
