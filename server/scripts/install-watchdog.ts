/** CLI wrapper over the watchdog lifecycle module (forge/watchdog.ts).
 *  Normal operation needs NO invocation — server start converges the agent
 *  automatically (main.ts). This exists for explicit control:
 *    pnpm tsx scripts/install-watchdog.ts [--uninstall] [--no-load] [--home DIR] */
import { ensureWatchdog, uninstallWatchdog } from '../src/forge/watchdog.ts';

if (process.argv.includes('--uninstall')) {
  const homeIdx = process.argv.indexOf('--home');
  const home = homeIdx >= 0 ? process.argv[homeIdx + 1] : undefined;
  uninstallWatchdog(home === undefined ? undefined : home);
  console.log('watchdog uninstalled');
} else {
  const noLoad = process.argv.includes('--no-load');
  const homeIdx = process.argv.indexOf('--home');
  const r = ensureWatchdog({ ...(homeIdx >= 0 ? { home: process.argv[homeIdx + 1] } : {}), load: !noLoad });
  if (r.action === 'load-failed') {
    console.error(`load failed: ${r.detail}`);
    process.exit(1);
  }
  console.log(`watchdog ${r.action}${noLoad ? ' (staged, NOT loaded)' : ''} → ${r.loaded ? 'loaded' : 'not loaded'}`);
}
