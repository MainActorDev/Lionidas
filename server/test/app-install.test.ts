import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, chmodSync, writeFileSync, readFileSync } from 'node:fs';
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

const IPA = join('/store/packages', 'com.test.app-3.4.0.ipa');
const ID = { bundleId: 'com.test.app', version: '3.4.0' };

describe('installApp (package contract — identity owned by the route)', () => {
  it('installs, records into app_catalog, returns version + duration', async () => {
    fakeXcrun(bin, {});
    const r = await installApp({ db }, { udid: 'UDID-1', appPath: IPA, identity: ID });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.version).toBe('3.4.0');
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
    }
    const calls = readFileSync(join(bin, 'calls.log'), 'utf8');
    expect(calls).toContain(`simctl install UDID-1 ${IPA}`);
    expect(lastArtifactFor(db, 'com.test.app')?.artifactPath).toBe(IPA);
    expect(lastArtifactFor(db, 'com.test.app')?.appVersion).toBe('3.4.0');
  });

  it('INSTALL_IN_FLIGHT: second concurrent call does not invoke simctl again', async () => {
    fakeXcrun(bin, { delayMs: 300 });
    const p1 = installApp({ db }, { udid: 'UDID-1', appPath: IPA, identity: ID });
    const r2 = await installApp({ db }, { udid: 'UDID-1', appPath: IPA, identity: ID });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.code).toBe('INSTALL_IN_FLIGHT');
    await p1;
    const calls = readFileSync(join(bin, 'calls.log'), 'utf8');
    expect(calls.match(/simctl install/g)?.length).toBe(1);
  });

  it('different devices install in parallel (per-udid guard)', async () => {
    fakeXcrun(bin, {});
    const [r1, r2] = await Promise.all([
      installApp({ db }, { udid: 'UDID-1', appPath: IPA, identity: ID }),
      installApp({ db }, { udid: 'UDID-2', appPath: IPA, identity: ID }),
    ]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
  });

  it('INSTALL_FAILED surfaces stderr; nothing recorded on failure', async () => {
    fakeXcrun(bin, { fail: true });
    const r = await installApp({ db }, { udid: 'UDID-1', appPath: IPA, identity: ID });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('INSTALL_FAILED');
      expect(r.error).toContain('install failed');
    }
    expect(lastArtifactFor(db, 'com.test.app')).toBeNull(); // nothing recorded on failure
  });
});
