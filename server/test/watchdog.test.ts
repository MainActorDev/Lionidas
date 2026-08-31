import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ensureWatchdog, watchdogPaths, uninstallWatchdog } from '../src/forge/watchdog.ts';

let home: string;
let fallbackDir: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'wd-home-'));
  fallbackDir = join(mkdtempSync(join(tmpdir(), 'wd-fb-')), 'crucible');
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** All tests run with load:false + sandboxed dirs — they converge FILES only
 *  and never touch the real launchd agent (which server start manages). */
describe('ensureWatchdog (file convergence)', () => {
  it('installs script + plist (both locations) with placeholder resolved', () => {
    const r = ensureWatchdog({ home, load: false, fallbackDir });
    expect(r.action).toBe('installed');
    const p = watchdogPaths(home);
    expect(existsSync(p.scriptDest)).toBe(true);
    const plist = readFileSync(p.plistDest, 'utf8');
    expect(plist).not.toContain('CRUCIBLE_WATCHDOG_SCRIPT_PATH');
    expect(plist).toContain(p.scriptDest);
    expect(existsSync(join(fallbackDir, 'com.crucible.forge-watchdog.plist'))).toBe(true);
    const mode = execFileSync('stat', ['-f', '%p', p.scriptDest], { encoding: 'utf8' }).trim();
    expect(mode.endsWith('755')).toBe(true);
  });

  it('is idempotent: second run changes nothing', () => {
    ensureWatchdog({ home, load: false, fallbackDir });
    const r2 = ensureWatchdog({ home, load: false, fallbackDir });
    expect(r2.action).toBe('none');
  });

  it('detects script drift and re-copies (updated)', () => {
    ensureWatchdog({ home, load: false, fallbackDir });
    const p = watchdogPaths(home);
    writeFileSync(p.scriptDest, '#!/bin/sh\necho drifted\n');
    const r2 = ensureWatchdog({ home, load: false, fallbackDir });
    expect(r2.action).toBe('updated');
    expect(readFileSync(p.scriptDest, 'utf8')).toBe(readFileSync(p.scriptSrc, 'utf8'));
  });

  it('uninstall removes files from both locations', () => {
    ensureWatchdog({ home, load: false, fallbackDir });
    // unload:false — the bootout is machine-global; tests must not kill the
    // live agent that server start manages
    uninstallWatchdog(home, fallbackDir, { unload: false });
    const p = watchdogPaths(home);
    expect(existsSync(p.scriptDest)).toBe(false);
    expect(existsSync(p.plistDest)).toBe(false);
    expect(existsSync(join(fallbackDir, 'com.crucible.forge-watchdog.plist'))).toBe(false);
  });
});
