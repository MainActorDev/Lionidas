import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrateM1 } from '../src/db/schema.ts';
import { installApp } from '../src/manual/app-install.ts';
import { lastArtifactFor } from '../src/manual/app-catalog-store.ts';

const REAL_PATH = process.env.PATH!;

function fakeXcrun(dir: string, opts: { delayMs?: number; fail?: boolean }): void {
  const script = join(dir, 'xcrun');
  writeFileSync(script, [
    '#!/bin/sh',
    `echo "xcrun $@" >> ${JSON.stringify(join(dir, 'calls.log'))}`,
    opts.delayMs ? `sleep ${(opts.delayMs / 1000).toFixed(1)}` : '',
    opts.fail ? 'echo "install failed" >&2; exit 70' : '',
    'exit 0',
    '',
  ].join('\n'));
  chmodSync(script, 0o755);
}

function plantArtifact(root: string, bundleId: string, version: string): string {
  const app = join(root, `${bundleId.replace(/\./g, '_')}.app`);
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'Info.plist'),
    `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleId}</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`);
  return app;
}

let root: string;
let bin: string;
let db: Database.Database;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'app-install-test-'));
  bin = mkdtempSync(join(tmpdir(), 'bin-'));
  db = new Database(':memory:');
  migrateM1(db);
  process.env.PATH = `${bin}:${REAL_PATH}`;
});
afterEach(() => {
  process.env.PATH = REAL_PATH;
  rmSync(root, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
  db.close();
});

describe('installApp', () => {
  it('installs, records into app_catalog, returns version + duration', async () => {
    fakeXcrun(bin, {});
    const app = plantArtifact(root, 'com.test.app', '3.4.0');
    const r = await installApp({ db }, { udid: 'UDID-1', appPath: app });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.version).toBe('3.4.0');
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
    }
    const calls = readFileSync(join(bin, 'calls.log'), 'utf8');
    expect(calls).toContain('simctl install UDID-1');
    expect(lastArtifactFor(db, 'com.test.app')?.artifactPath).toBe(app);
    expect(lastArtifactFor(db, 'com.test.app')?.appVersion).toBe('3.4.0');
  });

  it('INSTALL_IN_FLIGHT: second concurrent call does not invoke simctl again', async () => {
    fakeXcrun(bin, { delayMs: 300 });
    const app = plantArtifact(root, 'com.test.app', '1.0.0');
    const p1 = installApp({ db }, { udid: 'UDID-1', appPath: app });
    const r2 = await installApp({ db }, { udid: 'UDID-1', appPath: app });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.code).toBe('INSTALL_IN_FLIGHT');
    await p1;
    const calls = readFileSync(join(bin, 'calls.log'), 'utf8');
    expect(calls.match(/simctl install/g)?.length).toBe(1);
  });

  it('different devices install in parallel (per-udid guard)', async () => {
    fakeXcrun(bin, {});
    const app = plantArtifact(root, 'com.test.app', '1.0.0');
    const [r1, r2] = await Promise.all([
      installApp({ db }, { udid: 'UDID-1', appPath: app }),
      installApp({ db }, { udid: 'UDID-2', appPath: app }),
    ]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
  });

  it('INSTALL_FAILED surfaces stderr; ARTIFACT_UNREADABLE when identity missing', async () => {
    fakeXcrun(bin, { fail: true });
    const app = plantArtifact(root, 'com.test.app', '1.0.0');
    const r = await installApp({ db }, { udid: 'UDID-1', appPath: app });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('INSTALL_FAILED');
      expect(r.error).toContain('install failed');
    }
    const broken = join(root, 'Broken.app');
    mkdirSync(broken);
    const r2 = await installApp({ db }, { udid: 'UDID-1', appPath: broken });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.code).toBe('ARTIFACT_UNREADABLE');
    expect(lastArtifactFor(db, 'com.test.app')).toBeNull(); // nothing recorded on failure
  });
});
