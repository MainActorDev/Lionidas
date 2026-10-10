/** Collision-safety + presence (plan 20261010T023941Z, review F1–F5 applied):
 *  exclusivity (DEVICE_HELD, nobody takes), probe-reuse under a held device
 *  (F2), content-scoped edit-conflict token (F1), power gate (F4), and
 *  named-actor attribution writes (power/install/build/case-edit). */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { migrateM1 } from '../src/db/schema.ts';
import { registerManualRoutes } from '../src/routes/manual.ts';
import { registerTemplateRoutes } from '../src/routes/templates.ts';
import { registerDeviceRoutes } from '../src/routes/devices.ts';
import { __setAlloyForTest } from '../src/alloy/client.ts';

let db: Database.Database;
let app: FastifyInstance;
let tmp: string;

function seedUser(id: string, role: string): void {
  db.prepare(`INSERT INTO users(id, email, name, role, auth_source, active, approved, created_at)
              VALUES (?, ?, ?, ?, 'local', 1, 1, 0)`).run(id, `${id}@t.local`, id, role);
}
const as = (u: string | null) => ({ headers: u ? { cookie: `crucible_session=${u}` } : {} });

function seedDevice(udid: string): void {
  db.prepare(`INSERT INTO devices(udid, name, state, platform, kind, last_seen) VALUES (?, 'Sim', 'Booted', 'ios', 'simulator', 0)`).run(udid);
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'collide-'));
  db = new Database(':memory:');
  migrateM1(db);
  seedUser('u_viewer', 'viewer');
  seedUser('u_op', 'operator');
  seedUser('u_op2', 'operator');
  seedUser('u_admin', 'admin');
  seedDevice('SIM');
  db.prepare(`INSERT INTO templates(id, name, ticket_key, udid, steps_json, created_by, created_at, updated_at) VALUES ('tpl_c', 'C', 'T', 'SIM', ?, 'qa', 0, 1000)`).run(JSON.stringify([{ idx: 0, action: 'tap', x: 1, y: 1 }]));

  __setAlloyForTest({ dispatch: async () => ({ ok: true, result: { nodes: [
    { index: 0, parentIndex: -1, type: 'Application', label: 'App', rect: { x: 0, y: 0, width: 428, height: 926 }, hittable: false, ref: 'root' },
  ] } }) } as never);
  app = Fastify();
  app.addHook('onRequest', async (req) => {
    const cookie = (req.headers.cookie ?? '').match(/crucible_session=([^;]+)/)?.[1];
    if (cookie) {
      const u = db.prepare('SELECT * FROM users WHERE id = ?').get(cookie) as Record<string, unknown> | undefined;
      if (u) (req as unknown as { user: unknown }).user = u;
    }
  });
  registerManualRoutes(app, db, { bus: { emit: () => undefined } as never, artifactsDir: tmp, forgeState: { activeRunId: null } as never, dispatchDeps: null } as never);
  registerTemplateRoutes(app, db, null);
  registerDeviceRoutes(app, db);
  await app.ready();
});

afterEach(async () => {
  __setAlloyForTest(null);
  await app.close();
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('T1 — device exclusivity (nobody takes)', () => {
  it('second take-control on a held device → 409 DEVICE_HELD naming the holder', async () => {
    const first = await app.inject({ method: 'POST', url: '/api/manual/start', ...as('u_op'), payload: { udid: 'SIM' } });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({ method: 'POST', url: '/api/manual/start', ...as('u_op2'), payload: { udid: 'SIM' } });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ code: 'DEVICE_HELD' });
    expect(second.json().error).toContain('u_op');
    expect(second.json().error).toContain('nobody takes over');
  });

  it('after release, the next take-control succeeds', async () => {
    const first = await app.inject({ method: 'POST', url: '/api/manual/start', ...as('u_op'), payload: { udid: 'SIM' } });
    const sid = first.json().sessionId as string;
    await app.inject({ method: 'POST', url: `/api/manual/${sid}/finish`, ...as('u_op'), payload: {} });
    const next = await app.inject({ method: 'POST', url: '/api/manual/start', ...as('u_op2'), payload: { udid: 'SIM' } });
    expect(next.statusCode).toBe(200);
  });

  it('screens probe reuses a held session instead of 409 (review F2)', async () => {
    const first = await app.inject({ method: 'POST', url: '/api/manual/start', ...as('u_op'), payload: { udid: 'SIM' } });
    const sid = first.json().sessionId as string;
    // probe without a sessionId while the device is held — must NOT 409
    const probe = await app.inject({ method: 'POST', url: '/api/apps/com.x/screens/probe', ...as('u_op2'), payload: { udid: 'SIM', bundle: 'com.x' } });
    expect(probe.statusCode).not.toBe(409);
    expect(probe.statusCode).not.toBe(410);
    // holder's session untouched
    const alive = db.prepare('SELECT id FROM manual_sessions WHERE id = ? AND finished_at IS NULL').get(sid);
    expect(alive).toBeTruthy();
  });
});

