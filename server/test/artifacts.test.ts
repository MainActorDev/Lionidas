import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findArtifacts, importArtifact, listStoreArtifacts, appsStoreDir } from '../src/manual/artifacts.ts';

let root: string;
let store: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'artifacts-test-'));
  store = mkdtempSync(join(tmpdir(), 'store-test-'));
  process.env['CRUCIBLE_APPS_DIR'] = store;
});
afterEach(() => {
  delete process.env['CRUCIBLE_APPS_DIR'];
  rmSync(root, { recursive: true, force: true });
  rmSync(store, { recursive: true, force: true });
});

function plantApp(rel: string, bundleId: string, version: string, mtime: Date): string {
  const app = join(root, rel);
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'Info.plist'), `<?xml version="1.0"?>\n<plist version="1.0"><dict>
    <key>CFBundleIdentifier</key><string>${bundleId}</string>
    <key>CFBundleShortVersionString</key><string>${version}</string>
  </dict></plist>`);
  utimesSync(join(app, 'Info.plist'), mtime, mtime);
  utimesSync(app, mtime, mtime);
  return app;
}

describe('findArtifacts', () => {
  it('finds build-dir and DerivedData layouts, newest first, skips unparsable', () => {
    const old = plantApp('build/record-1/Build/Products/Dev -iphonesimulator/AppOne.app', 'com.a.one', '1.0.0', new Date('2026-09-01T00:00:00Z'));
    const fresh = plantApp('DD/AbCd/Build/Products/Debug-iphonesimulator/AppTwo.app', 'com.a.two', '2.0.0', new Date('2026-09-03T00:00:00Z'));
    mkdirSync(join(root, 'build/broken/Build/Products/Dev -iphonesimulator/Broken.app'), { recursive: true }); // no Info.plist
    const found = findArtifacts([join(root, 'build')], [join(root, 'DD')]);
    expect(found.map((f) => f.bundleId)).toEqual(['com.a.two', 'com.a.one']);
    expect(found[0]!.path).toBe(fresh);
    expect(found[1]!.path).toBe(old);
    expect(found.every((f) => f.source === 'build' || f.source === 'deriveddata')).toBe(true);
  });

  it('returns [] for missing roots', () => {
    expect(findArtifacts([join(root, 'nope')], [join(root, 'nope2')])).toEqual([]);
  });

  it('includes store artifacts in the listing', () => {
    const src = plantApp('build/x/Build/Products/Dev -iphonesimulator/Stored.app', 'com.a.stored', '1.2.3', new Date('2026-09-02T00:00:00Z'));
    importArtifact(src);
    const found = findArtifacts([join(root, 'build')], []);
    const storeHit = found.find((f) => f.bundleId === 'com.a.stored' && f.source === 'store');
    expect(storeHit).toBeDefined();
    expect(storeHit!.path.startsWith(store)).toBe(true);
    expect(listStoreArtifacts()).toHaveLength(1);
  });
});

describe('importArtifact', () => {
  it('clones into the store with a stable name and is idempotent', () => {
    const src = plantApp('build/y/Build/Products/Dev -iphonesimulator/Clone.app', 'com.a.clone', '3.4.0', new Date('2026-09-03T12:00:00Z'));
    const p1 = importArtifact(src);
    expect(p1.startsWith(store)).toBe(true);
    expect(p1).toContain('com.a.clone-3.4.0-');
    expect(p1.endsWith('.app')).toBe(true);
    // the store copy carries the same identity
    expect(readdirSync(p1)).toContain('Info.plist');
    const p2 = importArtifact(src); // second import of same build → same path, no error
    expect(p2).toBe(p1);
  });

  it('throws on unreadable bundle', () => {
    const broken = join(root, 'Broken.app');
    mkdirSync(broken);
    expect(() => importArtifact(broken)).toThrow(/cannot read bundle identity/);
  });

  it('appsStoreDir honors CRUCIBLE_APPS_DIR', () => {
    expect(appsStoreDir()).toBe(store);
  });
});
