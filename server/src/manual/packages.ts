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

/** Bundle id + version from a .ipa: `unzip -p` streams Payload/*.app/Info.plist
 *  to stdout, plutil converts the plist to json on stdin. No extraction to
 *  disk. The plist stays a BUFFER end-to-end — a binary plist survives the
 *  pipe, but toString() mangles its bytes and plutil rejects the result
 *  (caught live: identity read null on every real .ipa). Null on ANY failure —
 *  callers skip the row (a half-copied CI file reads as unreadable and simply
 *  does not list until complete). */
export function readIpaIdentity(ipaPath: string): { bundleId: string; version: string | null } | null {
  try {
    const plist = execFileSync('unzip', ['-p', ipaPath, 'Payload/*.app/Info.plist'], { maxBuffer: 16 * 1024 * 1024 });
    const json = execFileSync('plutil', ['-convert', 'json', '-o', '-', '-'], { input: plist, maxBuffer: 16 * 1024 * 1024 }).toString();
    const p = JSON.parse(json) as { CFBundleIdentifier?: string; CFBundleShortVersionString?: string };
    if (!p.CFBundleIdentifier) return null;
    return { bundleId: p.CFBundleIdentifier, version: p.CFBundleShortVersionString ?? null };
  } catch {
    return null;
  }
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
      out.push({ path: full, bundleId: id?.bundleId ?? null, version: id?.version ?? null, kind, mtimeMs: st.mtimeMs, sizeBytes: st.size, projectId: null });
    } catch { continue; }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
