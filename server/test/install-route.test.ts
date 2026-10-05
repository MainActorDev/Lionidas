import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, readFileSync, utimesSync, existsSync } from 'node:fs';
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
let pkgDir: string;
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

/** A real .ipa on disk: Payload/<name>.app/Info.plist inside a genuine zip —
 *  identity is read by the production unzip -p + plutil path. */
function plantPackage(bundleId: string, version: string, name = `${bundleId.replace(/\./g, '_')}-${version}.ipa`): string {
  const p = join(pkgDir, name);
  const stage = join(root, 'stage');
  const appDir = join(stage, 'Payload', `${bundleId.replace(/\./g, '_')}.app`);
  mkdirSync(appDir, { recursive: true });
  writeFileSync(join(appDir, 'Info.plist'),
    `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleId}</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`);
  execFileSync('zip', ['-q', '-X', p, '-r', 'Payload'], { cwd: stage });
  rmSync(stage, { recursive: true, force: true });
  return p;
}

function seedDevice(udid: string, state: string): void {
  db.prepare(`INSERT INTO devices(udid, name, state, platform, kind, last_seen) VALUES (?, 'Sim', ?, 'ios', 'simulator', 0)
              ON CONFLICT(udid) DO UPDATE SET state = excluded.state`).run(udid, state);
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'install-route-'));
  bin = mkdtempSync(join(tmpdir(), 'bin-'));
  pkgDir = mkdtempSync(join(tmpdir(), 'packages-'));
  process.env.PATH = `${bin}:${REAL_PATH}`;
  process.env['CRUCIBLE_PACKAGES_DIR'] = pkgDir;
  db = new Database(':memory:');
  migrateM1(db);
  app = Fastify();
  // satisfy requireRole on the upload route (unit scope — auth itself is
  // covered by the auth suites)
  app.addHook('onRequest', async (req: import('fastify').FastifyRequest) => { (req as unknown as { user: unknown }).user = { name: 'test-op', role: 'operator' }; });
  registerManualRoutes(app, db, { bus: { emit: () => undefined } as never, artifactsDir: root, forgeState: { activeRunId: null } as never, dispatchDeps: null } as never);
  await app.ready();
});
afterEach(async () => {
  delete process.env['CRUCIBLE_PACKAGES_DIR'];
  process.env.PATH = REAL_PATH;
  await app.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
  rmSync(pkgDir, { recursive: true, force: true });
});

const U = 'UDID-1';

