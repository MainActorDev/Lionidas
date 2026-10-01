import { beforeAll, describe, expect, it } from 'vitest';
import { run } from '../src/main.ts';
import { harness, seedOperator, type Harness } from './harness.ts';

/** Phase 3 contract: device/run/queue/flake/net read surfaces + writes with
 *  honest errors. All against the real server harness. */

let h: Harness;
let cookie: string;

beforeAll(async () => {
  h = await harness();
  cookie = await seedOperator(h);
  process.env['LIONIDAS_URL'] = h.baseUrl;
  process.env['LIONIDAS_TOKEN'] = `__cookie__${cookie}`;
});

async function cli(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const savedStdout = process.stdout.write.bind(process.stdout);
  const savedStderr = process.stderr.write.bind(process.stderr);
  let out = '';
  let err = '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (s: string) => { out += s; return true; };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (s: string) => { err += s; return true; };
  let code = 0;
  try { code = await run([...args, '--json']); } catch { code = 1; }
  (process.stdout as { write: unknown }).write = savedStdout;
  (process.stderr as { write: unknown }).write = savedStderr;
  return { code, out, err };
}

describe('phase 3 — devices', () => {
  it('list returns the simulator wall shape (array, --booted filters)', async () => {
    const r = await cli('device', 'list');
    expect(r.code).toBe(0);
    const devices = JSON.parse(r.out) as Array<{ udid: string; state: string }>;
    expect(Array.isArray(devices)).toBe(true);
    const booted = await cli('device', 'list', '--booted');
    const b = JSON.parse(booted.out) as Array<{ state: string }>;
    expect(b.every((x) => x.state === 'Booted')).toBe(true);
  });

  it('power with an invalid action → honest 400', async () => {
    const r = await cli('device', 'power', 'frobnicate', 'some-udid');
    expect(r.code).toBe(1);
    expect(r.out).toContain('action');
  });

  it('power on an unknown udid → 404 surfaced', async () => {
    const r = await cli('device', 'boot', '00000000-0000-0000-0000-000000000000');
    expect(r.code).toBe(1);
    expect(r.out).toContain('unknown device');
  });
});

describe('phase 3 — runs/queue/flakes', () => {
  it('run list returns the runs array shape', async () => {
    const r = await cli('run', 'list', '--limit', '5');
    expect(r.code).toBe(0);
    const runs = JSON.parse(r.out) as Array<{ id: string; status: string }>;
    expect(Array.isArray(runs)).toBe(true);
  });

  it('run get on an unknown id → non-zero + not found', async () => {
    const r = await cli('run', 'get', 'run_doesnotexist');
    expect(r.code).toBe(1);
  });

  it('run triage on an unknown step → non-zero', async () => {
    const r = await cli('run', 'triage', 'run_doesnotexist', '0');
    expect(r.code).toBe(1);
  });

  it('queue list returns an array', async () => {
    const r = await cli('queue', 'list');
    expect(r.code).toBe(0);
    expect(Array.isArray(JSON.parse(r.out))).toBe(true);
  });

  it('flake list returns the flakes shape', async () => {
    const r = await cli('flake', 'list');
    expect(r.code).toBe(0);
    const flakes = JSON.parse(r.out) as Array<{ flow: string; score: number }>;
    expect(Array.isArray(flakes)).toBe(true);
  });

  it('flake quarantine without --reason → honest error', async () => {
    const r = await cli('flake', 'quarantine', 'some_flow');
    expect(r.code).toBe(1);
    expect(r.out.toLowerCase()).toContain('reason');
  });
});

describe('phase 3 — net', () => {
  it('presets + scenarios list are arrays', async () => {
    const p = await cli('net', 'presets');
    expect(p.code).toBe(0);
    expect(Array.isArray(JSON.parse(p.out))).toBe(true);
    const s = await cli('net', 'scenarios');
    expect(s.code).toBe(0);
    expect(Array.isArray(JSON.parse(s.out))).toBe(true);
  });

  it('condition without udid → usage error', async () => {
    const r = await cli('net', 'condition');
    expect(r.code).toBe(1);
    expect(r.out).toContain('udid');
  });

  it('traffic list returns the page shape', async () => {
    const r = await cli('net', 'traffic', '--limit', '10');
    expect(r.code).toBe(0);
    const body = JSON.parse(r.out) as { traffic: unknown[]; total?: number };
    expect(Array.isArray(body.traffic)).toBe(true);
  });

  it('mitm status answers (running boolean either way)', async () => {
    const r = await cli('net', 'mitm');
    expect(r.code).toBe(0);
    const s = JSON.parse(r.out) as { running?: boolean };
    expect(typeof s.running).toBe('boolean');
  });

  it('freeze on an unknown traffic row → non-zero', async () => {
    const r = await cli('net', 'freeze', '999999');
    expect(r.code).toBe(1);
  });
});
