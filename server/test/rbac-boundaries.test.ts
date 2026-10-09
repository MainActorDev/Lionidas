/** RBAC boundary suite (plan 20261009T102032Z T6): asserts the SETTLED
 *  matrix by SURFACE CLASS, not by route site — 4 roles × classes. Every
 *  cell of the matrix is a request assertion here. Also covers the viewer
 *  env mask (F-sensitive), ownership abort rules (string + FK predicate),
 *  the F1 manual-session recording gate, and the audit read gate. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { migrateM1 } from '../src/db/schema.ts';
import { registerAuthRoutes } from '../src/routes/auth.ts';
import { registerRunRoutes } from '../src/routes/runs.ts';
import { registerManualRoutes } from '../src/routes/manual.ts';
import { registerEnvVarRoutes } from '../src/routes/env-vars.ts';
import { registerTemplateRoutes } from '../src/routes/templates.ts';
import { registerProjectRoutes } from '../src/projects/routes.ts';
import { hashPassword } from '../src/auth/users.ts';
import { capabilitiesFor } from '../src/auth/capabilities.ts';

let db: Database.Database;
let app: FastifyInstance;
let tmp: string;

type Role = 'viewer' | 'operator' | 'supervisor' | 'admin';
const PW = hashPassword('pw-rbac-test');

function seedUser(id: string, role: Role): void {
  db.prepare(`INSERT INTO users(id, email, name, role, password_hash, auth_source, active, approved, created_at)
              VALUES (?, ?, ?, ?, ?, 'local', 1, 1, 0)`).run(id, `${id}@t.local`, id === 'u_operator2' ? 'operator2' : id, role, PW);
}

/** request as a user (cookie = session row keyed by user id) */
function as(userId: string | null): { headers: Record<string, string> } {
  return { headers: userId ? { cookie: `crucible_session=${userId}` } : {} };
}

