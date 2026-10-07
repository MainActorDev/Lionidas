import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify, { type FastifyInstance } from 'fastify';
import { migrateM1 } from '../src/db/schema.ts';
import { registerProjectRoutes } from '../src/projects/routes.ts';
import { createProject } from '../src/projects/store.ts';

const REAL_PATH = process.env.PATH!;

let root: string;   // holds fake repos (workspaces)
let bin: string;    // fake toolchain
let repos: string;  // CRUCIBLE_REPOS_DIR
let pkgs: string;   // CRUCIBLE_PACKAGES_DIR
let db: Database.Database;
let app: FastifyInstance;

/** fake xcodebuild: -list -json prints one scheme; build creates the .app
 *  product tree with a SIMULATOR Info.plist (or device when platform=iphoneos). */
function fakeToolchain(opts: { platform?: string; failBuild?: boolean } = {}): void {
  const platform = opts.platform ?? 'iphonesimulator';
  const xcb = join(bin, 'xcodebuild');
  writeFileSync(xcb, [
    '#!/bin/sh',
    `echo "xcb $@" >> ${JSON.stringify(join(bin, 'calls.log'))}`,
    // -list -json (scheme discovery)
    'if [ "$1" = "-list" ]; then echo \'{ "project": { "schemes": [ "App", "AppTests" ], "configurations": [ "Debug", "Staging", "Production" ] } }\'; exit 0; fi',
    // build: fabricate the product .app under $CRUCIBLE_PRODUCTS
    opts.failBuild ? 'echo "xcodebuild: error: fabricated failure" >&2; exit 65' : [
      `PROD="$CRUCIBLE_PRODUCTS/Debug-iphonesimulator"`,
      'mkdir -p "$PROD/Fake.app"',
      `cat > "$PROD/Fake.app/Info.plist" <<PLIST`,
      '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.ci.fake</string><key>CFBundleShortVersionString</key><string>7.0.1</string><key>DTPlatformName</key><string>' + platform + '</string></dict></plist>',
      'PLIST',
      'exit 0',
    ].join('\n'),
    '',
  ].join('\n'));
  chmodSync(xcb, 0o755);
  // xcodegen no-op
  const xg = join(bin, 'xcodegen');
  writeFileSync(xg, '#!/bin/sh\nexit 0\n');
  chmodSync(xg, 0o755);
  // fake xcbuddy mirrors the real one: writes the .app into the isolated
  // .derived-data (when the real xcbuddy is absent this shim is what runs)
  const xcbuddy = join(bin, 'xcbuddy');
  writeFileSync(xcbuddy, [
    '#!/bin/sh',
    'echo "xcbuddy $@"',
    opts.failBuild ? 'echo "xcbuddy: error: fabricated failure" >&2; exit 65' : [
      'PROD=".derived-data/Build/Products/Debug-iphonesimulator"',
      'mkdir -p "$PROD/Fake.app"',
      `cat > "$PROD/Fake.app/Info.plist" <<'PLIST'`,
      '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.ci.fake</string><key>CFBundleShortVersionString</key><string>7.0.1</string><key>DTPlatformName</key><string>' + platform + '</string></dict></plist>',
      'PLIST',
      'echo "{\\"success\\":true,\\"status\\":0}"',
      'exit 0',
    ].join('\n'),
    '',
  ].join('\n'));
  chmodSync(xcbuddy, 0o755);
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'cibuild-'));
  bin = mkdtempSync(join(tmpdir(), 'bin-'));
  repos = mkdtempSync(join(tmpdir(), 'repos-'));
  pkgs = mkdtempSync(join(tmpdir(), 'packages-'));
  process.env.PATH = `${bin}:${REAL_PATH}`;
  process.env['CRUCIBLE_REPOS_DIR'] = repos;
  process.env['CRUCIBLE_PACKAGES_DIR'] = pkgs;
  process.env['CRUCIBLE_ARTIFACTS_DIR'] = join(root, 'artifacts');
  fakeToolchain();
  db = new Database(':memory:');
  migrateM1(db);
  app = Fastify();
  app.addHook('onRequest', async (req: import('fastify').FastifyRequest) => { (req as unknown as { user: unknown }).user = { name: 't', role: 'admin' }; });
  registerProjectRoutes(app, db);
  await app.ready();
});
afterEach(async () => {
  delete process.env['CRUCIBLE_REPOS_DIR'];
  delete process.env['CRUCIBLE_PACKAGES_DIR'];
  delete process.env['CRUCIBLE_ARTIFACTS_DIR'];
  delete process.env['CRUCIBLE_PRODUCTS'];
  process.env.PATH = REAL_PATH;
  await app.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
  rmSync(repos, { recursive: true, force: true });
  rmSync(pkgs, { recursive: true, force: true });
});

