/** Evidence-overlay precision (plan 20261009T000000Z T2): anchor fallback
 *  chain, offset persistence (per-run + per-device), PATCH auth/clamp, and
 *  the run-taps response shape the player consumes. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { migrateM1 } from '../src/db/schema.ts';
import { registerRunRoutes } from '../src/routes/runs.ts';
import { registerTemplateRoutes } from '../src/routes/templates.ts';

let tmp: string;
let db: Database.Database;
let app: FastifyInstance;

function build(role = 'admin'): FastifyInstance {
  const a = Fastify();
  a.addHook('onRequest', async (req: import('fastify').FastifyRequest) => { (req as unknown as { user: unknown }).user = { name: 't', role, id: 'usr_t', email: 't@x.co' }; });
  registerRunRoutes(a, db, { emit: () => undefined } as never);
  return a;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'overlay-prec-'));
  db = new Database(join(tmp, 't.db'));
  db.pragma('journal_mode = WAL');
  migrateM1(db);
});
afterEach(async () => {
  await app?.close();
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

function seedRun(id: string, tpl: string | null, opts: { anchor?: number | null; started?: number | null; offset?: number | null; udid?: string | null } = {}): void {
  db.prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, template_id, started_at, finished_at, video_started_at, video_anchor_ms, overlay_offset_ms)
              VALUES (?, 'T', 'manual', 'passed', 'qa', ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, opts.udid === undefined ? 'UDID-X' : opts.udid, tpl, Date.now(), Date.now(), opts.started ?? null, opts.anchor ?? null, opts.offset === undefined ? null : opts.offset);
}

describe('PATCH /api/runs/:id/overlay-offset', () => {
  it('admin sets the run offset and seeds the device default', async () => {
    seedRun('run_a', null, { udid: 'UDID-1' });
    app = build('admin');
    const r = await app.inject({ method: 'PATCH', url: '/api/runs/run_a/overlay-offset', payload: { offsetMs: 250 } });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { offsetMs: number }).offsetMs).toBe(250);
    expect(db.prepare('SELECT overlay_offset_ms AS o FROM runs WHERE id = ?').get('run_a')).toMatchObject({ o: 250 });
    expect(db.prepare('SELECT offset_ms FROM device_overlay_defaults WHERE udid = ?').get('UDID-1')).toMatchObject({ offset_ms: 250 });
  });

  it('viewer → 403; bad body → 422; missing run → 404; clamps to ±10s', async () => {
    seedRun('run_b', null, { udid: 'UDID-2' });
    app = build('viewer');
    expect((await app.inject({ method: 'PATCH', url: '/api/runs/run_b/overlay-offset', payload: { offsetMs: 100 } })).statusCode).toBe(403);
    await app.close();
    app = build('admin');
    expect((await app.inject({ method: 'PATCH', url: '/api/runs/run_b/overlay-offset', payload: {} })).statusCode).toBe(422);
    expect((await app.inject({ method: 'PATCH', url: '/api/runs/nope/overlay-offset', payload: { offsetMs: 1 } })).statusCode).toBe(404);
    const clamped = await app.inject({ method: 'PATCH', url: '/api/runs/run_b/overlay-offset', payload: { offsetMs: 99_999 } });
    expect((clamped.json() as { offsetMs: number }).offsetMs).toBe(10_000);
  });

  it('negative offsets round-trip; device default refreshed on re-PATCH', async () => {
    seedRun('run_c', null, { udid: 'UDID-3' });
    app = build('admin');
    const r = await app.inject({ method: 'PATCH', url: '/api/runs/run_c/overlay-offset', payload: { offsetMs: -150 } });
    expect(r.statusCode).toBe(200);
    expect((r.json() as { offsetMs: number }).offsetMs).toBe(-150);
    expect(db.prepare('SELECT offset_ms FROM device_overlay_defaults WHERE udid = ?').get('UDID-3')).toMatchObject({ offset_ms: -150 });
    const r2 = await app.inject({ method: 'PATCH', url: '/api/runs/run_c/overlay-offset', payload: { offsetMs: 0 } });
    expect((r2.json() as { offsetMs: number }).offsetMs).toBe(0);
    expect(db.prepare('SELECT offset_ms FROM device_overlay_defaults WHERE udid = ?').get('UDID-3')).toMatchObject({ offset_ms: 0 });
  });
});

describe('GET /api/templates/:id/run-taps (anchor + offset resolution)', () => {
  it('engine anchor wins over legacy stamp; device default applies when run offset unset', async () => {
    // template + two runs
    db.prepare(`INSERT INTO templates(id, name, udid, steps_json, setup_json, created_at, updated_at, created_by) VALUES ('tpl_x', 'x', 'UDID-X', '[]', NULL, 0, 0, 't')`).run();
    seedRun('run_new', 'tpl_x', { anchor: 1_000_000, started: 999_000, offset: null, udid: 'UDID-D' });
    db.prepare('INSERT INTO device_overlay_defaults(udid, offset_ms, updated_at) VALUES (?, ?, ?)').run('UDID-D', 120, 1);
    app = build('admin');
    registerTemplateRoutes(app, db);
    const r = await app.inject({ method: 'GET', url: '/api/templates/tpl_x/run-taps' });
    expect(r.statusCode).toBe(200);
    const b = r.json() as { anchor: number; videoStartedAt: number; offsetMs: number; offsetSource: string };
    expect(b.anchor).toBe(1_000_000);          // engine anchor (not legacy)
    expect(b.videoStartedAt).toBe(1_000_000);  // back-compat field mirrors anchor
    expect(b.offsetMs).toBe(120);              // device default
    expect(b.offsetSource).toBe('device');
  });

  it('per-run offset wins over device default; legacy anchor used when engine field absent', async () => {
    db.prepare(`INSERT INTO templates(id, name, udid, steps_json, setup_json, created_at, updated_at, created_by) VALUES ('tpl_y', 'y', 'UDID-X', '[]', NULL, 0, 0, 't')`).run();
    seedRun('run_z', 'tpl_y', { anchor: null, started: 555_000, offset: 300, udid: 'UDID-E' });
    db.prepare('INSERT INTO device_overlay_defaults(udid, offset_ms, updated_at) VALUES (?, ?, ?)').run('UDID-E', 999, 1);
    app = build('admin');
    registerTemplateRoutes(app, db);
    const r = await app.inject({ method: 'GET', url: '/api/templates/tpl_y/run-taps' });
    const b = r.json() as { anchor: number; offsetMs: number; offsetSource: string };
    expect(b.anchor).toBe(555_000);            // legacy fallback
    expect(b.offsetMs).toBe(300);              // per-run wins
    expect(b.offsetSource).toBe('run');
  });
});