describe('POST /api/devices/:udid/install (packages)', () => {
  it('missing packagePath → 422', async () => {
    seedDevice(U, 'Booted');
    const r = await app.inject({ method: 'POST', url: `/api/devices/${U}/install`, payload: {} });
    expect(r.statusCode).toBe(422);
  });

  it('path outside the packages dir → 400 PACKAGE_OUTSIDE_DIR', async () => {
    seedDevice(U, 'Booted');
    const r = await app.inject({ method: 'POST', url: `/api/devices/${U}/install`, payload: { packagePath: '/etc/passwd.ipa' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('PACKAGE_OUTSIDE_DIR');
  });

  it('nonexistent package → 400', async () => {
    seedDevice(U, 'Booted');
    const r = await app.inject({ method: 'POST', url: `/api/devices/${U}/install`, payload: { packagePath: join(pkgDir, 'nope.ipa') } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toContain('package not found');
  });

  it('.apk → 422 APK_UNSUPPORTED', async () => {
    seedDevice(U, 'Booted');
    const p = join(pkgDir, 'thing.apk');
    writeFileSync(p, 'bytes');
    const r = await app.inject({ method: 'POST', url: `/api/devices/${U}/install`, payload: { packagePath: p } });
    expect(r.statusCode).toBe(422);
    expect(r.json().code).toBe('APK_UNSUPPORTED');
  });

  it('unreadable ipa → 400 PACKAGE_UNREADABLE', async () => {
    seedDevice(U, 'Booted');
    const p = join(pkgDir, 'broken.ipa');
    writeFileSync(p, 'not a zip');
    const r = await app.inject({ method: 'POST', url: `/api/devices/${U}/install`, payload: { packagePath: p } });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('PACKAGE_UNREADABLE');
  });

  it('shutdown device → 409 DEVICE_NOT_BOOTED', async () => {
    seedDevice(U, 'Shutdown');
    const p = plantPackage('com.test.app', '1.0.0');
    const r = await app.inject({ method: 'POST', url: `/api/devices/${U}/install`, payload: { packagePath: p } });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('DEVICE_NOT_BOOTED');
  });

  it('active run → 409 DEVICE_BUSY', async () => {
    seedDevice(U, 'Booted');
    db.prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at)
                VALUES ('run_x', 'T', 'manual', 'running', 'qa', ?, 0)`).run(U);
    const p = plantPackage('com.test.app', '1.0.0');
    const r = await app.inject({ method: 'POST', url: `/api/devices/${U}/install`, payload: { packagePath: p } });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('DEVICE_BUSY');
  });

  it('happy path installs the ipa directly, records catalog', async () => {
    fakeXcrun();
    seedDevice(U, 'Booted');
    const p = plantPackage('com.test.app', '3.4.0');
    const r = await app.inject({ method: 'POST', url: `/api/devices/${U}/install`, payload: { packagePath: p } });
    expect(r.statusCode).toBe(200);
    const b = r.json() as { ok: boolean; version: string | null; durationMs: number };
    expect(b.ok).toBe(true);
    expect(b.version).toBe('3.4.0');
    // catalog points at the package file itself
    const last = lastArtifactFor(db, 'com.test.app')!;
    expect(last.artifactPath).toBe(p);
    // simctl ran against the package path
    const calls = readFileSync(join(bin, 'calls.log'), 'utf8');
    expect(calls).toContain(p);
  });

  it('simctl failure → 502 INSTALL_FAILED', async () => {
    fakeXcrun({ fail: true });
    seedDevice(U, 'Booted');
    const p = plantPackage('com.test.app', '1.0.0');
    const r = await app.inject({ method: 'POST', url: `/api/devices/${U}/install`, payload: { packagePath: p } });
    expect(r.statusCode).toBe(502);
    expect(r.json().code).toBe('INSTALL_FAILED');
  });
});

describe('POST /api/packages (upload)', () => {
  it('round-trips a real ipa: buffer body → file on disk → identity', async () => {
    // build a fixture ipa in a temp spot, read its bytes, upload them
    const stage = mkdtempSync(join(tmpdir(), 'stage-'));
    const appDir = join(stage, 'Payload', 'Upload.app');
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, 'Info.plist'),
      `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.upload.test</string><key>CFBundleShortVersionString</key><string>2.0.1</string></dict></plist>`);
    execFileSync('zip', ['-q', '-X', join(stage, 'up.ipa'), '-r', 'Payload'], { cwd: stage });
    const bytes = readFileSync(join(stage, 'up.ipa'));
    const r = await app.inject({ method: 'POST', url: '/api/packages?filename=uploaded.ipa', headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) }, payload: bytes });
    expect(r.statusCode).toBe(200);
    const b = r.json() as { ok: boolean; path: string; bundleId: string | null; version: string | null; kind: string };
    expect(b.ok).toBe(true);
    expect(b.bundleId).toBe('com.upload.test');
    expect(b.version).toBe('2.0.1');
    expect(b.kind).toBe('ipa');
    expect(existsSync(join(pkgDir, 'uploaded.ipa'))).toBe(true);
    // listed by GET afterwards
    const g = await app.inject({ method: 'GET', url: '/api/packages' });
    const gb = g.json() as { packages: Array<{ path: string }> };
    expect(gb.packages.some((p) => p.path.endsWith('uploaded.ipa'))).toBe(true);
    rmSync(stage, { recursive: true, force: true });
  });

  it('bad extension → 422 BAD_EXTENSION; missing filename → 422', async () => {
    const r1 = await app.inject({ method: 'POST', url: '/api/packages?filename=thing.zip', headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from('x') });
    expect(r1.statusCode).toBe(422);
    expect(r1.json().code).toBe('BAD_EXTENSION');
    const r2 = await app.inject({ method: 'POST', url: '/api/packages', headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from('x') });
    expect(r2.statusCode).toBe(422);
  });

  it('path traversal in filename → 422 BAD_FILENAME', async () => {
    const r = await app.inject({ method: 'POST', url: `/api/packages?filename=${encodeURIComponent('../../etc/evil.ipa')}`, headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from('x') });
    expect(r.statusCode).toBe(422);
    expect(r.json().code).toBe('BAD_FILENAME');
  });

  it('same name different size → 409 NAME_TAKEN', async () => {
    writeFileSync(join(pkgDir, 'clash.ipa'), 'original-bytes');
    const r = await app.inject({ method: 'POST', url: '/api/packages?filename=clash.ipa', headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from('different-length') });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('NAME_TAKEN');
  });
});

describe('GET /api/packages', () => {
  it('lists packages freshest-first with identity, ships dir', async () => {
    fakeXcrun();
    seedDevice(U, 'Booted');
    const a = plantPackage('com.test.app', '3.4.0');
    const older = plantPackage('com.test.app', '3.3.0', 'older.ipa');
    utimesSync(older, new Date(Date.now() - 86_400_000), new Date(Date.now() - 86_400_000));
    writeFileSync(join(pkgDir, 'android-thing.apk'), 'apk bytes');
    writeFileSync(join(pkgDir, 'not-a-package.txt'), 'ignore me');
    const r = await app.inject({ method: 'GET', url: '/api/packages' });
    expect(r.statusCode).toBe(200);
    const b = r.json() as { dir: string; packages: Array<{ path: string; bundleId: string | null; version: string | null; kind: string }> };
    expect(b.dir).toBe(pkgDir);
    const paths = b.packages.map((p) => p.path);
    expect(paths).toContain(a);
    expect(paths).toContain(older);
    expect(paths.indexOf(a)).toBeLessThan(paths.indexOf(older)); // freshest first
    const ipa = b.packages.find((p) => p.path === a)!;
    expect(ipa.bundleId).toBe('com.test.app');
    expect(ipa.version).toBe('3.4.0');
    expect(ipa.kind).toBe('ipa');
    const apk = b.packages.find((p) => p.path.endsWith('.apk'))!;
    expect(apk.bundleId).toBeNull(); // identity lands with Android
    expect(b.packages.some((p) => p.path.endsWith('.txt'))).toBe(false);
  });
});