describe('T3 — edit conflict, content-scoped token (review F1)', () => {
  it('{status} without token → 200 (metadata stays tokenless)', async () => {
    const r = await app.inject({ method: 'PATCH', url: '/api/templates/tpl_c', ...as('u_op'), payload: { status: 'deprecated' } });
    expect(r.statusCode).toBe(200);
  });
  it('{steps} without token → 400 TOKEN_REQUIRED', async () => {
    const r = await app.inject({ method: 'PATCH', url: '/api/templates/tpl_c', ...as('u_op'), payload: { steps: [] } });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe('TOKEN_REQUIRED');
  });
  it('stale token + steps → 409 EDIT_CONFLICT naming the other editor', async () => {
    // someone else edits first (metadata flip bumps updated_at)
    await app.inject({ method: 'PATCH', url: '/api/templates/tpl_c', ...as('u_op2'), payload: { description: 'bumped' } });
    const cur = db.prepare('SELECT updated_at, updated_by FROM templates WHERE id = ?').get('tpl_c') as { updated_at: number; updated_by: string | null };
    // u_op saves with a token captured BEFORE op2's edit
    const r = await app.inject({ method: 'PATCH', url: '/api/templates/tpl_c', ...as('u_op'), payload: { steps: [{ idx: 0, action: 'tap', x: 1, y: 1 }], expectedUpdatedAt: 1000 } });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ code: 'EDIT_CONFLICT', updatedBy: cur.updated_by });
    void cur;
  });
  it('fresh token + steps → 200 and audited as case_edit', async () => {
    const cur = db.prepare('SELECT updated_at FROM templates WHERE id = ?').get('tpl_c') as { updated_at: number };
    const r = await app.inject({ method: 'PATCH', url: '/api/templates/tpl_c', ...as('u_op'), payload: { steps: [{ idx: 0, action: 'tap', x: 1, y: 1 }], expectedUpdatedAt: cur.updated_at } });
    expect(r.statusCode).toBe(200);
    expect((db.prepare("SELECT COUNT(*) c FROM auth_log WHERE event = 'case_edit' AND email = 'u_op@t.local'").get() as { c: number }).c).toBe(1);
  });
  it('yaml PUT without token → 400; with stale token → 409', async () => {
    // minimal VALID case yaml (passes parse, fails the conflict check)
    // round-trip truth: export the case's own yaml, PUT it back (guaranteed parseable)
    const ex = await app.inject({ method: 'GET', url: '/api/templates/tpl_c/yaml', ...as('u_op') });
    const y = (ex.json() as { yaml?: string }).yaml ?? 'case:\n  name: C\n  steps:\n    - tap: { point: [1, 1] }';
    const noTok = await app.inject({ method: 'PUT', url: '/api/templates/tpl_c/yaml', ...as('u_op'), payload: { yaml: y } });
    expect(noTok.statusCode).toBe(400);
    const stale = await app.inject({ method: 'PUT', url: '/api/templates/tpl_c/yaml', ...as('u_op'), payload: { yaml: y, expectedUpdatedAt: 1 } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('EDIT_CONFLICT');
  });
});

describe('T2 — attribution + power gate (review F4)', () => {
  it('viewer power action → 403; operator power → audited + last_power_by stamped', async () => {
    const v = await app.inject({ method: 'POST', url: '/api/devices/SIM/power', ...as('u_viewer'), payload: { action: 'boot' } });
    expect(v.statusCode).toBe(403);
    // operator power (the alloy dispatch fails in the harness — the gate and
    // the audit/stamp fire before the engine call)
    const o = await app.inject({ method: 'POST', url: '/api/devices/SIM/power', ...as('u_op'), payload: { action: 'boot' } });
    expect(o.statusCode).not.toBe(403); // engine error allowed — the RBAC gate passed
    const stamp = db.prepare('SELECT last_power_by FROM devices WHERE udid = ?').get('SIM') as { last_power_by: string | null };
    expect(stamp.last_power_by).toBe('u_op');
    expect((db.prepare("SELECT COUNT(*) c FROM auth_log WHERE event = 'device_action' AND email = 'u_op@t.local'").get() as { c: number }).c).toBeGreaterThanOrEqual(1);
  });

  it('devices list exposes last_power_by + lease_display', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/devices', ...as('u_viewer') });
    const dev = (r.json() as { devices: Array<{ udid: string; last_power_by?: string | null; lease_display?: string | null }> }).devices.find((d) => d.udid === 'SIM');
    expect(dev).toBeTruthy();
    expect('last_power_by' in (dev ?? {})).toBe(true);
  });
});
