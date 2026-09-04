import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerManualRoutes } from '../src/routes/manual.ts';
import { migrateM1 } from '../src/db/schema.ts';
import { lastArtifactFor } from '../src/manual/app-catalog-store.ts';

const REAL_PATH = process.env.PATH!;

let root: string;
let bin: string;
let store: string;
let db: Database.Database;
let app: FastifyInstance;

function fakeXcrun(opts: { fail?: boolean } = {}): void {
  const script = join(bin, 'xcrun');
  writeFileSync(script, [
    '#!/bin/sh',
    `echo "xcrun $@" >> ${JSON.stringify(join(bin, 'calls.log'))}`,
    opts.fail ? 'echo "install failed" >&2; exit 70' : '',
    'exit 0',
    '',
  ].join('\n'));
  chmodSync(script, 0o755);
}

function plantArtifact(bundleId: string, version: string): string {
  const dir = join(root, `${bundleId.replace(/\./g, '_')}.app`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'Info.plist'),
    `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleId}</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`);
  return dir;
}

function seedDevice(udid: string, state: string): void {
  db.prepare(`INSERT INTO devices(udid, name, state, platform, kind, last_seen) VALUES (?, 'Sim', ?, 'ios', 'simulator', 0)
              ON CONFLICT(udid) DO UPDATE SET state = excluded.state`).run(udid, state);
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'install-route-'));
  bin = mkdtempSync(join(tmpdir(), 'bin-'));
  store = mkdtempSync(join(tmpdir(), 'store-'));
  process.env.PATH = `${bin}:${REAL_PATH}`;
  process.env['CRUCIBLE_APPS_DIR'] = store;
  db = new Database(':memory:');
  migrateM1(db);
  app = Fastify();
  registerManualRoutes(app, db, { bus: { emit: () => undefined } as never, artifactsDir: root, forgeState: { activeRunId: null } as never, dispatchDeps: null } as never);
  await app.ready();
});
afterEach(async () => {
  delete process.env['CRUCIBLE_APPS_DIR'];
  process.env.PATH = REAL_PATH;
  await app.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
  rmSync(store, { recursive: true, force: true });
});

const U = 'UDID-1';

describe('POST /api/devices/:udid/install', () => {
  it('missing appPath → 422', async () => {
    seedDevice(U, 'Booted');
    const r = await app.inject({ method: 'POST', url: `/api/devices/${U}/install`, payload: {} });
    expect(r.statusCode).toBe(422);
  });

  it('nonexistent path → 400', async () => {
    seedDevice(U, 'Booted');
    const r = await app.inject({ method: 'POST', url: `/api/devices/${U}/install`, payload: { appPath: '/nope.app' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toContain('artifact not found');
  });

  it('shutdown device → 409 DEVICE_NOT_BOOTED', async () => {
    seedDevice(U, 'Shutdown');
    const app_ = plantArtifact('com.test.app', '1.0.0');
    const r = await app.inject({ method: 'POST', url: `/api/devices/${U}/install`, payload: { appPath: app_ } });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('DEVICE_NOT_BOOTED');
  });

  it('active run → 409 DEVICE_BUSY', async () => {
    seedDevice(U, 'Booted');
    db.prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at)
                VALUES ('run_x', 'T', 'manual', 'running', 'qa', ?, 0)`).run(U);
    const app_ = plantArtifact('com.test.app', '1.0.0');
    const r = await app.inject({ method: 'POST', url: `/api/devices/${U}/install`, payload: { appPath: app_ } });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('DEVICE_BUSY');
  });

  it('happy path imports into store, installs, records catalog', async () => {
    fakeXcrun();
    seedDevice(U, 'Booted');
    const src = plantArtifact('com.test.app', '3.4.0');
    const r = await app.inject({ method: 'POST', url: `/api/devices/${U}/install`, payload: { appPath: src } });
    expect(r.statusCode).toBe(200);
    const b = r.json() as { ok: boolean; version: string | null; durationMs: number };
    expect(b.ok).toBe(true);
    expect(b.version).toBe('3.4.0');
    // catalog points at the STORE copy, not the source
    const last = lastArtifactFor(db, 'com.test.app')!;
    expect(last.artifactPath.startsWith(store)).toBe(true);
    expect(last.artifactPath).not.toBe(src);
    // simctl ran against the store path
    const calls = readFileSync(join(bin, 'calls.log'), 'utf8');
    expect(calls).toContain(last.artifactPath);
  });

  it('simctl failure → 502 INSTALL_FAILED', async () => {
    fakeXcrun({ fail: true });
    seedDevice(U, 'Booted');
    const src = plantArtifact('com.test.app', '1.0.0');
    const r = await app.inject({ method: 'POST', url: `/api/devices/${U}/install`, payload: { appPath: src } });
    expect(r.statusCode).toBe(502);
    expect(r.json().code).toBe('INSTALL_FAILED');
  });
});

describe('GET /api/devices/:udid/artifacts', () => {
  it('lists discovered + store artifacts with source labels', async () => {
    fakeXcrun();
    seedDevice(U, 'Booted');
    // discovery layout: <root>/<job>/Build/Products/<cfg>-iphonesimulator/*.app
    const job = join(root, 'verify-1', 'Build', 'Products', 'Dev -iphonesimulator');
    mkdirSync(job, { recursive: true });
    const src = join(job, 'TestApp.app');
    mkdirSync(src);
    writeFileSync(join(src, 'Info.plist'),
      `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.test.app</string><key>CFBundleShortVersionString</key><string>3.4.0</string></dict></plist>`);
    // import into the store first (as the install route would)
    const r0 = await app.inject({ method: 'POST', url: `/api/devices/${U}/install`, payload: { appPath: src } });
    expect(r0.statusCode).toBe(200);
    // discovery scoped to the test root (no real-machine scan)
    process.env['CRUCIBLE_LP_BUILD_ROOT'] = root;
    process.env['CRUCIBLE_DERIVED_ROOT'] = join(root, 'no-dd');
    try {
      const r = await app.inject({ method: 'GET', url: `/api/devices/${U}/artifacts` });
      expect(r.statusCode).toBe(200);
      const b = r.json() as { artifacts: Array<{ bundleId: string; source: string }> };
      const ids = b.artifacts.map((a) => `${a.bundleId}:${a.source}`);
      expect(ids).toContain('com.test.app:build');
      expect(ids).toContain('com.test.app:store');
    } finally {
      delete process.env['CRUCIBLE_LP_BUILD_ROOT'];
      delete process.env['CRUCIBLE_DERIVED_ROOT'];
    }
  });
});
