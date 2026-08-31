/** App catalog: simulator app identity (name, bundle id, version, icon) via
 *  `simctl listapps` piped through `plutil -convert json` (the text plist has
 *  nested dicts that defeat hand-parsing). The icon PNG ships inside the .app
 *  bundle — served straight from disk, no copying. Foreground detection =
 *  launchctl's non-Apple UIKitApplication entries. */
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

export interface AppInfo {
  bundleId: string;
  name: string;
  version: string | null;
  path: string;
  iconPath: string | null;
  running: boolean;
}

interface RawApp {
  CFBundleDisplayName?: string;
  CFBundleName?: string;
  CFBundleShortVersionString?: string;
  CFBundleVersion?: string;
  Path?: string;
  CFBundleIconFiles?: string[];
}

/** All apps installed on the simulator, resolved with icons and run state. */
export async function listSimulatorApps(udid: string): Promise<AppInfo[]> {
  const { stdout } = await execFileAsync('xcrun', ['simctl', 'listapps', udid], { maxBuffer: 16 * 1024 * 1024 });
  const foreground = await foregroundBundleIds(udid);
  const raw = JSON.parse(plistToJson(stdout)) as Record<string, RawApp>;
  const apps: AppInfo[] = [];
  for (const [bundleId, a] of Object.entries(raw)) {
    if (!a.Path) continue;
    apps.push({
      bundleId,
      name: a.CFBundleDisplayName ?? a.CFBundleName ?? bundleId,
      version: a.CFBundleShortVersionString ?? a.CFBundleVersion ?? null,
      path: a.Path,
      iconPath: findIcon(a.Path, a.CFBundleIconFiles),
      running: foreground.has(bundleId),
    });
  }
  return apps.sort((a, b) => a.name.localeCompare(b.name));
}

/** plist text → JSON via plutil (synchronous subprocess on stdin). */
function plistToJson(plistText: string): string {
  return execFileSync('plutil', ['-convert', 'json', '-o', '-', '-'], { input: plistText, maxBuffer: 16 * 1024 * 1024 }).toString();
}

/** Best icon on disk: plist-declared CFBundleIconFiles first, then naming
 *  convention. Assets.car-only apps have no loose PNG (null = fallback glyph). */
function findIcon(appPath: string, declared?: string[]): string | null {
  try {
    if (declared) {
      for (const base of declared) {
        for (const suffix of ['', '@2x.png', '@3x.png', '.png']) {
          const p = join(appPath, base + suffix);
          if (existsSync(p)) return p;
        }
      }
    }
    for (const c of ['AppIcon60x60@2x.png', 'AppIcon60x60@3x.png', 'AppIcon76x76@2x~ipad.png', 'AppIcon40x40@2x.png']) {
      const p = join(appPath, c);
      if (existsSync(p)) return p;
    }
    return null;
  } catch { return null; }
}

/** Non-Apple UIKit applications currently running — the foreground candidate set. */
async function foregroundBundleIds(udid: string): Promise<Set<string>> {
  try {
    const { stdout } = await execFileAsync('xcrun', ['simctl', 'spawn', udid, 'launchctl', 'list'], { maxBuffer: 4 * 1024 * 1024 });
    const out = new Set<string>();
    for (const m of stdout.matchAll(/UIKitApplication:([^[]+)\[/g)) {
      const bid = m[1]!;
      if (!bid.startsWith('com.apple.')) out.add(bid);
    }
    return out;
  } catch { return new Set(); }
}

/** The most plausible foreground app: non-Apple running UIKit app, resolved to
 *  full identity from the catalog. Xcode UI-test runners (.xctrunner) are
 *  excluded — they're harness apps, never the recording target. */
export async function foregroundApp(udid: string): Promise<AppInfo | null> {
  const running = await foregroundBundleIds(udid);
  if (running.size === 0) return null;
  const candidates = [...running].filter((bid) => !bid.endsWith('.xctrunner'));
  if (candidates.length === 0) candidates.push(...running);
  const apps = await listSimulatorApps(udid);
  return apps.find((a) => candidates.includes(a.bundleId)) ?? null;
}
