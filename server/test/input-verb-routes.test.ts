/** Stage-1 input-verb manual routes (plan 20261009T001703Z T2) — contract
 *  tests with a fake child (input + shake) and a fake xcrun (pbcopy), plus
 *  session-recording assertions. Mirrors app-uninstall.test.ts shape. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerManualRoutes } from '../src/routes/manual.ts';
import { migrateM1 } from '../src/db/schema.ts';
import { __setSimdeckInputBaseForTest } from '../src/manual/engine-input.ts';

const REAL_PATH = process.env.PATH!;

let root: string;
let bin: string;
let db: Database.Database;
let app: FastifyInstance;
let child: Server;
let childBase = '';
const posts: { path: string; body: Record<string, unknown> }[] = [];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'input-verb-routes-'));
  bin = mkdirSync(join(root, 'bin'), { recursive: true }) as unknown as string;
  process.env.PATH = `${bin}:${REAL_PATH}`;
  db = new Database(':memory:');
  migrateM1(db);
  // fake child: ok acks on /input + /shake, recording posts
  posts.length = 0;
  childBase = await new Promise<string>((resolve) => {
    child = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) : {};
        posts.push({ path: req.url ?? '', body });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    child.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(child.address() as AddressInfo).port}`));
  });
  __setSimdeckInputBaseForTest(() => childBase);
  // fake xcrun: logs args, echoes stdin to a file
  const xcrun = join(bin, 'xcrun');
  writeFileSync(xcrun, [
    '#!/bin/sh',
    `echo "xcrun $@" >> ${JSON.stringify(join(bin, 'calls.log'))}`,
    `cat > ${JSON.stringify(join(bin, 'stdin.txt'))}`,
    'exit 0',
    '',
  ].join('\n'));
  chmodSync(xcrun, 0o755);

  app = Fastify();
  app.addHook('onRequest', async (req: import('fastify').FastifyRequest) => { (req as unknown as { user: unknown }).user = { name: 'test-op', role: 'operator', id: 'usr_t1', email: 'op@test.local' }; });
  registerManualRoutes(app, db, { bus: { emit: () => undefined } as never, artifactsDir: root, forgeState: { activeRunId: null } as never, dispatchDeps: null } as never);
  await app.ready();
});

afterEach(async () => {
  process.env.PATH = REAL_PATH;
  __setSimdeckInputBaseForTest(null);
  await new Promise<void>((r) => { child.closeAllConnections(); child.close(() => r()); });
  await app.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const U = 'UDID-IV';

function seedSession(recording: boolean): void {
  db.prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at)
              VALUES ('run_iv', 'T', 'manual', 'running', 'qa', ?, 0)`).run(U);
  db.prepare(`INSERT INTO manual_sessions(id, run_id, udid, operator, started_at, last_activity, logical_w, logical_h, recording_json)
              VALUES ('ms_iv', 'run_iv', ?, 'qa', 0, 0, 428, 926, ?)`).run(U, recording ? JSON.stringify({ on: true, steps: [] }) : null);
}

function recordedSteps(): { action: string }[] {
  const row = db.prepare('SELECT recording_json FROM manual_sessions WHERE id = ?').get('ms_iv') as { recording_json: string | null };
  return row.recording_json ? (JSON.parse(row.recording_json) as { steps: { action: string }[] }).steps : [];
}

describe('input-verb routes', () => {
  it('double-tap: 4 touch1 posts to the child, recorded as doubleTap step', async () => {
    seedSession(true);
    const r = await app.inject({ method: 'POST', url: '/api/manual/ms_iv/double-tap', payload: { x: 214, y: 500 } });
    expect(r.statusCode).toBe(200);
    expect(posts.map((p) => [p.path, p.body['type']])).toEqual([
      [`/simulators/${U}/input`, 'touch1-down'], [`/simulators/${U}/input`, 'touch1-up'],
      [`/simulators/${U}/input`, 'touch1-down'], [`/simulators/${U}/input`, 'touch1-up'],
    ]);
    expect(posts[0]!.body['width']).toBe(428); // dims flow from the session row
    expect(recordedSteps().map((s) => s.action)).toEqual(['doubleTap']);
  });

  it('long-press: down+up posted, dwell recorded', async () => {
    seedSession(true);
    const r = await app.inject({ method: 'POST', url: '/api/manual/ms_iv/long-press', payload: { x: 100, y: 200, dwellMs: 650 } });
    expect(r.statusCode).toBe(200);
    expect(posts.map((p) => p.body['type'])).toEqual(['touch1-down', 'touch1-up']);
    const steps = recordedSteps();
    expect(steps[0]!.action).toBe('longPress');
  });

  it('shake: child shake route hit, recorded, no positional post', async () => {
    seedSession(true);
    const r = await app.inject({ method: 'POST', url: '/api/manual/ms_iv/shake', payload: {} });
    expect(r.statusCode).toBe(200);
    expect(posts.map((p) => p.path)).toEqual([`/simulators/${U}/shake`]);
    expect(recordedSteps().map((s) => s.action)).toEqual(['shake']);
  });

  it('paste: pbcopy exec with text on stdin + Cmd+V key post; text lands verbatim', async () => {
    seedSession(true);
    const r = await app.inject({ method: 'POST', url: '/api/manual/ms_iv/paste', payload: { text: 'béta-漢字-🎯' } });
    expect(r.statusCode).toBe(200);
    expect(readFileSync(join(bin, 'calls.log'), 'utf8')).toContain(`xcrun simctl pbcopy ${U}`);
    expect(readFileSync(join(bin, 'stdin.txt'), 'utf8')).toBe('béta-漢字-🎯');
    expect(posts.map((p) => [p.body['type'], p.body['code'], p.body['modifiers']])).toEqual([['key', 'KeyV', ['command']]]);
    expect(recordedSteps().map((s) => s.action)).toEqual(['paste']);
  });

  it('paste press=false: no key post (pasteboard only)', async () => {
    seedSession(false);
    const r = await app.inject({ method: 'POST', url: '/api/manual/ms_iv/paste', payload: { text: 'x', press: false } });
    expect(r.statusCode).toBe(200);
    expect(readFileSync(join(bin, 'calls.log'), 'utf8')).toContain('pbcopy');
    expect(posts).toHaveLength(0);
  });

  it('paste empty text → 400', async () => {
    seedSession(false);
    const r = await app.inject({ method: 'POST', url: '/api/manual/ms_iv/paste', payload: { text: '' } });
    expect(r.statusCode).toBe(400);
    expect(existsSync(join(bin, 'calls.log'))).toBe(false);
  });

  it('unknown session → 410', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/manual/ms_none/shake', payload: {} });
    expect(r.statusCode).toBe(410);
  });

  it('missing x,y → 400', async () => {
    seedSession(false);
    const r = await app.inject({ method: 'POST', url: '/api/manual/ms_iv/double-tap', payload: { x: 1 } });
    expect(r.statusCode).toBe(400);
  });
});
