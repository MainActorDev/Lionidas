/** simdeck input channel tests — dialect translation + ack/timeout contract
 *  against a fake child serving POST /simulators/:udid/input. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

type Mod = typeof import('./engine-input.ts');
async function loadMod(): Promise<Mod> { vi.resetModules(); return import('./engine-input.ts'); }

describe('simdeck input', () => {
  let mod: Mod;
  afterEach(() => {
    mod?.__setSimdeckInputBaseForTest(null);
  });

  it('translates kind→type and adds width/height on tap/swipe', async () => {
    mod = await loadMod();
    const out = mod.toSimdeckGesture({ kind: 'tap', x: 10, y: 20 }, 402, 874);
    expect(out['type']).toBe('tap');
    expect(out['kind']).toBeUndefined();
    expect(out['width']).toBe(402);
    expect(out['height']).toBe(874);
    expect(out['x']).toBe(10);

    const swipe = mod.toSimdeckGesture({ kind: 'swipe', startX: 1, startY: 2, endX: 3, endY: 4 }, 402, 874);
    expect(swipe['type']).toBe('swipe');
    expect(swipe['width']).toBe(402);

    // non-positional kinds: no dims injected
    const key = mod.toSimdeckGesture({ kind: 'key', code: 'KeyH' }, 402, 874);
    expect(key['width']).toBeUndefined();
    expect(key['type']).toBe('key');

    // zero dims (unknown session dims): no dims keys at all
    const bare = mod.toSimdeckGesture({ kind: 'tap', x: 1, y: 2 }, 0, 0);
    expect(bare['width']).toBeUndefined();
  });

  it('posts to the child route and resolves on ok', async () => {
    mod = await loadMod();
    const bodies: string[] = [];
    const server = http.createServer((req, res) => {
      let b = '';
      req.on('data', (d) => { b += d; });
      req.on('end', () => {
        bodies.push(`${req.method} ${req.url} ${b}`);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    mod.__setSimdeckInputBaseForTest(() => `http://127.0.0.1:${port}`);

    await mod.engineInput('UDID-X', { kind: 'tap', x: 5, y: 6 }, { logicalW: 402, logicalH: 874 });
    expect(bodies[0]).toContain('POST /simulators/UDID-X/input');
    expect(bodies[0]).toContain('"type":"tap"');
    expect(bodies[0]).toContain('"width":402');

    // keep this server alive+unref'd: closing it mid-agent poisons the global
    // fetch pool and hangs the NEXT fetch on some node versions (found live)
    server.unref();
  });

  it('maps press→button (child wire type)', async () => {
    mod = await loadMod();
    const out = mod.toSimdeckGesture({ kind: 'press', button: 'home', duration: 0 }, 0, 0);
    expect(out['type']).toBe('button');
    expect(out['button']).toBe('home');
    expect(out['kind']).toBeUndefined();
  });

  it('adds width/height to ALL positional kinds', async () => {
    mod = await loadMod();
    const cases = [
      { kind: 'touch1', phase: 'down', x: 1, y: 2 },
      { kind: 'touch2', phase: 'down', x1: 1, y1: 2, x2: 3, y2: 4 },
      { kind: 'swipe', startX: 1, startY: 2, endX: 3, endY: 4 },
      { kind: 'pan', x1: 1, y1: 2, x2: 3, y2: 4, dx: 5, dy: 6 },
    ];
    for (const g of cases) {
      const out = mod.toSimdeckGesture(g, 402, 874);
      expect(out['width']).toBe(402);
      expect(out['height']).toBe(874);
    }
  });

  it('non-positional kinds get no dims (scroll/key/button/type)', async () => {
    mod = await loadMod();
    for (const g of [
      { kind: 'scroll', deltaX: 0, deltaY: 5 },
      { kind: 'key', code: 'KeyH', modifiers: ['shift'] },
      { kind: 'type', text: 'hi' },
    ]) {
      const out = mod.toSimdeckGesture(g, 402, 874);
      expect(out['width']).toBeUndefined();
    }
  });

  it('interpretation: ok:false ack = INPUT_TIMEOUT (pure)', async () => {
    mod = await loadMod();
    expect(() => mod.assertAck({ ok: false })).toThrow('INPUT_TIMEOUT');
    expect(() => mod.assertAck({})).toThrow('INPUT_TIMEOUT');
    expect(() => mod.assertAck({ ok: true })).not.toThrow();
  });

  it('throws on connect failure (caller falls back to alloy)', async () => {
    mod = await loadMod();
    mod.__setSimdeckInputBaseForTest(() => 'http://127.0.0.1:1'); // nothing listens
    await expect(mod.engineInput('UDID-Z', { kind: 'tap', x: 1, y: 2 })).rejects.toThrow();
  });
});
