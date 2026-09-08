import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { migrateM1 } from '../src/db/schema.ts';
import { registerMonitoringRoutes } from '../src/routes/monitoring.ts';
import { registerUserResolution } from '../src/auth/roles.ts';
import { hashPassword } from '../src/auth/users.ts';
import { deriveSummary, ingestPayload } from '../src/diagnostics/ingest.ts';

let db: Database.Database;
let tmp: string;
let app: FastifyInstance;
// Auth contract: ingest writes require an operator-tier identity. Tests seed a
// bot (guvnor) with a per-bot token and send x-crucible-agent on writes.
const AGENT = { 'x-crucible-agent': 'guvnor-test-token-1' };
const DIAG_JSON = JSON.stringify({
  crashDiagnostics: [{ signal: 'SIGSEGV', exceptionType: 'EXC_BAD_ACCESS' }],
  hangDiagnostics: [{}, {}],
  cpuExceptionDiagnostics: [],
  diskWriteExceptionDiagnostics: [{}],
  diagnosticMetaData: { deviceType: 'iPhone 14,2', osVersion: 'iOS 26.4 (23B)' },
});
const METRIC_JSON = JSON.stringify({
  metaData: { deviceType: 'iPhone 14,2', osVersion: 'iOS 26.4', applicationBuildVersion: '420' },
  applicationLaunchMetrics: { histogrammedTimeToFirstDraw: { histogramValue: {
    '0': { bucketStart: '1000 ms', bucketCount: 50 },
    '1': { bucketStart: '2000 ms', bucketCount: 60 },
  } } },
  memoryMetrics: { peakMemoryUsage: '214,000 kB' },
});

function build(): FastifyInstance {
  // mirror production: server-level 8MB body cap (route caps compose with it)
  const a = Fastify({ bodyLimit: 8 * 1024 * 1024 });
  registerUserResolution(a, db);
  registerMonitoringRoutes(a, db);
  return a;
}

function seedBot(): void {
  // per-bot token: name 'guvnor', secret 'test-token-1' → header value guvnor-test-token-1
  db.prepare(`INSERT OR REPLACE INTO users(id, email, name, role, auth_source, active, approved, password_hash, created_at)
              VALUES('usr_botguvn', 'guvnor@bot.local', 'guvnor', 'bot', 'bot', 1, 1, ?, strftime('%s','now')*1000)`)
    .run(hashPassword('test-token-1'));
}

describe('deriveSummary — plain-language feed derivation', () => {
  it('diagnostic counts', () => {
    const s = deriveSummary(DIAG_JSON, 'diagnostic');
    expect(s).toEqual({ crashes: 1, hangs: 2, cpuExceptions: 0, diskWriteExceptions: 1 });
  });
  it('metric headlines: weighted launch average + memory', () => {
    const s = deriveSummary(METRIC_JSON, 'metric');
    expect(s['launchAvgMs']).toBe(1545); // (1000*50 + 2000*60) / 110
    expect(s['peakMemory']).toBe('214,000 kB');
    expect(s['deviceModel']).toBe('iPhone 14,2');
  });
  it('malformed JSON → empty summary, never throws', () => {
    expect(deriveSummary('{oops', 'metric')).toEqual({});
  });
});

