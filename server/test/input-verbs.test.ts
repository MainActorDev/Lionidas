/** Stage-1 input-verb wire helpers (engine-input.ts) — contract tests
 *  against a fake child, mirroring engine-input.test.ts. Covers: verb
 *  request shapes, timed sequences, busy-ack passthrough (plan F2), paste
 *  composition (F1: pbcopy + Cmd+V), and error paths. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  __setSimdeckInputBaseForTest,
  doubleTapSim,
  longPressSim,
  pasteTextSim,
  shakeSim,
  assertAckVerbose,
} from '../src/manual/engine-input.ts';

let srv: Server | null = null;
const posts: { path: string; body: Record<string, unknown> }[] = [];
/** script: index into `responses` per request to this path */
let responder: ((path: string, body: Record<string, unknown>, n: number) => { status: number; json: unknown }) | null = null;

function startFakeChild(): Promise<string> {
  return new Promise((resolve) => {
    srv = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const n = posts.length;
        const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) : {};
        posts.push({ path: req.url ?? '', body });
        const r = responder ? responder(req.url ?? '', body, n) : { status: 200, json: { ok: true } };
        res.writeHead(r.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r.json));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(srv!.address() as AddressInfo).port}`));
  });
}

afterEach(async () => {
  __setSimdeckInputBaseForTest(null);
  responder = null;
  posts.length = 0;
  await new Promise<void>((r) => {
    if (!srv) return r();
    // undici keeps idle sockets open; plain close() waits for them and hangs
    srv.closeAllConnections();
    srv.close(() => r());
    srv = null;
  });
});

const DIMS = { logicalW: 428, logicalH: 926 };

describe('doubleTapSim', () => {
  it('sends the four touch1 events with dims, down-up-down-up order', async () => {
    const base = await startFakeChild();
    __setSimdeckInputBaseForTest(() => base);
    responder = () => ({ status: 200, json: { ok: true } });
    await doubleTapSim('UDID-1', 214, 500, DIMS);
    const kinds = posts.map((p) => [p.path, p.body['type'], p.body['x'], p.body['width']] as const);
    expect(kinds).toEqual([
      ['/simulators/UDID-1/input', 'touch1-down', 214, 428],
      ['/simulators/UDID-1/input', 'touch1-up', 214, 428],
      ['/simulators/UDID-1/input', 'touch1-down', 214, 428],
      ['/simulators/UDID-1/input', 'touch1-up', 214, 428],
    ]);
  });

  it('surfaces a busy ack verbatim as INPUT_REFUSED and stops the sequence (F2)', async () => {
    const base = await startFakeChild();
    __setSimdeckInputBaseForTest(() => base);
    responder = (_p, _b, n) => (n === 1 ? { status: 200, json: { ok: false, error: 'device busy: a gesture is already in flight' } } : { status: 200, json: { ok: true } });
    await expect(doubleTapSim('UDID-1', 10, 10, DIMS)).rejects.toThrow(/INPUT_REFUSED: device busy/);
    // sequence aborted at event 2 of 4 — no blind retry
    expect(posts).toHaveLength(2);
  });
});

describe('longPressSim', () => {
  it('sends down→(dwell)→up with the requested dwell honored by wall clock', async () => {
    const _base = await startChildAndSet();
    const t0 = Date.now();
    await longPressSim('UDID-1', 100, 200, 150, DIMS);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(140); // dwell actually slept
    expect(posts.map((p) => p.body['type'])).toEqual(['touch1-down', 'touch1-up']);
    function startChildAndSet(): Promise<string> { return startFakeChild().then((b) => { __setSimdeckInputBaseForTest(() => b); return b; }); }
  });

  it('zero dwell falls back to the probed default (800ms)', async () => {
    await startFakeChild().then((b) => { __setSimdeckInputBaseForTest(() => b); });
    const t0 = Date.now();
    await longPressSim('UDID-1', 1, 1, 0, DIMS);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(780);
  });
});

describe('shakeSim', () => {
  it('POSTs the child shake route (not /input)', async () => {
    await startFakeChild().then((b) => { __setSimdeckInputBaseForTest(() => b); });
    await shakeSim('UDID-9');
    expect(posts.map((p) => p.path)).toEqual(['/simulators/UDID-9/shake']);
  });
});

describe('pasteTextSim', () => {
  const fakeExec = vi.fn((..._a: unknown[]) => {
    // minimal ExecFile child stand-in
    const handlers: Record<string, (() => void)[]> = {};
    const child = {
      stdin: {
        on: (_e: string, cb: () => void) => { (handlers['err'] ??= []).push(cb); },
        end: (_data: string, _enc: string, cb?: () => void) => { cb?.(); },
      },
    };
    // succeed async
    queueMicrotask(() => { (child as unknown as { callback?: unknown }).callback = undefined; });
    return child;
  }) as unknown as typeof import('node:child_process').execFile;

  it('press=true composes pbcopy exec + Cmd+V key (F1 path)', async () => {
    const base = await startFakeChild();
    __setSimdeckInputBaseForTest(() => base);
    // make execFile succeed immediately
    const okExec = ((cmd: string, args: string[], _opts: unknown, cb: (e: null) => void) => {
      expect(cmd).toBe('xcrun');
      expect(args).toEqual(['simctl', 'pbcopy', 'UDID-7']);
      queueMicrotask(() => cb(null));
      return { stdin: { on: () => {}, end: () => {} } };
    }) as unknown as typeof import('node:child_process').execFile;
    await pasteTextSim('UDID-7', 'béta-漢字', okExec, true);
    expect(posts.map((p) => [p.path, p.body['type'], p.body['code'], p.body['modifiers']])).toEqual([
      ['/simulators/UDID-7/input', 'key', 'KeyV', ['command']],
    ]);
  });

  it('press=false stops after the pasteboard set (no key POST)', async () => {
    await startFakeChild().then((b) => { __setSimdeckInputBaseForTest(() => b); });
    const okExec = ((_cmd: string, _args: string[], _o: unknown, cb: (e: null) => void) => {
      queueMicrotask(() => cb(null));
      return { stdin: { on: () => {}, end: () => {} } };
    }) as unknown as typeof import('node:child_process').execFile;
    await pasteTextSim('UDID-7', 'x', okExec, false);
    expect(posts).toHaveLength(0);
  });

  it('pbcopy failure rejects with pbcopy failed', async () => {
    await startFakeChild().then((b) => { __setSimdeckInputBaseForTest(() => b); });
    const badExec = ((_cmd: string, _args: string[], _o: unknown, cb: (e: Error) => void) => {
      queueMicrotask(() => cb(new Error('exit 1')));
      return { stdin: { on: () => {}, end: () => {} } };
    }) as unknown as typeof import('node:child_process').execFile;
    await expect(pasteTextSim('UDID-7', 'x', badExec, true)).rejects.toThrow(/pbcopy failed/);
  });

  it('fakeExec helper kept honest (unused path sanity)', () => {
    expect(typeof fakeExec).toBe('function');
  });
});

describe('assertAckVerbose (F2 contract)', () => {
  it('ok:true passes; error text surfaces; bare ok:false stays INPUT_TIMEOUT', () => {
    expect(() => assertAckVerbose({ ok: true })).not.toThrow();
    expect(() => assertAckVerbose({ ok: false, error: 'device busy' })).toThrow(/INPUT_REFUSED: device busy/);
    expect(() => assertAckVerbose({ ok: false })).toThrow(/INPUT_TIMEOUT/);
  });
});
