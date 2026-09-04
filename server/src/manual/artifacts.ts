/** Artifact discovery + the Crucible-owned store.
 *  Discovery (repo build outputs + DerivedData) is a PICKER data source
 *  ONLY — installing from a discovered path first IMPORTS (APFS clone)
 *  into the store; the catalog and simctl only ever see store paths.
 *  Store root: dirname(CRUCIBLE_DB_PATH)/apps (CRUCIBLE_APPS_DIR override). */
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { readBundleIdentity } from './apps.ts';

export interface ArtifactInfo {
  path: string;
  bundleId: string;
  version: string | null;
  mtimeMs: number;
  source: 'build' | 'deriveddata' | 'store';
}

/** Absolute path — CRUCIBLE_DB_PATH defaults relative ('./crucible.db'), and a
 *  relative store path leaks into the catalog, the route's prefix check, and
 *  client POSTs (cwd-dependent breakage; caught live in the UI drill). */
export function appsStoreDir(): string {
  const p = process.env['CRUCIBLE_APPS_DIR'] ?? join(dirname(process.env['CRUCIBLE_DB_PATH'] ?? './crucible.db'), 'apps');
  return resolve(p);
}

/** Clone a discovered artifact into the store. `cpSync` with
 *  `verbatimSymlinks` uses clonefile(2) on APFS when possible —
 *  near-instant and no extra blocks while the source exists; falls back
 *  to a full copy cross-volume. Store name: <bundleId>-<version>-<mtime>.app
 *  (stable identity, no collision churn). Returns the STORE path. */
export function importArtifact(srcAppPath: string): string {
  const id = readBundleIdentity(srcAppPath);
  if (!id) throw new Error(`cannot read bundle identity from ${srcAppPath}`);
  const dest = join(appsStoreDir(), `${id.bundleId}-${id.version ?? 'unknown'}-${Math.round(statSync(srcAppPath).mtimeMs)}.app`);
  if (!existsSync(dest)) {
    mkdirSync(appsStoreDir(), { recursive: true });
    cpSync(srcAppPath, dest, { recursive: true, verbatimSymlinks: true });
  }
  return dest;
}

export function listStoreArtifacts(): ArtifactInfo[] {
  return scanDir(appsStoreDir(), 'store');
}

/** Discovery roots are app-AGNOSTIC (Crucible tests any iOS app, not just
 *  Lion Parcel): CRUCIBLE_BUILD_ROOTS = colon-separated list of build-output
 *  roots, each scanned at <root>/<job>/Build/Products/<cfg>-iphonesimulator.
 *  CRUCIBLE_LP_BUILD_ROOT (single LP repo) remains as a deprecated fallback.
 *  Everything found is filtered by BUNDLE ID at pick time, never by repo. */
export function defaultBuildRoots(): string[] {
  const multi = process.env['CRUCIBLE_BUILD_ROOTS'];
  if (multi) return multi.split(':').map((r) => r.trim()).filter(Boolean);
  const legacy = process.env['CRUCIBLE_LP_BUILD_ROOT'];
  return [legacy ?? '/Volumes/berkakyo/Users/berkamain/Developer/w0rk/lionparcel/ios-consumer/build'];
}

export function findArtifacts(
  buildRoots: string[] = defaultBuildRoots(),
  derivedRoots: string[] = [process.env['CRUCIBLE_DERIVED_ROOT'] ?? `${process.env.HOME ?? ''}/Library/Developer/Xcode/DerivedData`],
): ArtifactInfo[] {
  const out: ArtifactInfo[] = [
    ...scan(buildRoots, 'build'),
    ...scan(derivedRoots, 'deriveddata'),
    ...listStoreArtifacts(),
  ];
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Both layouts are <root>/<dir>/Build/Products/<cfg>-iphonesimulator/*.app. */
function scan(roots: string[], source: 'build' | 'deriveddata'): ArtifactInfo[] {
  const found: ArtifactInfo[] = [];
  for (const root of roots) {
    let l1: string[];
    try { l1 = readdirSync(root); } catch { continue; }
    for (const a of l1) {
      const products = join(root, a, 'Build', 'Products');
      let cfgs: string[];
      try { cfgs = readdirSync(products); } catch { continue; }
      for (const cfg of cfgs) {
        if (!cfg.endsWith('-iphonesimulator')) continue;
        found.push(...scanDir(join(products, cfg), source));
      }
    }
  }
  return found;
}

/** All valid .app bundles directly inside dir. */
function scanDir(dir: string, source: ArtifactInfo['source']): ArtifactInfo[] {
  const found: ArtifactInfo[] = [];
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return found; }
  for (const app of entries) {
    if (!app.endsWith('.app')) continue;
    const full = join(dir, app);
    try {
      const st = statSync(full);
      if (!st.isDirectory()) continue;
      const id = readBundleIdentity(full);
      if (!id) continue; // partial build output — skip
      found.push({ path: full, bundleId: id.bundleId, version: id.version, mtimeMs: st.mtimeMs, source });
    } catch { continue; }
  }
  return found;
}
