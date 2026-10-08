import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerManualRoutes } from '../src/routes/manual.ts';
import { migrateM1 } from '../src/db/schema.ts';

const REAL_PATH = process.env.PATH!;

let root: string;
let bin: string;
let db: Database.Database;
let app: FastifyInstance;

function fakeXcrun(opts: { fail?: boolean } = {}): void {
  const script = join(bin, 'xcrun');
  writeFileSync(script, [
    '#!/bin/sh',
    `echo "xcrun $@" >> ${JSON.stringify(join(bin, 'calls.log'))}`,
    opts.fail ? 'echo "uninstall: no such app" >&2; exit 70' : '',
    'exit 0',
    '',
  ].join('\n'));
  chmodSync(script, 0o755);
}

function seedDevice(udid: string, state: string): void {
  db.prepare(`INSERT INTO devices(udid, name, state, platform, kind, last_seen) VALUES (?, 'Sim', ?, 'ios', 'simulator', 0)
              ON CONFLICT(udid) DO UPDATE SET state = excluded.state`).run(udid, state);
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'uninstall-route-'));
  bin = mkdirSync(join(root, 'bin'), { recursive: true }) as unknown as string;
  process.env.PATH = `${bin}:${REAL_PATH}`;
  db = new Database(':memory:');
  migrateM1(db);
  app = Fastify();
  app.addHook('onRequest', async (req: import('fastify').FastifyRequest) => { (req as unknown as { user: unknown }).user = { name: 'test-op', role: 'operator', id: 'usr_t1', email: 'op@test.local' }; });
  registerManualRoutes(app, db, { bus: { emit: () => undefined } as never, artifactsDir: root, forgeState: { activeRunId: null } as never, dispatchDeps: null } as never);
  await app.ready();
});
afterEach(async () => {
  process.env.PATH = REAL_PATH;
  await app.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const U = 'UDID-1';
const APP = 'com.lionparcel.something';

describe('POST /api/devices/:udid/uninstall', () => {
  it('missing bundleId → 422', async () => {
    seedDevice(U, 'Booted');
    const r = await app.inject({ method: 'POST', url: `/api/devices/${U}/uninstall`, payload: {} });
    expect(r.statusCode).toBe(422);
    expect(r.json().code).toBe('BUNDLE_ID_REQUIRED');
  });

  it('malformed bundleId → 422 BUNDLE_ID_INVALID', async () => {
    seedDevice(U, 'Booted');
    const r = await app.inject({ method: 'POST', url: `/api/devices/${U}/uninstall`, payload: { bundleId: 'not valid!' } });
    expect(r.statusCode).toBe(422);
    expect(r.json().code).toBe('BUNDLE_ID_INVALID');
  });

  it('system app → 403 SYSTEM_APP (server-side gate, crafted request)', async () => {
    seedDevice(U, 'Booted');
    fakeXcrun();
    for (const sys of ['com.apple.Preferences', 'com.apple.springboard', 'com.apple.', 'com.apple.hax']) {
      const r = await app.inject({ method: 'POST', url: `/api/devices/${U}/uninstall`, payload: { bundleId: sys } });
      expect(r.statusCode, sys).toBe(403);
      expect(r.json().code, sys).toBe('SYSTEM_APP');
    }
    // simctl never ran
    expect(existsSync(join(bin, 'calls.log'))).toBe(false);
  });

  it('device not booted → 409 DEVICE_NOT_BOOTED', async () => {
    seedDevice(U, 'Shutdown');
    const r = await app.inject({ method: 'POST', url: `/api/devices/${U}/uninstall`, payload: { bundleId: APP } });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('DEVICE_NOT_BOOTED');
  });

  it('active run → 409 DEVICE_BUSY', async () => {
    seedDevice(U, 'Booted');
    db.prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at)
                VALUES ('run_x', 'T', 'manual', 'running', 'qa', ?, 0)`).run(U);
    const r = await app.inject({ method: 'POST', url: `/api/devices/${U}/uninstall`, payload: { bundleId: APP } });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('DEVICE_BUSY');
  });

  it('open manual session → 409 DEVICE_BUSY (even the session app itself)', async () => {
    seedDevice(U, 'Booted');
    db.prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at)
                VALUES ('run_ms', 'T', 'manual', 'passed', 'qa', 'OTHER', 0)`).run();
    db.prepare(`INSERT INTO manual_sessions(id, run_id, udid, operator, started_at, last_activity)
                VALUES ('ms_x', 'run_ms', ?, 'qa', 0, 0)`).run(U);
    const r = await app.inject({ method: 'POST', url: `/api/devices/${U}/uninstall`, payload: { bundleId: APP } });
    expect(r.statusCode).toBe(409);
    expect(r.json().code).toBe('DEVICE_BUSY');
  });

  it('happy path: simctl uninstall called with the right args, audit row written', async () => {
    fakeXcrun();
    seedDevice(U, 'Booted');
    const r = await app.inject({ method: 'POST', url: `/api/devices/${U}/uninstall`, payload: { bundleId: APP } });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { ok: boolean }).ok).toBe(true);
    const calls = readFileSync(join(bin, 'calls.log'), 'utf8');
    expect(calls).toContain(`simctl uninstall ${U} ${APP}`);
    // audit (review F2): who uninstalled what from where
    const audit = db.prepare("SELECT detail, email FROM auth_log WHERE event = 'app_uninstalled'").get() as { detail: string; email: string } | undefined;
    expect(audit).toBeTruthy();
    expect(audit!.detail).toContain(APP);
    expect(audit!.email).toBe('op@test.local');
  });

  it('simctl failure → 502 UNINSTALL_FAILED with stderr surfaced', async () => {
    fakeXcrun({ fail: true });
    seedDevice(U, 'Booted');
    const r = await app.inject({ method: 'POST', url: `/api/devices/${U}/uninstall`, payload: { bundleId: APP } });
    expect(r.statusCode).toBe(502);
    const b = r.json() as { code: string; error: string };
    expect(b.code).toBe('UNINSTALL_FAILED');
    expect(b.error).toContain('no such app');
    // no audit for failures
    expect(db.prepare("SELECT 1 FROM auth_log WHERE event = 'app_uninstalled'").get()).toBeFalsy();
  });

  it('session-only (D5/B): viewer role passes — matches the app-ops family', async () => {
    fakeXcrun();
    seedDevice(U, 'Booted');
    const viewerApp = Fastify();
    viewerApp.addHook('onRequest', async (req: import('fastify').FastifyRequest) => { (req as unknown as { user: unknown }).user = { name: 'v', role: 'viewer' }; });
    registerManualRoutes(viewerApp, db, { bus: { emit: () => undefined } as never, artifactsDir: root, forgeState: { activeRunId: null } as never, dispatchDeps: null } as never);
    await viewerApp.ready();
    const r = await viewerApp.inject({ method: 'POST', url: `/api/devices/${U}/uninstall`, payload: { bundleId: APP } });
    expect(r.statusCode).toBe(200);
    await viewerApp.close();
  });
});