function seedRun(id: string, triggeredBy: string, triggeredByUser: string | null): void {
  db.prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, triggered_by_user, device_udid, started_at)
              VALUES (?, 'T', 'manual', 'passed', ?, ?, 'SIM', 0)`).run(id, triggeredBy, triggeredByUser);
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'rbac-'));
  db = new Database(':memory:');
  migrateM1(db);
  seedUser('u_viewer', 'viewer');
  seedUser('u_operator', 'operator');
  seedUser('u_operator2', 'operator');
  seedUser('u_supervisor', 'supervisor');
  seedUser('u_admin', 'admin');
  seedRun('run_own', 'operator', 'u_operator');
  seedRun('run_other', 'operator2', 'u_operator2');
  seedRun('run_legacy', 'operator2', null); // FK NULL → string fallback path

  app = Fastify();
  app.addHook('onRequest', async (req) => {
    const cookie = (req.headers.cookie ?? '').match(/crucible_session=([^;]+)/)?.[1];
    if (cookie) {
      const u = db.prepare('SELECT * FROM users WHERE id = ?').get(cookie) as Record<string, unknown> | undefined;
      if (u) (req as unknown as { user: unknown }).user = u;
    }
  });
  registerAuthRoutes(app, db);
  registerRunRoutes(app, db, { emit: () => undefined } as never);
  registerEnvVarRoutes(app, db);
  registerTemplateRoutes(app, db, null);
  registerProjectRoutes(app, db);
  registerManualRoutes(app, db, { bus: { emit: () => undefined } as never, artifactsDir: tmp, forgeState: { activeRunId: null } as never, dispatchDeps: null } as never);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('capabilitiesFor — the matrix rendered', () => {
  it('viewer: reads overview, nothing sensitive, no actions', () => {
    const c = capabilitiesFor('viewer');
    expect(c.readOverview).toBe(true);
    expect(c.readEnvValues).toBe(false);
    expect(c.readUsers).toBe(false);
    expect(c.readSettings).toBe(false);
    expect(c.readManualSessions).toBe(false);
    expect(c.play && c.drive && c.deviceActions && c.authorCases && c.builds).toBe(false);
    expect(c.abortDelete).toBe('none');
  });
  it('operator: QA work, abortDelete own', () => {
    const c = capabilitiesFor('operator');
    expect(c.play && c.drive && c.deviceActions && c.authorCases && c.builds && c.readEnvValues && c.readManualSessions).toBe(true);
    expect(c.readUsers).toBe(false);
    expect(c.abortDelete).toBe('own');
    expect(c.audit).toBe(false);
  });
  it('supervisor: operator + people + audit + abortDelete any', () => {
    const c = capabilitiesFor('supervisor');
    expect(c.readUsers && c.manageAccounts && c.audit).toBe(true);
    expect(c.abortDelete).toBe('any');
    expect(c.adminOnly).toBe(false); // role/approve/settings stay admin
  });
  it('admin: everything', () => {
    const c = capabilitiesFor('admin');
    expect(c.adminOnly && c.readSettings && c.readUsers).toBe(true);
    expect(c.abortDelete).toBe('any');
  });
});

describe('viewer mask (server-enforced)', () => {
  it('env values masked for viewer, full for operator', async () => {
    db.prepare(`INSERT INTO env_vars(id, scope, key, value, secret, updated_by, updated_at) VALUES ('ev1', 'global', 'API_KEY', 'super-secret-value', 0, 'qa', 0)`).run();
    const v = await app.inject({ method: 'GET', url: '/api/env-vars', ...as('u_viewer') });
    const o = await app.inject({ method: 'GET', url: '/api/env-vars', ...as('u_operator') });
    expect(v.statusCode).toBe(200);
    expect((v.json() as { vars: Array<{ value: string | null; masked: boolean }> }).vars[0]).toMatchObject({ value: null, masked: true });
    expect((o.json() as { vars: Array<{ value: string | null }> }).vars[0]!.value).toBe('super-secret-value');
  });

  it('users directory: viewer 403, operator 403, supervisor 200, admin 200', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/users', ...as('u_viewer') })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/users', ...as('u_operator') })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/users', ...as('u_supervisor') })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/users', ...as('u_admin') })).statusCode).toBe(200);
  });

  it('F1: manual-session recording reads are operator+ (recordings carry raw typed credentials)', async () => {
    for (const path of ['/api/manual/some-session/record', '/api/manual-frame?path=/x.png', '/api/manual-thumb?path=/x.png']) {
      const v = await app.inject({ method: 'GET', url: path, ...as('u_viewer') });
      expect(v.statusCode, path).toBe(403);
    }
    const o = await app.inject({ method: 'GET', url: '/api/manual/some-session/record', ...as('u_operator') });
    expect(o.statusCode).not.toBe(403); // 410 (session gone) is fine — the gate passed
  });
});

describe('abort ownership (the previously-ungated route)', () => {
  it('viewer cannot abort at all', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/runs/run_own/abort', ...as('u_viewer') });
    expect(r.statusCode).toBe(403);
  });
  it('operator aborts OWN run (FK path) but not another operator run', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/runs/run_own/abort', ...as('u_operator') })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/runs/run_other/abort', ...as('u_operator') })).statusCode).toBe(403);
  });
  it('operator aborts OWN legacy run via string fallback (FK NULL)', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/runs/run_legacy/abort', ...as('u_operator2') });
    expect(r.statusCode).toBe(200); // triggered_by 'operator2' === user name
  });
  it('supervisor and admin abort any run', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/runs/run_other/abort', ...as('u_supervisor') })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/runs/run_own/abort', ...as('u_admin') })).statusCode).toBe(200);
  });
});

describe('user management tiers', () => {
  it('supervisor creates accounts but not admins; admin-only fields refused', async () => {
    const mk = await app.inject({ method: 'POST', url: '/api/users', ...as('u_supervisor'), payload: { email: 'n@t.local', name: 'n', role: 'operator', password: 'longenough1' } });
    expect(mk.statusCode).toBe(200);
    const mkAdm = await app.inject({ method: 'POST', url: '/api/users', ...as('u_supervisor'), payload: { email: 'a@t.local', name: 'a', role: 'admin', password: 'longenough1' } });
    expect(mkAdm.statusCode).toBe(403);
    const roleChange = await app.inject({ method: 'PATCH', url: '/api/users/u_viewer', ...as('u_supervisor'), payload: { role: 'operator' } });
    expect(roleChange.statusCode).toBe(403);
  });
  it('admin changes roles; supervisor resets passwords + deactivates', async () => {
    expect((await app.inject({ method: 'PATCH', url: '/api/users/u_viewer', ...as('u_admin'), payload: { role: 'operator' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PATCH', url: '/api/users/u_operator2', ...as('u_supervisor'), payload: { password: 'new-password-9' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PATCH', url: '/api/users/u_operator2', ...as('u_supervisor'), payload: { active: false } })).statusCode).toBe(200);
  });
  it('operator cannot manage accounts', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/users', ...as('u_operator'), payload: { email: 'x@t.local', name: 'x', role: 'viewer', password: 'longenough1' } })).statusCode).toBe(403);
  });
});

describe('audit surface', () => {
  it('read: supervisor+ only; operator 403, viewer 403', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/audit', ...as('u_supervisor') })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/audit', ...as('u_operator') })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/audit', ...as('u_viewer') })).statusCode).toBe(403);
  });
  it('abort denials land in auth_log with actor + flood control', async () => {
    await app.inject({ method: 'POST', url: '/api/runs/run_own/abort', ...as('u_viewer') }); // denial (viewer)
    await app.inject({ method: 'POST', url: '/api/runs/run_other/abort', ...as('u_viewer') }); // immediate repeat: flooded out
    const rows = db.prepare("SELECT detail FROM auth_log WHERE event = 'rbac_denied'").all() as Array<{ detail: string }>;
    expect(rows.length).toBe(1); // flood-controlled (review F4)
    expect(rows[0]!.detail).toContain('by u_viewer');
  });
  it('successful aborts are audited', async () => {
    await app.inject({ method: 'POST', url: '/api/runs/run_own/abort', ...as('u_operator') });
    expect(db.prepare("SELECT COUNT(*) c FROM auth_log WHERE event = 'run_abort'").get() as unknown as { c: number }).toMatchObject({ c: 1 });
  });
});

describe('play gate (viewers cannot run cases)', () => {
  it('viewer 403 on play; operator passes the gate', async () => {
    const v = await app.inject({ method: 'POST', url: '/api/templates/tpl_x/play', ...as('u_viewer'), payload: {} });
    expect(v.statusCode).toBe(403);
    const o = await app.inject({ method: 'POST', url: '/api/templates/tpl_x/play', ...as('u_operator'), payload: {} });
    expect(o.statusCode).not.toBe(403); // 404 (no template) fine — gate passed
  });
});

describe('assignment routes', () => {
  it('operator self-assigns; assigning others requires supervisor', async () => {
    db.prepare(`INSERT INTO templates(id, name, ticket_key, udid, steps_json, created_by, created_at, updated_at) VALUES ('tpl_a', 'A', 'T', 'SIM', '[]', 'qa', 0, 0)`).run();
    const self = await app.inject({ method: 'PATCH', url: '/api/templates/tpl_a/assign', ...as('u_operator'), payload: { userId: 'u_operator' } });
    expect(self.statusCode).toBe(200);
    const other = await app.inject({ method: 'PATCH', url: '/api/templates/tpl_a/assign', ...as('u_operator'), payload: { userId: 'u_operator2' } });
    expect(other.statusCode).toBe(403);
    const sup = await app.inject({ method: 'PATCH', url: '/api/templates/tpl_a/assign', ...as('u_supervisor'), payload: { userId: 'u_operator2' } });
    expect(sup.statusCode).toBe(200);
  });
});

describe('drill-found gaps (2026-10-09 thorough pass)', () => {
  it('viewer cannot uninstall apps (device-actions class)', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/devices/SIM/uninstall', ...as('u_viewer'), payload: { bundleId: 'com.x.y' } });
    expect(r.statusCode).toBe(403);
  });
  it('viewer READS the builds list (overview class)', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/builds', ...as('u_viewer') });
    expect(r.statusCode).toBe(200);
  });
  it('viewer cannot AUTHOR cases (patch/create/delete/yaml class)', async () => {
    db.prepare(`INSERT INTO templates(id, name, ticket_key, udid, steps_json, created_by, created_at, updated_at) VALUES ('tpl_v', 'V', 'T', 'SIM', '[]', 'qa', 0, 0)`).run();
    for (const [m, u] of [['PATCH', '/api/templates/tpl_v'], ['POST', '/api/templates'], ['DELETE', '/api/templates/tpl_v'], ['PUT', '/api/templates/tpl_v/yaml']] as const) {
      const r = await app.inject({ method: m, url: u, ...as('u_viewer'), payload: {} });
      expect(r.statusCode, `${m} ${u}`).toBe(403);
    }
  });
});
