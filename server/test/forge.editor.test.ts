import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerForgeRoutes } from '../src/forge/routes.ts';
import { migrateM1 } from '../src/db/schema.ts';

/** M3: preset editor routes (GET/PATCH :id, PUT body) + scenario management
 *  (PATCH rename, DELETE, GET :id, PUT members). Key invariants:
 *  - PATCH keeps the SAME id (memberships / matched_preset_id stay valid)
 *  - body writes are atomic (tmp+rename) into the B6 dir, content-type merges
 *  - scenario rename collides 409; delete cascades overrides (FK ON — the
 *    prod pragma raw test DBs don't get automatically) */

let dir: string;
let db: Database.Database;
let app: FastifyInstance;
let forgeState: { mode: string; presets: unknown[]; activeRunId: string | null };

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'm3-'));
  process.env['CRUCIBLE_MITM_STATE_DIR'] = dir;
  process.env['CRUCIBLE_MITM_BODIES_DIR'] = join(dir, 'bodies');
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON'); // prod truth — openDb sets this; raw test DBs must too
  migrateM1(db);
  forgeState = { mode: 'hybrid', presets: [], activeRunId: null };
  app = Fastify();
  registerForgeRoutes(app, db, forgeState as never);
  await app.ready();
});
afterEach(async () => {
  delete process.env['CRUCIBLE_MITM_STATE_DIR'];
  delete process.env['CRUCIBLE_MITM_BODIES_DIR'];
  await app.close();
  rmSync(dir, { recursive: true, force: true });
  db.close();
});

