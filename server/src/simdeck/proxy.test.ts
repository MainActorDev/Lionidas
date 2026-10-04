/** simdeck gated-proxy tests — fake child (http server + ws echo) proving the
 *  three behaviors that matter: CSP strip + Origin rewrite, watch-mode frame
 *  dropping, drive-mode pass-through, session-finish demote, run-start detach. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import http from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { registerSimdeckProxy, __simdeckLegs, detachUdid } from './proxy.ts';

type Ev = { udid: string; kind: 'finished' | 'run-start' };

function fakeChild(): Promise<{ server: http.Server; port: number; received: Array<{ data: string; isBinary: boolean }>; wss: WebSocketServer }> {
  const received: Array<{ data: string; isBinary: boolean }> = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/simulators.json') {
      res.writeHead(200, { 'content-type': 'application/json', 'content-security-policy': "frame-ancestors 'none'" });
      res.end('{}');
      return;
    }
    if (req.url === '/page') {
      const origin = req.headers['origin'] ?? '';
      if (!origin.includes('127.0.0.1')) { res.writeHead(403); res.end('bad origin'); return; }
      res.writeHead(200, { 'content-security-policy': "frame-ancestors 'none'", 'x-keep': 'yes' });
      res.end('<html></html>');
      return;
    }
    res.writeHead(404); res.end();
  });
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws) => {
    ws.on('message', (data, isBinary) => {
      received.push({ data: data.toString(), isBinary });
      ws.send(JSON.stringify({ echoed: data.toString() })); // child→client both directions testable
    });
    ws.send(Buffer.from([0x01, 0x02])); // binary hello (upstream→client)
  });
  server.on('upgrade', (req, sock, head) => {
    const origin = req.headers['origin'] ?? '';
    if (!origin.includes('127.0.0.1')) { sock.destroy(); return; }
    wss.handleUpgrade(req, sock, head, (ws) => wss.emit('connection', ws));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as { port: number }).port, received, wss });
    });
  });
}

function clientWs(app: Fastify.FastifyInstance, path: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${(app.server.address() as { port: number }).port}${path}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

describe('simdeck gated proxy', () => {
  let child: Awaited<ReturnType<typeof fakeChild>>;
  let app: Fastify.FastifyInstance;
  let events: Ev[] = [];
  let driving = new Set<string>();

  beforeEach(async () => {
    child = await fakeChild();
    events = [];
    driving = new Set();
    app = Fastify();
    await app.register(websocket);
    await app.register((async (inst: import('fastify').FastifyInstance) => {
      registerSimdeckProxy(inst, {
        base: () => `http://127.0.0.1:${child.port}`,
        isDriving: (udid) => driving.has(udid),
        onSessionEvent: (cb) => {
          const timer = setInterval(() => { for (const e of events.splice(0)) cb(e); }, 10);
          return () => clearInterval(timer);
        },
      });
    }) as never);
    await app.listen({ port: 0, host: '127.0.0.1' });
  });

  afterEach(async () => {
    await app.close();
    child.wss.clients.forEach((c) => c.close());
    child.server.close();
    child.received.length = 0;
    // clear legs registry between tests
    for (const l of __simdeckLegs()) { detachUdid(l.udid); }
  });

  it('HTTP leg strips CSP, keeps other headers, rewrites origin', async () => {
    const r = await app.inject({ method: 'GET', url: '/simdeck/page', headers: { origin: 'http://wall.example:5230' } });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-security-policy']).toBeUndefined();
    expect(r.headers['x-keep']).toBe('yes');
  });

  it('watch mode: client text frames dropped, upstream binary passes to client', async () => {
    const ws = await clientWs(app, '/simdeck/simulators/UDID-A/stream?format=avcc');
    const got: Array<{ data: unknown; isBinary: boolean }> = [];
    ws.on('message', (data, isBinary) => got.push({ data: data.toString(), isBinary }));
    await new Promise((r) => setTimeout(r, 150));
    ws.send(JSON.stringify({ type: 'tap', x: 1, y: 2 })); // gesture — must be DROPPED
    await new Promise((r) => setTimeout(r, 200));
    expect(child.received.length).toBe(0); // nothing reached the child
    expect(got.some((g) => g.isBinary)).toBe(true); // upstream binary hello arrived
    ws.close();
  });

  it('drive mode: both directions flow', async () => {
    driving.add('UDID-B');
    const ws = await clientWs(app, '/simdeck/simulators/UDID-B/stream?format=avcc');
    const got: string[] = [];
    ws.on('message', (data) => got.push(data.toString()));
    await new Promise((r) => setTimeout(r, 150));
    ws.send(JSON.stringify({ type: 'tap', x: 3, y: 4 }));
    await new Promise((r) => setTimeout(r, 250));
    expect(child.received.some((r2) => r2.data.includes('"tap"'))).toBe(true); // gesture reached child
    expect(got.some((g) => g.includes('echoed'))).toBe(true); // child echo came back
    ws.close();
  });

  it('session finish demotes a live drive leg to watch', async () => {
    driving.add('UDID-C');
    const ws = await clientWs(app, '/simdeck/simulators/UDID-C/stream?format=avcc');
    await new Promise((r) => setTimeout(r, 150));
    ws.send(JSON.stringify({ type: 'tap', x: 5, y: 6 }));
    await new Promise((r) => setTimeout(r, 200));
    expect(child.received.length).toBeGreaterThan(0);
    child.received.length = 0;
    driving.delete('UDID-C');
    events.push({ udid: 'UDID-C', kind: 'finished' });
    await new Promise((r) => setTimeout(r, 120)); // event pump
    ws.send(JSON.stringify({ type: 'tap', x: 7, y: 8 }));
    await new Promise((r) => setTimeout(r, 200));
    expect(child.received.length).toBe(0); // demoted — gestures dropped, video alive
    expect(__simdeckLegs().find((l) => l.udid === 'UDID-C')?.mode).toBe('watch');
    ws.close();
  });

  it('paintStillToLegs pushes a JPEG-seed frame to live legs only', async () => {
    const { paintStillToLegs } = await import('./proxy.ts');
    driving.add('UDID-S');
    const ws = await clientWs(app, '/simdeck/simulators/UDID-S/stream?format=avcc');
    const got: Array<{ data: string; isBinary: boolean }> = [];
    ws.on('message', (data, isBinary) => got.push({ data: data.toString('latin1'), isBinary }));
    await new Promise((r) => setTimeout(r, 150));
    const n = paintStillToLegs('UDID-S', Buffer.from([0xff, 0xd8, 0xff, 0xd9])); // SOI+EOI jpeg stub
    await new Promise((r) => setTimeout(r, 150));
    expect(n).toBe(1);
    const seed = got.find((g) => g.isBinary && g.data.charCodeAt(0) === 0x04);
    expect(seed).toBeDefined(); // tag 0x04 + jpeg
    const other = paintStillToLegs('UDID-NONE', Buffer.from('x'));
    expect(other).toBe(0);
    ws.close();
  });

  it('run-start detaches (closes) all legs for the udid', async () => {
    driving.add('UDID-D');
    const ws = await clientWs(app, '/simdeck/simulators/UDID-D/stream?format=avcc');
    await new Promise((r) => setTimeout(r, 150));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    events.push({ udid: 'UDID-D', kind: 'run-start' });
    await new Promise((r) => setTimeout(r, 150));
    expect(ws.readyState).not.toBe(WebSocket.OPEN); // closed by the proxy
    expect(__simdeckLegs().find((l) => l.udid === 'UDID-D')).toBeUndefined();
  });

  it('viewer rules: watch legs coexist; a drive leg evicts existing drive legs', async () => {
    // two WATCH viewers of the same udid: both live (multi-viewer watching;
    // input gating is per-leg). Previously last-viewer-wins made any two
    // viewers evict each other in an endless loop.
    const w1 = await clientWs(app, '/simdeck/simulators/AAA/stream?format=avcc&version=v2');
    const w2 = await clientWs(app, '/simdeck/simulators/AAA/stream?format=avcc&version=v2');
    await new Promise((r) => setTimeout(r, 150));
    expect(__simdeckLegs().filter((l) => l.udid === 'AAA')).toHaveLength(2);
    expect(w1.readyState).toBe(WebSocket.OPEN);
    expect(w2.readyState).toBe(WebSocket.OPEN);
    w1.close(); w2.close();

    // DRIVE supersede: a manual session flips the next leg to drive —
    // arriving drive evicts an existing DRIVE leg (one driver per udid)
    driving.add('AAA');
    const d1 = await clientWs(app, '/simdeck/simulators/AAA/stream?format=avcc&version=v2');
    await new Promise((r) => setTimeout(r, 100));
    expect(__simdeckLegs().filter((l) => l.udid === 'AAA' && l.mode === 'drive')).toHaveLength(1);
    const d2 = await clientWs(app, '/simdeck/simulators/AAA/stream?format=avcc&version=v2');
    await new Promise((r) => setTimeout(r, 150));
    const driveLegs = __simdeckLegs().filter((l) => l.udid === 'AAA' && l.mode === 'drive');
    expect(driveLegs).toHaveLength(1); // replaced, not duplicated
    expect(d1.readyState).not.toBe(WebSocket.OPEN); // first driver evicted
    driving.delete('AAA');
    d2.close();
  });
});
