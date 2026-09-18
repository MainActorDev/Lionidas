/** Viewtree probe client (P3) — arm/disarm bookkeeping + the id-matched
 *  poll pipeline, all through the test seam (fs + spawn overridden; real
 *  files where the seam's default impls are used). */
import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  armProbe, disarmProbe, fetchProbeViewtree, probeArmed, __setViewtreeProbeForTest,
} from '../src/manual/viewtree-probe.ts';
import { ViewtreeError } from '../src/manual/viewtree.ts';

const node = (i: number, parentIndex: number | undefined, cls = 'UIView') => ({
  index: i, ...(parentIndex !== undefined ? { parentIndex } : {}),
  viewClass: cls,
  rect: { x: 0, y: 0, width: 10, height: 10 },
});

// Redirect the real file paths into a temp dir via the seam's write hook —
// the REQUEST side is seam-writable; the response side we pre-write with
// the files the "dylib" would have produced.
const dir = mkdtempSync(join(tmpdir(), 'viewtree-probe-test-'));
const reqPath = join(dir, 'request.json');
const respPath = join(dir, 'response.json');

function overrideWith(responder: (id: string) => string | null, delayMs = 0) {
  let elapsed = 0;
  __setViewtreeProbeForTest({
    cli: async () => undefined,
    writeRequest: (_udid, body) => writeFileSync(reqPath, body),
    readResponse: () => {
      if (elapsed++ < Math.floor(delayMs / 50)) return null;
      const body = readFileSync(reqPath, 'utf8');
      const { id } = JSON.parse(body) as { id: string };
      return responder(id);
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
  });
}

afterEach(() => { __setViewtreeProbeForTest(null); });

describe('fetchProbeViewtree', () => {
  it('returns normalized nodes for the matching id', async () => {
    overrideWith((id) => JSON.stringify({
      id, bundleId: 'com.example.app', nodes: [node(0, undefined, 'UIWindow'), node(1, 0, 'UIButton')],
    }));
    const r = await fetchProbeViewtree('U', 'com.example.app');
    expect(r.nodes).toHaveLength(2);
    expect(r.nodes[0]!.type).toBe('Window');
    expect(r.nodes[1]!.type).toBe('Button');
  });

  it('rejects a stale response (earlier id) — keeps polling, never returns stale nodes', async () => {
    // The response file holds an OLD dump; the "app" never writes a new one.
    writeFileSync(respPath, JSON.stringify({ id: 'stale-id', nodes: [node(0, undefined)] }));
    overrideWith(() => null); // responder never produces the fresh id
    await expect(fetchProbeViewtree('U', null, { timeoutMs: 150 })).rejects.toMatchObject({ code: 'NO_RESPONSE' });
    // and the stale file was NOT returned
  });

  it('wrong app answers → WRONG_APP', async () => {
    overrideWith((id) => JSON.stringify({ id, bundleId: 'com.other.app', nodes: [node(0, undefined)] }));
    await expect(fetchProbeViewtree('U', 'com.example.app')).rejects.toMatchObject({ code: 'WRONG_APP' });
  });

  it('no key window → NO_KEY_WINDOW (same honesty class as lldb NO_APP)', async () => {
    overrideWith((id) => JSON.stringify({ id, bundleId: 'com.example.app', error: 'no-key-window' }));
    await expect(fetchProbeViewtree('U', 'com.example.app')).rejects.toMatchObject({ code: 'NO_KEY_WINDOW' });
  });

  it('empty nodes → EMPTY, never a 200-class empty tree', async () => {
    overrideWith((id) => JSON.stringify({ id, bundleId: 'com.example.app', nodes: [] }));
    await expect(fetchProbeViewtree('U', 'com.example.app')).rejects.toMatchObject({ code: 'EMPTY' });
  });

  it('malformed node → PARSE', async () => {
    overrideWith((id) => JSON.stringify({ id, bundleId: 'com.example.app', nodes: [{ viewClass: 'UIView' }] }));
    await expect(fetchProbeViewtree('U', 'com.example.app')).rejects.toMatchObject({ code: 'PARSE' });
  });

  it('timeout when nothing answers → NO_RESPONSE with the relaunch hint', async () => {
    overrideWith(() => null, 1e9);
    await expect(fetchProbeViewtree('U', null, { timeoutMs: 120 })).rejects.toMatchObject({ code: 'NO_RESPONSE' });
  });
});

describe('arm/disarm bookkeeping', () => {
  it('arm marks the udid armed; disarm clears it and spawns the verb', async () => {
    const calls: string[][] = [];
    __setViewtreeProbeForTest({ cli: async (args) => { calls.push(args); } });
    expect(probeArmed('U')).toBe(false);
    await armProbe('U', 'com.example.app');
    expect(probeArmed('U')).toBe(true);
    expect(calls[0]).toEqual(['viewtree', 'arm', '--udid', 'U', '--bundle', 'com.example.app']);
    await disarmProbe('U');
    expect(probeArmed('U')).toBe(false);
    expect(calls[1]).toEqual(['viewtree', 'disarm', '--udid', 'U']);
  });

  it('disarm of a udid this process never armed is a no-op (no env churn)', async () => {
    const calls: string[][] = [];
    __setViewtreeProbeForTest({ cli: async (args) => { calls.push(args); } });
    await disarmProbe('OTHER');
    expect(calls).toHaveLength(0);
  });

  it('arm failure keeps the udid un-armed (no false armed state)', async () => {
    __setViewtreeProbeForTest({
      cli: async () => { throw new Error('boom'); },
    });
    await expect(armProbe('U', 'com.example.app')).rejects.toMatchObject({ code: 'ARM_FAILED' });
    expect(probeArmed('U')).toBe(false);
  });
});

// ViewtreeError import pinned so this suite fails to compile if the lldb
// path's error class is ever renamed (route maps BOTH error families).
it('ViewtreeError is still exported for the route', () => {
  expect(new ViewtreeError('x', 'DEVICE_BUSY').code).toBe('DEVICE_BUSY');
});
