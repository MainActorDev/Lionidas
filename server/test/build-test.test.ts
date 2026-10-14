import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify, { type FastifyInstance } from 'fastify';
import { migrateM1, migrateRecipes } from '../src/db/schema.ts';
import { registerManualRoutes } from '../src/routes/manual.ts';
import { registerProjectRoutes } from '../src/projects/routes.ts';
import { startBuild } from '../src/projects/builds.ts';
import { execFileSync } from 'node:child_process';

/** build→test endpoint tests (plan 20261008T083419Z T6). The install step is
 *  stubbed by shadowing xcrun on PATH (raw simctl, review R2) — no device
 *  needed; runBatch itself is exercised through the fake-toolchain build. */

const REAL_PATH = process.env.PATH!;
let root: string;
let bin: string;
let repos: string;
let db: Database.Database;
let app: FastifyInstance;

function fakeToolchain(): void {
  const xcb = join(bin, 'xcodebuild');
  writeFileSync(xcb, [
    '#!/bin/sh',
    'if [ "$1" = "-list" ]; then echo \'{ "project": { "schemes": [ "App", "AppTests" ], "configurations": [ "Debug" ] } }\'; exit 0; fi',
    'PROD=".derived-data/Build/Products/Debug-iphonesimulator"',
    'mkdir -p "$PROD/Fake.app"',
    'cat > "$PROD/Fake.app/Info.plist" <<\'PLIST\'',
    '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.ci.fake</string><key>CFBundleShortVersionString</key><string>1.0.0</string><key>DTPlatformName</key><string>iphonesimulator</string></dict></plist>',
    'PLIST',
    'exit 0',
    '',
  ].join('\n'));
  const xg = join(bin, 'xcodegen');
  writeFileSync(xg, '#!/bin/sh\nexit 0\n');
  // stub xcbuddy too — the engine's which() appends ~/.local/bin where the
  // REAL xcbuddy lives; PATH order must shadow it in tests
  const xcbStub = join(bin, 'xcbuddy');
  writeFileSync(xcbStub, '#!/bin/sh\necho "{\\"success\\":true,\\"status\\":0}"\nexit 0\n');
  // stub xcrun: install "succeeds" (install-first); listapps reports the
  // fake bundle so playback's installed-app gate passes
  const xcrun = join(bin, 'xcrun');
  writeFileSync(xcrun, [
    '#!/bin/sh',
    'echo "stubbed: $@" >> "$FAKE_XCRUN_LOG"',
    'if [ "$2" = "listapps" ]; then printf \'<?xml version="1.0"?><plist version="1.0"><dict><key>com.ci.fake</key><dict><key>Path</key><string>/fake.app</string><key>CFBundleDisplayName</key><string>Fake</string></dict></dict></plist>\'; fi',
    'exit 0',
    '',
  ].join('\n'));
  for (const f of [xcb, xg, xcbStub, xcrun]) { execFileSync('chmod', ['+x', f]); }
}

function makeApp(role: string): FastifyInstance {
  const a = Fastify();
  a.addHook('onRequest', async (req: import('fastify').FastifyRequest) => { (req as unknown as { user: unknown }).user = { name: 't', role }; });
  registerProjectRoutes(a, db);
  registerManualRoutes(a, db as never, { bus: { emit: () => undefined } as never, dispatchDeps: undefined, artifactsDir: process.env['CRUCIBLE_ARTIFACTS_DIR']!, forgeState: { activeRunId: null } } as never);
  return a;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'btest-'));
  bin = mkdtempSync(join(tmpdir(), 'bin-'));
  repos = mkdtempSync(join(tmpdir(), 'repos-'));
  process.env.PATH = `${bin}:${REAL_PATH}`;
  process.env['CRUCIBLE_REPOS_DIR'] = repos;
  process.env['CRUCIBLE_PACKAGES_DIR'] = mkdtempSync(join(tmpdir(), 'pk-'));
  process.env['CRUCIBLE_ARTIFACTS_DIR'] = join(root, 'art');
  process.env['FAKE_XCRUN_LOG'] = join(bin, 'xcrun.log');
  fakeToolchain();
  db = new Database(':memory:');
  migrateM1(db);
  migrateRecipes(db);
  app = makeApp('admin');
  return app.ready();
});
afterEach(async () => {
  process.env.PATH = REAL_PATH;
  await app.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
  rmSync(repos, { recursive: true, force: true });
});

