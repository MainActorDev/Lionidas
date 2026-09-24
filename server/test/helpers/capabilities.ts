/** Machine-capability detection for the test suite (and `pnpm doctor`).
 *
 *  The suite is written local-first: some files exercise capabilities a
 *  fresh clone or a CI runner does not have (the sibling Alloy repo,
 *  mitmdump, a booted simulator). Those files SKIP with a named reason via
 *  these predicates — an honest skip, never a fake pass. Everything
 *  pure-logic runs everywhere.
 *
 *  Detection mirrors scripts/setup.sh — one capability model, two consumers. */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

/** the execution engine: sibling ../alloy, ALLOY_PATH, or ~/.alloy config */
export function hasAlloy(): boolean {
  if (process.env['ALLOY_PATH'] && existsSync(join(process.env['ALLOY_PATH'], 'package.json'))) return true;
  const cfgPath = join(homedir(), '.alloy', 'crucible.json');
  if (existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(existsSync(cfgPath) ? require('node:fs').readFileSync(cfgPath, 'utf8') : '') as { alloyPath?: string };
      if (cfg.alloyPath && existsSync(join(cfg.alloyPath, 'package.json'))) return true;
    } catch { /* malformed config */ }
  }
  // sibling-repo default, resolved the same way client.ts does
  // (server/test/helpers/ → up 3 → <ai>/alloy)
  const sibling = new URL('../../../../alloy/package.json', import.meta.url);
  return existsSync(sibling);
}

/** the forge proxy binary */
export function hasMitmdump(): boolean {
  try { execFileSync('which', ['mitmdump'], { stdio: 'ignore' }); return true; } catch { return false; }
}

/** simctl + at least one device (booted or not) */
export function hasSimctl(): boolean {
  try { execFileSync('xcrun', ['simctl', 'list', 'devices'], { stdio: 'ignore' }); return true; } catch { return false; }
}

/** named skip reasons, for suite reporting */
export function skipReasons(): string[] {
  const reasons: string[] = [];
  if (!hasAlloy()) reasons.push('Alloy engine not found (scripts/setup.sh clones it to ../alloy)');
  if (!hasMitmdump()) reasons.push('mitmdump not installed (brew install mitmproxy)');
  if (!hasSimctl()) reasons.push('xcrun simctl unavailable (install Xcode + a runtime)');
  return reasons;
}
