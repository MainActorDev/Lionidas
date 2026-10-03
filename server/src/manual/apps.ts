/** App catalog: simulator app identity (name, bundle id, version, icon) via
 *  `simctl listapps` piped through `plutil -convert json` (the text plist has
 *  nested dicts that defeat hand-parsing). The icon PNG ships inside the .app
 *  bundle — served straight from disk, no copying. Foreground detection =
 *  launchctl's non-Apple UIKitApplication entries. */
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const execFileAsync = promisify(execFile);

export interface AppInfo {
  bundleId: string;
  name: string;
  version: string | null;
  /** CFBundleVersion — the build ID (e.g. '420'), distinct from the marketing version */
  build: string | null;
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
/** Open a URL/deep link on the simulator (simctl openurl). R2 screen
 *  registry: deep-link entries and deepLink refresh gestures land here —
 *  host-level op, same executor family as the other app ops in this module
 *  (device-boundary allowlisted). */
/** Post a Darwin notification INTO the simulator's own notifyd domain
 *  (host notifyutil does not reach the sim — must spawn inside it).
 *  Consumed by the app's uitest refresh seam: signal => in-place refetch. */
export async function postDarwinNotification(udid: string, name: string): Promise<void> {
  await execFileAsync('xcrun', ['simctl', 'spawn', udid, 'notifyutil', '-p', name], { timeout: 5_000 });
}

export async function openSimulatorUrl(udid: string, url: string): Promise<void> {
  await execFileAsync('xcrun', ['simctl', 'openurl', udid, url], { timeout: 10_000 });
}

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
      // simctl's plist often OMITS CFBundleShortVersionString (seen live: the
      // key absent while the bundle's own Info.plist carries '1.0.0') — read
      // the on-disk plist before falling back to the opaque build number
      version: a.CFBundleShortVersionString ?? shortVersionFromBundle(a.Path) ?? a.CFBundleVersion ?? null,
      build: a.CFBundleVersion ?? null,
      path: a.Path,
      iconPath: findIcon(a.Path, a.CFBundleIconFiles),
      running: foreground.has(bundleId),
    });
  }
  return apps.sort((a, b) => a.name.localeCompare(b.name));
}

/** CFBundleShortVersionString from an app bundle's Info.plist ('' on failure). */
function shortVersionFromBundle(appPath: string): string | null {
  try {
    const json = execFileSync('plutil', ['-convert', 'json', '-o', '-', join(appPath, 'Info.plist')], { maxBuffer: 1024 * 1024 }).toString();
    const v = (JSON.parse(json) as { CFBundleShortVersionString?: string }).CFBundleShortVersionString;
    return v ?? null;
  } catch { return null; }
}

/** Bundle id + version from an on-disk .app's Info.plist (null on any
 *  failure — callers treat unreadable as "skip this artifact"). */
export function readBundleIdentity(appPath: string): { bundleId: string; version: string | null } | null {
  try {
    const json = execFileSync('plutil', ['-convert', 'json', '-o', '-', join(appPath, 'Info.plist')], { maxBuffer: 1024 * 1024 }).toString();
    const p = JSON.parse(json) as { CFBundleIdentifier?: string; CFBundleShortVersionString?: string };
    if (!p.CFBundleIdentifier) return null;
    return { bundleId: p.CFBundleIdentifier, version: p.CFBundleShortVersionString ?? null };
  } catch { return null; }
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

/** The ACTUAL foreground app, straight from the accessibility tree: the
 *  snapshot root node is type Application and its label is the app's name
 *  (e.g. "Settings" — including Apple apps, which launchctl-based guesses
 *  miss). Resolved to full identity (bundle id, icon) via the catalog.
 *  Requires an active app session on the device (manual sessions have one). */
export async function foregroundAppFromSnapshot(deps: { dispatch: (tool: string, input: unknown, deps: unknown) => Promise<unknown> }, dispatchDeps: unknown, udid: string): Promise<AppInfo | null> {
  const r = (await deps.dispatch('alloy_snapshot', { udid, interactiveOnly: false }, dispatchDeps)) as
    | { ok: true; result: { nodes?: Array<{ type?: string; label?: string }> } }
    | { ok: false };
  if (!r.ok) return null;
  const root = r.result.nodes?.[0];
  if (!root || root.type !== 'Application' || !root.label) return null;
  const apps = await listSimulatorApps(udid);
  // match by display name (snapshot label == CFBundleDisplayName)
  return apps.find((a) => a.name === root.label) ?? null;
}