async function mkProjectWithPassedBuild(): Promise<{ projectId: string; buildId: string }> {
  const pid = db.prepare(`INSERT INTO projects(id, name, repo_url, created_at, updated_at) VALUES ('prj_t1', 'testapp', 'https://x/y.git', 0, 0)`).run() ? 'prj_t1' : 'prj_t1';
  const ws = join(repos, 'testapp');
  mkdirSync(join(ws, '.git'), { recursive: true });
  const r = startBuild(db, pid);
  if (!r.ok) throw new Error(`build failed: ${r.error}`);
  // builds settle asynchronously — poll with REAL awaits
  for (let i = 0; i < 200; i++) {
    const row = db.prepare('SELECT status FROM builds WHERE id = ?').get(r.build.id) as { status: string } | undefined;
    if (row && row.status !== 'running') break;
    await new Promise((res) => setTimeout(res, 25));
  }
  const b = db.prepare('SELECT status, smoke, id FROM builds WHERE id = ?').get(r.build.id) as { status: string; smoke: string | null; id: string };
  if (b.status !== 'passed') throw new Error(`build did not pass: ${JSON.stringify(b)}`);
  // force smoke ok (probe would be 'skipped' without a sim — endpoint requires ok)
  db.prepare(`UPDATE builds SET smoke = 'ok' WHERE id = ?`).run(b.id);
  return { projectId: pid, buildId: b.id };
}

function mkSuite(appBundleId: string | null, withMember = true): string {
  const id = `sut_${Math.random().toString(36).slice(2, 8)}`;
  db.prepare('INSERT INTO suites(id, name, app_bundle_id, created_at, updated_at) VALUES (?, ?, ?, 0, 0)').run(id, `suite-${id}`, appBundleId);
  if (withMember) {
    const tpl = `tpl_${Math.random().toString(36).slice(2, 8)}`;
    db.prepare(`INSERT INTO templates(id, name, ticket_key, udid, steps_json, app_bundle_id, created_by, created_at, updated_at) VALUES (?, 'case-${tpl}', 'X', 'u', '[{"idx":0,"action":"expect","selector":{"label":"Sign In"}}]', ?, 't', 0, 0)`).run(tpl, appBundleId ?? 'com.ci.fake');
    db.prepare('INSERT INTO suite_members(suite_id, template_id, position) VALUES (?, ?, 0)').run(id, tpl);
  }
  return id;
}