/** a project whose workspace looks cloned (fake .git + products env pointing
 *  into the bin dir so the fake xcodebuild writes where the builder reads). */
function mkClonedProject(name = 'fakeapp', opts: { buildSimSh?: boolean } = {}): string {
  const p = createProject(db, { name, repoUrl: 'https://github.com/org/fakeapp.git', defaultBranch: 'main' });
  const ws = join(repos, name);
  mkdirSync(join(ws, '.git'), { recursive: true });
  // the generic builder reads products under <ws>/.derived-data — the fake
  // xcodebuild writes wherever $CRUCIBLE_PRODUCTS points; export per-build
  // by making the fake read the env NOW (set at fakeToolchain time is too
  // early) — instead the fake writes to a FIXED path derived from cwd:
  // simplest: patch fake to use "$PWD/.derived-data/Build/Products/..."
  writeFileSync(join(bin, 'xcodebuild'), readFileSync(join(bin, 'xcodebuild'), 'utf8')
    .replace('$CRUCIBLE_PRODUCTS/Debug-iphonesimulator', '$PWD/.derived-data/Build/Products/Debug-iphonesimulator'));
  chmodSync(join(bin, 'xcodebuild'), 0o755);
  if (opts.buildSimSh) {
    mkdirSync(join(ws, 'scripts'), { recursive: true });
    const sh = join(ws, 'scripts', 'build-sim.sh');
    // fabricate a sim ipa directly in <ws>/build/
    writeFileSync(sh, [
      '#!/bin/sh',
      'mkdir -p build Payload-stage/Payload/Fake.app build',
      'cat > Payload-stage/Payload/Fake.app/Info.plist <<PLIST',
      '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.ci.lane</string><key>CFBundleShortVersionString</key><string>9.9.9</string><key>DTPlatformName</key><string>iphonesimulator</string></dict></plist>',
      'PLIST',
      '(cd Payload-stage && zip -q -r -X ../build/lane.ipa Payload)',
      'rm -rf Payload-stage',
      'exit 0',
      '',
    ].join('\n'));
    chmodSync(sh, 0o755);
  }
  return p.id;
}