const insertPreset = (id: string, overrides: Record<string, unknown> = {}): void => {
  const cols: Record<string, unknown> = { id, method: 'GET', path_pattern: '/x', match: 'exact', status: 200, headers_json: null, body_path: null, delay_ms: null, seq_json: null, failure: null, throttle_kbps: null, created_by: 't', created_at: 1, sha256: 'x', ...overrides };
  const keys = Object.keys(cols);
  db.prepare(`INSERT INTO presets(${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => cols[k]));
};

describe('GET /api/forge/presets/:id (editor load)', () => {
  it('returns the row + decoded body + content-type', async () => {
    const bodies = join(dir, 'bodies');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(bodies, { recursive: true });
    writeFileSync(join(bodies, 'p1.body'), '{"ok":true}');
    insertPreset('p1', { body_path: join(bodies, 'p1.body'), headers_json: JSON.stringify({ 'content-type': 'application/json' }) });
    const res = await app.inject({ method: 'GET', url: '/api/forge/presets/p1' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { preset: { id: string }; body: { text: string | null; contentType: string | null; bytes: number } };
    expect(body.preset.id).toBe('p1');
    expect(body.body.text).toBe('{"ok":true}');
    expect(body.body.contentType).toBe('application/json');
    expect(body.body.bytes).toBe(11);
  });
  it('404 on unknown id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/forge/presets/nope' });
    expect(res.statusCode).toBe(404);
  });
});

describe('PATCH /api/forge/presets/:id (edit in place)', () => {
  it('updates only provided fields, KEEPS the id (memberships survive)', async () => {
    insertPreset('p1', { status: 200 });
    db.prepare(`INSERT INTO scenarios(id, name, created_by) VALUES ('s1', 'scn', 't')`).run();
    db.prepare(`INSERT INTO scenario_overrides(scenario_id, preset_id, enabled) VALUES ('s1', 'p1', 1)`).run();
    const res = await app.inject({ method: 'PATCH', url: '/api/forge/presets/p1', payload: { status: 500, delayMs: 2000 } });
    expect(res.statusCode).toBe(200);
    const row = db.prepare('SELECT status, delay_ms, path_pattern FROM presets WHERE id = ?').get('p1') as { status: number; delay_ms: number; path_pattern: string };
    expect(row.status).toBe(500);
    expect(row.delay_ms).toBe(2000);
    expect(row.path_pattern).toBe('/x'); // untouched field unchanged
    const member = db.prepare('SELECT 1 FROM scenario_overrides WHERE preset_id = ?').get('p1');
    expect(member).toBeTruthy(); // same id — membership intact
  });
  it('strips query from pathPattern (B9)', async () => {
    insertPreset('p1');
    const res = await app.inject({ method: 'PATCH', url: '/api/forge/presets/p1', payload: { pathPattern: '/api/x?ts=1' } });
    expect(res.statusCode).toBe(200);
    const row = db.prepare('SELECT path_pattern FROM presets WHERE id = ?').get('p1') as { path_pattern: string };
    expect(row.path_pattern).toBe('/api/x');
  });
  it('validates: bad status 400, bad match 400, bad failure 400', async () => {
    insertPreset('p1');
    expect((await app.inject({ method: 'PATCH', url: '/api/forge/presets/p1', payload: { status: 42 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: '/api/forge/presets/p1', payload: { match: 'fuzzy' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: '/api/forge/presets/p1', payload: { failure: 'explode' } })).statusCode).toBe(400);
  });
  it('seq JSON validated: non-array 400, empty 400, valid passes', async () => {
    insertPreset('p1');
    expect((await app.inject({ method: 'PATCH', url: '/api/forge/presets/p1', payload: { seq: 'nope' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: '/api/forge/presets/p1', payload: { seq: [] } })).statusCode).toBe(400);
    const ok = await app.inject({ method: 'PATCH', url: '/api/forge/presets/p1', payload: { seq: [{ status: 500 }, { status: 200 }] } });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse((db.prepare('SELECT seq_json FROM presets WHERE id = ?').get('p1') as { seq_json: string }).seq_json)).toEqual([{ status: 500 }, { status: 200 }]);
  });
  it('404 on unknown id; 400 on empty body', async () => {
    expect((await app.inject({ method: 'PATCH', url: '/api/forge/presets/nope', payload: { status: 200 } })).statusCode).toBe(404);
    insertPreset('p1');
    expect((await app.inject({ method: 'PATCH', url: '/api/forge/presets/p1', payload: {} })).statusCode).toBe(400);
  });
});

describe('PUT /api/forge/presets/:id/body (editor body write)', () => {
  it('writes the body atomically into the B6 dir, sets body_path, merges content-type', async () => {
    insertPreset('p1', { headers_json: JSON.stringify({ 'x-other': 'y' }) });
    const res = await app.inject({ method: 'PUT', url: '/api/forge/presets/p1/body', payload: { text: '{"faked":true}', contentType: 'application/json' } });
    expect(res.statusCode).toBe(200);
    const row = db.prepare('SELECT body_path, headers_json FROM presets WHERE id = ?').get('p1') as { body_path: string; headers_json: string };
    expect(row.body_path).toBe(join(dir, 'bodies', 'p1.body'));
    expect(readFileSync(row.body_path, 'utf8')).toBe('{"faked":true}');
    expect(JSON.parse(row.headers_json)).toEqual({ 'x-other': 'y', 'content-type': 'application/json' }); // merged, not replaced
    expect(existsSync(`${row.body_path}.${process.pid}.tmp`)).toBe(false); // tmp cleaned by rename
  });
  it('a preset with no body gains one', async () => {
    insertPreset('p2');
    const res = await app.inject({ method: 'PUT', url: '/api/forge/presets/p2/body', payload: { text: 'hello' } });
    expect(res.statusCode).toBe(200);
    expect(db.prepare('SELECT body_path FROM presets WHERE id = ?').get('p2') as { body_path: string }).toBeTruthy();
  });
  it('415 over the 256KB editor bound', async () => {
    insertPreset('p1');
    const res = await app.inject({ method: 'PUT', url: '/api/forge/presets/p1/body', payload: { text: 'x'.repeat(262_145) } });
    expect(res.statusCode).toBe(415);
  });
});

describe('scenario management (M3)', () => {
  const makeScenario = (id: string, name: string): void => {
    db.prepare(`INSERT INTO scenarios(id, name, created_by) VALUES (?, ?, 't')`).run(id, name);
  };

  it('PATCH rename: works; name collision 409; empty name 400', async () => {
    makeScenario('s1', 'one');
    makeScenario('s2', 'two');
    expect((await app.inject({ method: 'PATCH', url: '/api/forge/scenarios/s1', payload: { name: 'renamed' } })).statusCode).toBe(200);
    expect(db.prepare('SELECT name FROM scenarios WHERE id = ?').get('s1')).toEqual({ name: 'renamed' });
    expect((await app.inject({ method: 'PATCH', url: '/api/forge/scenarios/s1', payload: { name: 'two' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'PATCH', url: '/api/forge/scenarios/s1', payload: { name: '  ' } })).statusCode).toBe(400);
  });

  it('DELETE cascades membership rows (FK) and clears any active override', async () => {
    makeScenario('s1', 'one');
    insertPreset('p0', { path_pattern: '/db-only' }); // DB preset NOT in the scenario — makes the reset visible
    insertPreset('p1');
    db.prepare(`INSERT INTO scenario_overrides(scenario_id, preset_id, enabled) VALUES ('s1', 'p1', 1)`).run();
    // activate it (sets the override + in-process serving set = ENABLED members only)
    await app.inject({ method: 'POST', url: '/api/forge/scenarios/s1/activate' });
    expect((forgeState.presets as Array<{ id: string }>).map((p) => p.id)).toEqual(['p1']); // scenario view: member only
    const res = await app.inject({ method: 'DELETE', url: '/api/forge/scenarios/s1' });
    expect(res.statusCode).toBe(200);
    expect(db.prepare('SELECT 1 FROM scenario_overrides WHERE scenario_id = ?').get('s1')).toBeFalsy(); // cascaded
    // in-process serving set back to DB presets (ALL of them — the reset is visible via p0)
    expect((forgeState.presets as Array<{ id: string }>).map((p) => p.id).sort()).toEqual(['p0', 'p1']);
    expect(db.prepare('SELECT 1 FROM presets WHERE id = ?').get('p1')).toBeTruthy(); // preset rows untouched
  });

  it('GET :id returns scenario + members with preset info', async () => {
    makeScenario('s1', 'one');
    insertPreset('p1', { path_pattern: '/tariff', status: 500 });
    insertPreset('p2', { path_pattern: '/other' });
    db.prepare(`INSERT INTO scenario_overrides(scenario_id, preset_id, enabled) VALUES ('s1', 'p1', 1)`).run();
    db.prepare(`INSERT INTO scenario_overrides(scenario_id, preset_id, enabled) VALUES ('s1', 'p2', 0)`).run();
    const res = await app.inject({ method: 'GET', url: '/api/forge/scenarios/s1' });
    const body = res.json() as { scenario: { name: string }; members: Array<{ preset_id: string; enabled: number; method: string; path_pattern: string; status: number }> };
    expect(body.scenario.name).toBe('one');
    expect(body.members.map((m) => [m.preset_id, m.enabled])).toContainEqual(['p1', 1]);
    expect(body.members.map((m) => [m.preset_id, m.enabled])).toContainEqual(['p2', 0]);
    expect(body.members.find((m) => m.preset_id === 'p1')?.path_pattern).toBe('/tariff');
  });

  it('PUT members: replace-set semantics; unknown preset 400', async () => {
    makeScenario('s1', 'one');
    insertPreset('p1');
    insertPreset('p2');
    db.prepare(`INSERT INTO scenario_overrides(scenario_id, preset_id, enabled) VALUES ('s1', 'p1', 1)`).run();
    const res = await app.inject({ method: 'PUT', url: '/api/forge/scenarios/s1/members', payload: { members: [{ presetId: 'p2', enabled: false }, { presetId: 'p1' }] } });
    expect(res.statusCode).toBe(200);
    const rows = db.prepare('SELECT preset_id, enabled FROM scenario_overrides WHERE scenario_id = ? ORDER BY preset_id').all('s1') as Array<{ preset_id: string; enabled: number }>;
    expect(rows).toEqual([{ preset_id: 'p1', enabled: 1 }, { preset_id: 'p2', enabled: 0 }]); // replaced, not appended
    expect((await app.inject({ method: 'PUT', url: '/api/forge/scenarios/s1/members', payload: { members: [{ presetId: 'ghost' }] } })).statusCode).toBe(400);
  });

  it('activate updates BOTH proxy consumers (route-level, self-review catch)', async () => {
    makeScenario('s1', 'one');
    insertPreset('p1', { path_pattern: '/scn', status: 503 });
    db.prepare(`INSERT INTO scenario_overrides(scenario_id, preset_id, enabled) VALUES ('s1', 'p1', 1)`).run();
    const res = await app.inject({ method: 'POST', url: '/api/forge/scenarios/s1/activate' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { active: number }).active).toBe(1);
    // in-process consumer
    const inProc = forgeState.presets as Array<{ id: string; status: number }>;
    expect(inProc.map((p) => p.id)).toEqual(['p1']);
    expect(inProc[0]!.status).toBe(503);
    // file consumer (same enqueue chain, drained by the route await)
    await new Promise((r) => setTimeout(r, 50));
    const st = JSON.parse(readFileSync(join(dir, 'forge-mitm-state.json'), 'utf8')) as { presets: Array<{ id: string }> };
    expect(st.presets.map((p) => p.id)).toEqual(['p1']);
  });
});
