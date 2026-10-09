/** Stage-1 input-verb case steps (plan 20261009T001703Z T4): doubleTap /
 *  longPress ride the tap path (alloy dispatch shape + tap markers), shake /
 *  paste ride the child wire (location-style step rows). Mirrors
 *  playback-location.test.ts harness shape. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { migrateM1 } from '../src/db/schema.ts';
import { runTemplatePlayback } from '../src/manual/playback.ts';
import { __setAlloyForTest, type AlloyExports } from '../src/alloy/client.ts';
import { __setSimdeckInputBaseForTest } from '../src/manual/engine-input.ts';

const REAL_PATH = process.env.PATH!;

let tmp: string;
let bin: string;
let db: Database.Database;
let child: Server;
const posts: { path: string; body: Record<string, unknown> }[] = [];
const actCalls: Record<string, unknown>[] = [];

function fakeAlloy(): AlloyExports {
  return {
    dispatch: async (tool: string, input: Record<string, unknown>) => {
      if (tool === 'alloy_act') actCalls.push(input);
      if (tool === 'alloy_snapshot') return { ok: true, result: { nodes: [
        { index: 0, parentIndex: -1, type: 'Application', label: 'App', rect: { x: 0, y: 0, width: 428, height: 926 }, hittable: false, ref: 'root' },
        { index: 1, parentIndex: 0, type: 'StaticText', label: 'Home', rect: { x: 0, y: 0, width: 10, height: 10 }, hittable: true, ref: 'n1' },
      ] } };
      return { ok: true, result: {} };
    },
  } as unknown as AlloyExports;
}

const bus = { emit: () => undefined } as never;


async function play(id: string, opts: Record<string, unknown> = {}): Promise<string> {
  const r = await runTemplatePlayback({ db, bus, dispatchDeps: null, artifactsDir: tmp, forgeState: { activeRunId: null }, awaitStreamLive: null } as never, id, opts as never);
  await r.done;
  return r.runId;
}

function seedTemplate(id: string, steps: unknown[]): void {
  db.prepare(`INSERT INTO templates(id, name, udid, steps_json, app_bundle_id, created_by, created_at, updated_at)
              VALUES (?, ?, 'sim', ?, NULL, 'qa', 0, 0)`)
    .run(id, id, JSON.stringify(steps));
  db.prepare(`INSERT INTO devices(udid, name, state, platform, kind, last_seen) VALUES ('sim', 'Sim', 'Booted', 'ios', 'simulator', 0)
              ON CONFLICT(udid) DO UPDATE SET state = 'Booted'`).run();
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'input-verb-pb-'));
  bin = mkdirSync(join(tmp, 'bin'), { recursive: true }) as unknown as string;
  process.env.PATH = `${bin}:${REAL_PATH}`;
  const xcrun = join(bin, 'xcrun');
  // NB: only pbcopy reads stdin — an unconditional `cat` here deadlocks any
  // OTHER xcrun spawn in playback (open stdin pipe, never EOF: live hang).
  writeFileSync(xcrun, [
    '#!/bin/sh',
    `echo "xcrun $@" >> ${JSON.stringify(join(bin, 'calls.log'))}`,
    'if [ "$1" = "simctl" ] && [ "$2" = "pbcopy" ]; then',
    `  cat > ${JSON.stringify(join(bin, 'stdin.txt'))}`,
    'fi',
    'exit 0',
    '',
  ].join('\n'));
  chmodSync(xcrun, 0o755);
  db = new Database(':memory:');
  migrateM1(db);
  __setAlloyForTest(fakeAlloy());
  posts.length = 0; actCalls.length = 0;
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
  const base = await new Promise<string>((r) => child.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(child.address() as AddressInfo).port}`)));
  __setSimdeckInputBaseForTest(() => base);
});

afterEach(async () => {
  process.env.PATH = REAL_PATH;
  __setSimdeckInputBaseForTest(null);
  __setAlloyForTest(null);
  await new Promise<void>((r) => { child.closeAllConnections(); child.close(() => r()); });
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('playback: stage-1 verb steps', () => {
  it('doubleTap dispatches press{doubleTap:true} at the given point and records a tap marker', async () => {
    seedTemplate('tpl_dt', [{ idx: 0, action: 'doubleTap', x: 100, y: 200 }]);
const runId = await play('tpl_dt');
    expect(actCalls.length).toBe(1);
    expect(actCalls[0]).toMatchObject({ action: 'press', doubleTap: true, settle: false, target: { x: 100, y: 200 } });
    const taps = db.prepare('SELECT idx, x, y FROM run_taps WHERE run_id = ?').all(runId) as { idx: number; x: number; y: number }[];
    expect(taps).toHaveLength(1);
    expect(taps[0]).toMatchObject({ idx: 0, x: 100, y: 200 });
    expect((db.prepare("SELECT status FROM run_steps WHERE run_id = ? AND status = 'pass'").get(runId) as { status: string } | undefined)?.status).toBe('pass');
  });

  it('longPress dispatches longpress{durationMs} (default 800) and records a tap marker', async () => {
    seedTemplate('tpl_lp', [{ idx: 0, action: 'longPress', x: 50, y: 60, dwellMs: 650 }]);
const runId = await play('tpl_lp');
    expect(actCalls[0]).toMatchObject({ action: 'longpress', durationMs: 650, settle: false, target: { x: 50, y: 60 } });
    expect((db.prepare('SELECT COUNT(*) c FROM run_taps WHERE run_id = ?').get(runId) as { c: number }).c).toBe(1);
  });

  it('longPress without dwellMs uses the 800ms default', async () => {
    seedTemplate('tpl_lp2', [{ idx: 0, action: 'longPress', x: 5, y: 5 }]);
await play('tpl_lp2');
    expect(actCalls[0]).toMatchObject({ durationMs: 800 });
  });

  it('shake rides the child wire and passes', async () => {
    seedTemplate('tpl_sh', [{ idx: 0, action: 'shake' }]);
const runId = await play('tpl_sh');
    expect(posts.map((p) => p.path)).toEqual(['/simulators/sim/shake']);
    const row = db.prepare('SELECT status FROM run_steps WHERE run_id = ?').get(runId) as { status: string };
    expect(row.status).toBe('pass');
  });

  it('paste resolves ${env} text through pbcopy + Cmd+V and passes with audit', async () => {
    seedTemplate('tpl_pa', [{ idx: 0, action: 'paste', text: '${env.OTP}' }]);
const runId = await play('tpl_pa', { env: { OTP: '漢字-otp-🎯' } });
    expect(readFileSync(join(bin, 'calls.log'), 'utf8')).toContain('xcrun simctl pbcopy sim');
    expect(readFileSync(join(bin, 'stdin.txt'), 'utf8')).toBe('漢字-otp-🎯');
    expect(posts.map((p) => [p.body['type'], p.body['code']])).toEqual([['key', 'KeyV']]);
    const row = db.prepare('SELECT status, evaluated_json FROM run_steps WHERE run_id = ?').get(runId) as { status: string; evaluated_json: string };
    expect(row.status).toBe('pass');
    expect(JSON.parse(row.evaluated_json)).toMatchObject({ action: 'paste', len: '漢字-otp-🎯'.length, press: true });
  });

  it('paste press:false stops after the pasteboard set', async () => {
    seedTemplate('tpl_pa2', [{ idx: 0, action: 'paste', text: 'abc', press: false }]);
await play('tpl_pa2');
    expect(posts).toHaveLength(0); // no Cmd+V
    expect(readFileSync(join(bin, 'calls.log'), 'utf8')).toContain('pbcopy');
  });

  it('paste without text fails the step honestly', async () => {
    seedTemplate('tpl_pa3', [{ idx: 0, action: 'paste' }]);
const runId = await play('tpl_pa3');
    const row = db.prepare('SELECT status, reason FROM run_steps WHERE run_id = ?').get(runId) as { status: string; reason: string };
    expect(row.status).toBe('fail');
    expect(row.reason).toMatch(/text/);
  });
});