describe('POST /api/builds/:id/test', () => {
  it('guards: not-passed / no-smoke / no-suite / empty-suite / bundle mismatch', async () => {
    const { buildId } = await mkProjectWithPassedBuild();
    // not passed
    db.prepare(`UPDATE builds SET status = 'failed' WHERE id = ?`).run(buildId);
    let r = await app.inject({ method: 'POST', url: `/api/builds/${buildId}/test`, payload: {} });
    expect(r.statusCode).toBe(409);
    expect((r.json() as { code?: string }).code).toBe('BUILD_NOT_PASSED');
    db.prepare(`UPDATE builds SET status = 'passed' WHERE id = ?`).run(buildId);
    // smoke not ok
    db.prepare(`UPDATE builds SET smoke = 'skipped' WHERE id = ?`).run(buildId);
    r = await app.inject({ method: 'POST', url: `/api/builds/${buildId}/test`, payload: {} });
    expect((r.json() as { code?: string }).code).toBe('SMOKE_NOT_OK');
    db.prepare(`UPDATE builds SET smoke = 'ok' WHERE id = ?`).run(buildId);
    // no suite anywhere
    r = await app.inject({ method: 'POST', url: `/api/builds/${buildId}/test`, payload: {} });
    expect(r.statusCode).toBe(422);
    expect((r.json() as { code?: string }).code).toBe('SUITE_UNSPECIFIED');
    // empty suite
    const empty = mkSuite('com.ci.fake', false);
    r = await app.inject({ method: 'POST', url: `/api/builds/${buildId}/test`, payload: { suiteId: empty } });
    expect(r.statusCode).toBe(409);
    // bundle mismatch
    const wrongBundle = mkSuite('com.other.app');
    r = await app.inject({ method: 'POST', url: `/api/builds/${buildId}/test`, payload: { suiteId: wrongBundle } });
    expect((r.json() as { code?: string }).code).toBe('BUNDLE_MISMATCH');
  });

  it('install-first then runBatch with build pin (runs carry build_id + triggeredBy)', async () => {
    const { buildId } = await mkProjectWithPassedBuild();
    const suiteId = mkSuite('com.ci.fake');
    // a booted sim in the mirror
    db.prepare(`INSERT INTO devices(udid, name, state, kind, last_seen) VALUES ('udid-1', 'Sim A', 'Booted', 'simulator', 0)`).run();
    const r = await app.inject({ method: 'POST', url: `/api/builds/${buildId}/test`, payload: { suiteId, awaitSettle: true } });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { runIds: string[]; batchId?: string; count: number };
    expect(body.runIds.length).toBeGreaterThan(0);
    // install happened BEFORE dispatch (xcrun stub log)
    const log = execFileSync('cat', [process.env['FAKE_XCRUN_LOG']!]).toString();
    expect(log).toContain('simctl install');
    // queue-only dispatch (awaitSettle:false): run rows appear async — poll
    const run = db.prepare('SELECT build_id, triggered_by FROM runs WHERE build_id = ? LIMIT 1').get(buildId) as { build_id: string | null; triggered_by: string } | undefined;
    expect(run, 'run row never created with build pin').toBeTruthy();
    expect(run!.build_id).toBe(buildId);
    // identity rule: session user wins; build provenance lives in build_id (source of truth)
    expect(typeof run!.triggered_by).toBe('string');
  });

  it('default suite from the project is used when none passed', async () => {
    const { buildId, projectId } = await mkProjectWithPassedBuild();
    const suiteId = mkSuite('com.ci.fake');
    db.prepare('UPDATE projects SET default_suite_id = ? WHERE id = ?').run(suiteId, projectId);
    db.prepare(`INSERT INTO devices(udid, name, state, kind, last_seen) VALUES ('udid-1', 'Sim A', 'Booted', 'simulator', 0)`).run();
    const r = await app.inject({ method: 'POST', url: `/api/builds/${buildId}/test`, payload: {} });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { count: number }).count).toBeGreaterThan(0);
  });

  it('suite aggregation on the builds list: pass/fail/running counts', async () => {
    const { buildId } = await mkProjectWithPassedBuild();
    const tpl = `tpl_${Math.random().toString(36).slice(2, 8)}`;
    db.prepare(`INSERT INTO templates(id, name, ticket_key, udid, steps_json, app_bundle_id, created_by, created_at, updated_at) VALUES (?, 'case-aggr', 'X', 'u', '[{"idx":0,"action":"expect","selector":{"label":"Sign In"}}]', NULL, 't', 0, 0)`).run(tpl);
    const mk = (status: string) => db.prepare('INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at, build_id, template_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(`run_${Math.random().toString(36).slice(2, 8)}`, 'X', 'manual', status, 't', 'u', Date.now(), buildId, tpl);
    mk('passed'); mk('passed'); mk('failed'); mk('queued');
    const { listBuilds } = await import('../src/projects/builds.ts');
    const rows = listBuilds(db);
    const b = rows.find((x) => x.id === buildId);
    expect(b?.suite).toEqual(expect.objectContaining({ passed: 2, failed: 1, running: 1, total: 4 }));
    expect((b?.suite as { failedNames?: string[] }).failedNames).toEqual([expect.stringContaining('case-aggr')]);
  });
});
