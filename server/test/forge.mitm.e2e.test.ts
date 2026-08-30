/** Forge MITM e2e (live): preset hit, miss passthrough, seq, malformed — against a real mitmdump.
 *  Trust note: tests hit the proxy over HTTP (no TLS to the PROXY itself for the
 *  local-upstream case) and use NODE_TLS_REJECT_UNAUTHORIZED=0 for the https case —
 *  equivalent of curl -k; the device-trust step is the human .command. */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import http from 'node:http';
import { migrateM1 } from '../src/db/schema.ts';
import { createEventBus, type AppEvents } from '../src/ws/bus.ts';
import { writeStateFile, startMitm } from '../src/forge/mitm/manager.ts';
import type { Preset } from '../src/forge/matcher.ts';

const stateDir = mkdtempSync(join(tmpdir(), 'mitm-e2e-'));
const db = new Database(':memory:');
migrateM1(db);
const bus = createEventBus<AppEvents>();

// local HTTPS-less upstream (hybrid miss target)
let upstream: http.Server;
let upstreamPort = 0;

beforeAll(async () => {
  upstream = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('real-upstream'); });
  await new Promise<void>((r) => { upstream.listen(0, '127.0.0.1', () => r()); });
  upstreamPort = (upstream.address() as { port: number }).port;
  process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
});

afterAll(async () => {
  await new Promise<void>((r) => upstream.close(() => r()));
  delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
  rmSync(stateDir, { recursive: true, force: true });
});

const P = (over: Partial<Preset> & { id: string }): Preset => ({
  method: 'GET', pathPattern: '/api/x', match: 'exact', status: 200, ...over,
});

describe('forge mitm e2e (real mitmdump)', () => {
  it('preset hit / miss passthrough / seq / malformed / traffic rows', async () => {
    // preset on /api/x (intercept); miss on /real → hybrid passthrough to local upstream
    writeStateFile(stateDir, 'hybrid', [
      P({ id: 'p1', pathPattern: '/api/x', status: 201 }),
      P({ id: 'pseq', pathPattern: '/api/seq', status: 200, seq: [{ status: 200 }, { status: 500 }] }),
      P({ id: 'pmal', pathPattern: '/api/mal', status: 200, failure: 'malformed' }),
    ]);
    const handle = await startMitm({ db, bus, stateDir });
    expect(handle.port).toBeGreaterThan(0);

    // preset hit (proxy absolute-URI request)
    const hit = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: handle.port, method: 'GET', path: 'http://forge.test/api/x' },
        (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode ?? 0 })); },
      );
      req.on('error', reject);
      req.end();
    });
    expect(hit.status).toBe(201);

    // miss → passthrough to local upstream (proper proxy request: absolute URI)
    const miss = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: handle.port, method: 'GET', path: `http://127.0.0.1:${upstreamPort}/real`, headers: { host: `127.0.0.1:${upstreamPort}` } },
        (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b })); },
      );
      req.on('error', reject);
      req.end();
    });
    expect(miss.status).toBe(200);
    expect(miss.body).toBe('real-upstream');

    // seq 200 → 500 (last repeats)
    const seqReq = (): Promise<number> => new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: handle.port, method: 'GET', path: 'http://forge.test/api/seq' },
        (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); },
      );
      req.on('error', reject);
      req.end();
    });
    const [q1, q2] = await Promise.all([seqReq(), seqReq().then((s) => new Promise<number>((r) => setTimeout(() => r(s), 100)))]);
    expect([q1, q2]).toEqual([200, 500]);

    // malformed body
    const mal = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: handle.port, method: 'GET', path: 'http://forge.test/api/mal' },
        (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b })); },
      );
      req.on('error', reject);
      req.end();
    });
    expect(mal.body).toBe('{not-json');

    // traffic rows ingested (tail runs 1/s — wait)
    await new Promise((r) => setTimeout(r, 1800));
    const rows = db.prepare(`SELECT path, status, matched_preset_id FROM traffic WHERE mode LIKE 'mitm%' ORDER BY ts`).all() as Array<{ path: string; status: number; matched_preset_id: string | null }>;
    const paths = rows.map((r) => r.path);
    expect(paths).toContain('/api/x');
    expect(paths).toContain('/real');
    expect(paths).toContain('/api/seq');
    expect(paths).toContain('/api/mal');
    const seqRow = rows.filter((r) => r.path === '/api/seq');
    expect(seqRow.map((r) => r.status)).toEqual([200, 500]);

    await handle.stop();
  }, 30000);
});
