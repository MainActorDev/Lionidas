/** Package (.ipa now, .apk later) discovery — replaces .app artifact
 *  discovery (build roots + DerivedData + store), design cleanup direction:
 *  install sources are CI-produced package files dropped in one directory.
 *  Contract for the future CI: CRUCIBLE_PACKAGES_DIR (default
 *  dirname(dbPath)/packages), flat layout, filename carries no semantics —
 *  identity always comes from the package's own manifest. project_id is
 *  nullable from day one for the planned project registry (always null this
 *  round). */
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface PackageInfo {
  path: string;
  bundleId: string | null;
  version: string | null;
  kind: 'ipa' | 'apk';
  platform: string | null;
  mtimeMs: number;
  sizeBytes: number;
  projectId: string | null;
}

/** Absolute path — a relative packages dir would leak into route prefix
 *  checks and client payloads (same rule as the old appsStoreDir). */
export function packagesDir(): string {
  const p = process.env['CRUCIBLE_PACKAGES_DIR'] ?? join(dirname(process.env['CRUCIBLE_DB_PATH'] ?? './crucible.db'), 'packages');
  return resolve(p);
}

/** Centralized repos workspace (decision 2026-10-05: the clone is the only
 *  entry — the system owns where clones live; nobody types a path). A
 *  project's clone = <reposDir>/<project name>. */
export function reposDir(): string {
  const p = process.env['CRUCIBLE_REPOS_DIR'] ?? join(dirname(process.env['CRUCIBLE_DB_PATH'] ?? './crucible.db'), 'repos');
  return resolve(p);
}

/** Where this project's clone lives inside the repos workspace. */
export function projectWorkspace(name: string): string {
  return join(reposDir(), name);
}

/** Bundle id + version from a .ipa: `unzip -p` streams Payload/*.app/Info.plist
 *  to stdout, plutil converts the plist to json on stdin. No extraction to
 *  disk. The plist stays a BUFFER end-to-end — a binary plist survives the
 *  pipe, but toString() mangles its bytes and plutil rejects the result
 *  (caught live: identity read null on every real .ipa). Null on ANY failure —
 *  callers skip the row (a half-copied CI file reads as unreadable and simply
 *  does not list until complete). */
export function readIpaIdentity(ipaPath: string): { bundleId: string; version: string | null; platform: string | null } | null {
  try {
    const plist = execFileSync('unzip', ['-p', ipaPath, 'Payload/*.app/Info.plist'], { maxBuffer: 16 * 1024 * 1024 });
    const json = execFileSync('plutil', ['-convert', 'json', '-o', '-', '-'], { input: plist, maxBuffer: 16 * 1024 * 1024 }).toString();
    const p = JSON.parse(json) as { CFBundleIdentifier?: string; CFBundleShortVersionString?: string; DTPlatformName?: string };
    if (!p.CFBundleIdentifier) return null;
    return { bundleId: p.CFBundleIdentifier, version: p.CFBundleShortVersionString ?? null, platform: p.DTPlatformName ?? null };
  } catch {
    return null;
  }
}

/** A package that can actually run on a simulator. Device/macos builds pass
 *  `simctl install` (structure check only) then die at launch with a generic
 *  "Simulator device failed to launch" — the real reason (SpringBoard
 *  "Bootstrap failed") never reaches the UI. Gate them HERE with a named
 *  error instead. Unknown platform (null) is allowed — Xcode strips DT*
 *  keys in some export paths; we do not reject what we cannot read. */
export function isSimulatorRunnable(pkg: { kind: 'ipa' | 'apk'; platform: string | null }): boolean {
  if (pkg.kind === 'apk') return true; // android lands with its own seam
  return pkg.platform === null || pkg.platform === 'iphonesimulator';
}

/** All .ipa/.apk files in the packages dir, freshest first. Apks list with
 *  null identity (manifest parse lands with Android support). */
export function listPackages(dir: string = packagesDir()): PackageInfo[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return []; }
  const out: PackageInfo[] = [];
  for (const f of entries) {
    const kind = f.endsWith('.ipa') ? 'ipa' : f.endsWith('.apk') ? 'apk' : null;
    if (!kind) continue;
    const full = join(dir, f);
    try {
      const st = statSync(full);
      if (!st.isFile()) continue;
      const id = kind === 'ipa' ? readIpaIdentity(full) : null;
      out.push({ path: full, bundleId: id?.bundleId ?? null, version: id?.version ?? null, kind, platform: id?.platform ?? null, mtimeMs: st.mtimeMs, sizeBytes: st.size, projectId: null });
    } catch { continue; }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