describe('ingest + feed routes', () => {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'crucible-mx-'));
    db = new Database(join(tmp, 't.db'));
    db.pragma('journal_mode = WAL');
    migrateM1(db);
    seedBot();
    app = build();
  });
  afterEach(async () => {
    await app.close();
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('POST happy: envelope lands with derived summary; GET feed returns it', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/diagnostics/payloads', headers: AGENT, payload: {
      appId: 'com.lionparcel.services.consumer', appVersion: '4.2.0', deviceId: 'dev-1',
      payloadKind: 'diagnostic', payloadJson: DIAG_JSON, capturedAt: 1788800000000, source: 'inject',
    } });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { ok: boolean; inserted: number; ids: string[] };
    expect(body.ok).toBe(true);
    expect(body.inserted).toBe(1);

    const feed = await app.inject({ method: 'GET', url: '/api/diagnostics/payloads', headers: AGENT });
    const fb = feed.json() as { payloads: Array<{ id: string; kind: string; summary: Record<string, number> }>; counts: Array<{ kind: string; n: number }> };
    expect(fb.payloads).toHaveLength(1);
    expect(fb.payloads[0]!.summary['crashes']).toBe(1);
    expect(fb.counts.find((c) => c.kind === 'diagnostic')!.n).toBe(1);
  });

  it('POST dedupe: same deviceId+capturedAt+kind → skipped, single row', async () => {
    const env = { appId: 'a.b.c', deviceId: 'dev-1', payloadKind: 'diagnostic' as const, payloadJson: DIAG_JSON, capturedAt: 1788800000000 };
    await app.inject({ method: 'POST', url: '/api/diagnostics/payloads', headers: AGENT, payload: env });
    const r2 = await app.inject({ method: 'POST', url: '/api/diagnostics/payloads', headers: AGENT, payload: env });
    expect((r2.json() as { dupes: number }).dupes).toBe(1);
    const n = (db.prepare('SELECT COUNT(*) c FROM mx_payloads').get() as { c: number }).c;
    expect(n).toBe(1);
  });

  it('POST malformed envelope → 422', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/diagnostics/payloads', headers: AGENT, payload: { appId: 'x' } });
    expect(r.statusCode).toBe(422);
  });

  it('POST empty body → 400; oversized payload → 422', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/diagnostics/payloads', headers: AGENT, payload: [] })).statusCode).toBe(400);
    // 9MB exceeds both caps: Fastify's server-level 8MB fires first (413) —
    // a direct ingestPayload() call proves the handler's own guard 422s at 8MB+.
    const big = await app.inject({ method: 'POST', url: '/api/diagnostics/payloads', headers: AGENT, payload: {
      appId: 'x', payloadKind: 'metric', payloadJson: 'x'.repeat(9_000_000),
    } });
    expect([413, 422]).toContain(big.statusCode);
    const direct = ingestPayload(db, { appId: 'x', payloadKind: 'metric', payloadJson: 'x'.repeat(8_000_001) });
    expect(direct.ok).toBe(false);
  });

  it('batch: multiple envelopes in one POST', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/diagnostics/payloads', headers: AGENT, payload: [
      { appId: 'x', payloadKind: 'metric', payloadJson: METRIC_JSON },
      { appId: 'x', payloadKind: 'diagnostic', payloadJson: DIAG_JSON },
    ] });
    expect((r.json() as { inserted: number }).inserted).toBe(2);
  });

  it('GET single payload includes raw JSON on demand', async () => {
    const post = await app.inject({ method: 'POST', url: '/api/diagnostics/payloads', headers: AGENT, payload: {
      appId: 'x', payloadKind: 'diagnostic', payloadJson: DIAG_JSON,
    } });
    const id = (post.json() as { ids: string[] }).ids[0]!;
    const one = await app.inject({ method: 'GET', url: `/api/diagnostics/payloads/${id}` });
    expect((one.json() as { payload_json: string }).payload_json).toContain('EXC_BAD_ACCESS');
  });

  it('direct ingestPayload: metric identity fields backfilled from payload metaData', () => {
    const r = ingestPayload(db, { appId: 'a.b', payloadKind: 'metric', payloadJson: METRIC_JSON });
    expect(r.ok).toBe(true);
    const row = db.prepare('SELECT device_model, app_version FROM mx_payloads WHERE id = ?').get(r.id!) as { device_model: string; app_version: string };
    expect(row.device_model).toBe('iPhone 14,2');
    expect(row.app_version).toBe('420');
  });

  it('auth: agent token configured → no token = 401, correct token passes', async () => {
    process.env['CRUCIBLE_AGENT_TOKEN'] = 'secret-agent';
    const guarded = build();
    const no = await guarded.inject({ method: 'POST', url: '/api/diagnostics/payloads', payload: { appId: 'x', payloadKind: 'metric', payloadJson: '{}' } });
    expect(no.statusCode).toBe(401);
    const yes = await guarded.inject({ method: 'POST', url: '/api/diagnostics/payloads',
      headers: { 'x-crucible-agent': 'secret-agent' },
      payload: { appId: 'x', payloadKind: 'metric', payloadJson: '{}' } });
    expect(yes.statusCode).toBe(200);
    delete process.env['CRUCIBLE_AGENT_TOKEN'];
    await guarded.close();
  });
});