async function waitSettled(buildId: string, tries = 40): Promise<void> {
  for (let i = 0; i < tries; i++) {
    const b = ((await (await app.inject({ method: 'GET', url: `/api/builds/${buildId}` })).json()) as { build: { status: string } }).build;
    if (b.status !== 'running') return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('build did not settle in time');
}

describe('CI builds', () => {
  it('resolution: manifest > registry > discovery with provenance recorded', async () => {
    // no manifest, nothing pinned → discovered (single app scheme)
    const pid = mkClonedProject('resapp');
    let r = await app.inject({ method: 'POST', url: `/api/projects/${pid}/builds`, payload: {} });
    let b0 = (r.json() as { build: { id: string; scheme: string | null; configuration: string | null; resolution: string } }).build;
    expect(b0.scheme).toBe('App');
    expect(b0.configuration).toBe('Debug');
    expect(JSON.parse(b0.resolution)).toEqual({ scheme: 'discovered', configuration: 'discovered' });
    await waitSettled(b0.id);
    // registry pin wins over discovery
    await app.inject({ method: 'PUT', url: `/api/projects/${pid}`, payload: { buildConfiguration: 'Staging' } });
    r = await app.inject({ method: 'POST', url: `/api/projects/${pid}/builds`, payload: {} });
    b0 = (r.json() as { build: { id: string; scheme: string | null; configuration: string | null; resolution: string } }).build;
    expect(b0.configuration).toBe('Staging');
    expect(JSON.parse(b0.resolution).configuration).toBe('registry');
    await waitSettled(b0.id);
    // manifest wins over everything
    writeFileSync(join(repos, 'resapp', 'lionidas.yml'), 'build:\n  scheme: App\n  configuration: Production\n');
    r = await app.inject({ method: 'POST', url: `/api/projects/${pid}/builds`, payload: {} });
    b0 = (r.json() as { build: { id: string; scheme: string | null; configuration: string | null; resolution: string } }).build;
    expect(b0.configuration).toBe('Production');
    expect(JSON.parse(b0.resolution)).toEqual({ scheme: 'manifest', configuration: 'manifest' });
    await waitSettled(b0.id);
  });

  it('invalid manifest → named failure, no compile', async () => {
    const pid = mkClonedProject('badmfst');
    writeFileSync(join(repos, 'badmfst', 'lionidas.yml'), 'build:\n  schemee: X\n');
    const r = await app.inject({ method: 'POST', url: `/api/projects/${pid}/builds`, payload: {} });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    const body = r.json() as { error?: string };
    expect(body.error ?? '').toContain('build.schemee');
  });

  it('build-inputs endpoint: preview shows manifest + discovery + repo shape', async () => {
    const pid = mkClonedProject('inputsapp');
    writeFileSync(join(repos, 'inputsapp', 'lionidas.yml'), 'build:\n  scheme: App\n');
    const r = await app.inject({ method: 'GET', url: `/api/projects/${pid}/build-inputs` });
    expect(r.statusCode).toBe(200);
    const b = r.json() as { appSchemes: string[]; manifest: { scheme: string | null } | null; effective: { scheme: string | null; schemeResolution: string }; repoShape: string | null };
    expect(b.appSchemes).toContain('App');
    expect(b.manifest?.scheme).toBe('App');
    expect(b.effective.scheme).toBe('App');
    expect(b.effective.schemeResolution).toBe('manifest');
    expect(b.repoShape).toBeTruthy();
  });

  it('generic path: discovers scheme, builds, zips sim ipa, claims package', async () => {
    const pid = mkClonedProject();
    const r = await app.inject({ method: 'POST', url: `/api/projects/${pid}/builds`, payload: {} });
    expect(r.statusCode).toBe(200);
    const b0 = (r.json() as { build: { id: string; number: number; transport: string; scheme: string | null } }).build;
    expect(b0.transport).toBe('generic');
    expect(b0.scheme).toBe('App'); // AppTests skipped
    expect(b0.number).toBe(1);
    await waitSettled(b0.id);
    const b = ((await (await app.inject({ method: 'GET', url: `/api/builds/${b0.id}` })).json()) as { build: { status: string; artifactPath: string | null; error: string | null } }).build;
    expect(b.status).toBe('passed');
    expect(b.artifactPath).toBeTruthy();
    const name = b.artifactPath!.split('/').pop()!;
    expect(name).toBe('fakeapp-7.0.1-1.ipa');
    expect(existsSync(join(pkgs, name))).toBe(true);
    // claimed to the project (packages route lives in manual routes — check the DB seam directly)
    const claim = db.prepare('SELECT p.name FROM package_owner po JOIN projects p ON p.id = po.project_id WHERE po.package_path = ?').get(join(pkgs, name)) as { name: string } | undefined;
    expect(claim?.name).toBe('fakeapp');
  });

  it('repo lane preferred when scripts/build-sim.sh exists', async () => {
    const pid = mkClonedProject('laneapp', { buildSimSh: true });
    const r = await app.inject({ method: 'POST', url: `/api/projects/${pid}/builds`, payload: {} });
    const b0 = (r.json() as { build: { id: string; transport: string } }).build;
    expect(b0.transport).toBe('repo-lane');
    await waitSettled(b0.id);
    const b = ((await (await app.inject({ method: 'GET', url: `/api/builds/${b0.id}` })).json()) as { build: { status: string; artifactPath: string | null } }).build;
    expect(b.status).toBe('passed');
    expect(b.artifactPath!.endsWith('laneapp-9.9.9-1.ipa')).toBe(true);
  });

  it('device-platform artifact fails with the named reason', async () => {
    fakeToolchain({ platform: 'iphoneos' });
    writeFileSync(join(bin, 'xcodebuild'), readFileSync(join(bin, 'xcodebuild'), 'utf8')
      .replace('$CRUCIBLE_PRODUCTS/Debug-iphonesimulator', '$PWD/.derived-data/Build/Products/Debug-iphonesimulator'));
    chmodSync(join(bin, 'xcodebuild'), 0o755);
    const pid = mkClonedProject('devapp');
    const r = await app.inject({ method: 'POST', url: `/api/projects/${pid}/builds`, payload: {} });
    const b0 = (r.json() as { build: { id: string } }).build;
    await waitSettled(b0.id);
    const b = ((await (await app.inject({ method: 'GET', url: `/api/builds/${b0.id}` })).json()) as { build: { status: string; error: string | null } }).build;
    expect(b.status).toBe('failed');
    expect(b.error).toContain('iphoneos');
    expect(b.error).toContain('-sdk iphonesimulator');
  });

  it('build failure → failed with error; no artifact', async () => {
    fakeToolchain({ failBuild: true });
    const pid = mkClonedProject('brokenapp');
    const r = await app.inject({ method: 'POST', url: `/api/projects/${pid}/builds`, payload: {} });
    const b0 = (r.json() as { build: { id: string } }).build;
    await waitSettled(b0.id);
    const b = ((await (await app.inject({ method: 'GET', url: `/api/builds/${b0.id}` })).json()) as { build: { status: string; error: string | null; artifactPath: string | null } }).build;
    expect(b.status).toBe('failed');
    expect(b.error).toContain('fabricated failure');
    expect(b.artifactPath).toBeNull();
  });

  it('CLONE_FIRST 409 when no workspace; numbers increment per project', async () => {
    const p = createProject(db, { name: 'nevercloned', repoUrl: 'https://x/y.git', defaultBranch: 'main' });
    const r = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/builds`, payload: {} });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('CLONE_FIRST');
    // numbering
    const pid = mkClonedProject('numapp');
    const first = ((await (await app.inject({ method: 'POST', url: `/api/projects/${pid}/builds`, payload: {} })).json()) as { build: { id: string; number: number } }).build;
    await waitSettled(first.id);
    const second = ((await (await app.inject({ method: 'POST', url: `/api/projects/${pid}/builds`, payload: {} })).json()) as { build: { number: number } }).build;
    expect(second.number).toBe(2);
  });

  it('log endpoint serves from-byte slices; header carries size', async () => {
    const pid = mkClonedProject('logapp');
    const r = await app.inject({ method: 'POST', url: `/api/projects/${pid}/builds`, payload: {} });
    const b0 = (r.json() as { build: { id: string } }).build;
    await waitSettled(b0.id);
    const full = await app.inject({ method: 'GET', url: `/api/builds/${b0.id}/log` });
    expect(full.statusCode).toBe(200);
    expect(full.body).toContain('transport=');
    expect(full.headers['x-log-size']).toBeTruthy();
    const half = Math.floor(Number(full.headers['x-log-size']) / 2);
    const part = await app.inject({ method: 'GET', url: `/api/builds/${b0.id}/log?from=${half}` });
    expect(part.body.length).toBeLessThan(full.body.length);
  });

  it('operator 403 on build routes', async () => {
    const pid = mkClonedProject('gateapp');
    const opApp = Fastify();
    opApp.addHook('onRequest', async (req: import('fastify').FastifyRequest) => { (req as unknown as { user: unknown }).user = { name: 't', role: 'operator' }; });
    registerProjectRoutes(opApp, db);
    await opApp.ready();
    const start = await opApp.inject({ method: 'POST', url: `/api/projects/${pid}/builds`, payload: {} });
    const list = await opApp.inject({ method: 'GET', url: '/api/builds' });
    expect(start.statusCode).toBe(403);
    expect(list.statusCode).toBe(403);
    await opApp.close();
  });
});

void execFileSync; void readdirSync; void writeFileSync; void mkdirSync;
