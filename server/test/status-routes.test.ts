/** Status route tests (plan 20261014T062902Z): all six cards, degraded rules
 *  per card, secret hygiene, cache labeling. */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';
import { computeStatus } from '../src/routes/status.ts';

let tmp: string;
let db: Database.Database;
let agentDb: Database.Database;

const NOW = 1_790_000_000_000;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'status-'));
  db = new Database(join(tmp, 'c.db'));
  agentDb = new Database(join(tmp, 'a.db'));
  // minimal main-db tables the engine/freshness cards read
  db.exec(`CREATE TABLE devices(id TEXT PRIMARY KEY, last_seen INTEGER);`);
  db.exec(`CREATE TABLE runs(id TEXT PRIMARY KEY, status TEXT, started_at INTEGER);`);
  db.exec(`CREATE TABLE templates(id TEXT PRIMARY KEY, updated_at INTEGER);`);
  db.exec(`CREATE TABLE mx_payloads(id TEXT PRIMARY KEY, received_at INTEGER);`);
  // agent-db butler tables
  agentDb.exec(`CREATE TABLE butler_turns(id TEXT PRIMARY KEY, session_id TEXT, status TEXT, prompt TEXT, created_at INTEGER, updated_at INTEGER);`);
  agentDb.exec(`CREATE TABLE butler_turn_events(id TEXT PRIMARY KEY, turn_id TEXT, session_id TEXT, parent_id TEXT, schema_version INTEGER, seq INTEGER, kind TEXT, detail_json TEXT, at INTEGER);`);
  agentDb.exec(`CREATE TABLE butler_outbox(id TEXT PRIMARY KEY, session_id TEXT, effect_json TEXT, retired_at INTEGER, attempts INTEGER);`);
  agentDb.exec(`CREATE TABLE butler_documents(sha256 TEXT PRIMARY KEY, source_id TEXT, uri TEXT, title TEXT, content TEXT, kind TEXT, fetched_at INTEGER, bytes_path TEXT);`);
});
afterAll(() => { db.close(); agentDb.close(); rmSync(tmp, { recursive: true, force: true }); });

const ENV = { BUTLER_PROVIDER: 'claude-cli', BUTLER_MODEL: 'glm-5.3-flash', BUTLER_API_KEY: 'sk-secret-value', BUTLER_PROVIDER_BASE_URL: 'https://api.z.ai/api/coding/paas/v4' };

describe('GET /api/status shape (computeStatus)', () => {
  it('returns all six subsystem cards with states', () => {
    const p = computeStatus(db, agentDb, NOW, NOW - 4 * 3_600_000, ENV);
    expect(p.systems.map((s) => s.id)).toEqual(['server', 'agent-core', 'provider-mcp', 'llm-backend', 'engine', 'data-freshness']);
    for (const s of p.systems) expect(['ok', 'degraded', 'down', 'unknown']).toContain(s.state);
    expect(p.checkedAt).toBe(NOW);
  });

  it('healthy fixture → agent-core ok', () => {
    const p = computeStatus(db, agentDb, NOW, NOW - 1000, ENV);
    const core = p.systems.find((s) => s.id === 'agent-core')!;
    expect(core.state).toBe('ok');
  });

  it('zombie candidate (live turn idle > 15min) → degraded, turn listed', () => {
    agentDb.prepare(`INSERT INTO butler_turn_events VALUES('e1','t_z','s1',NULL,1,1,'turn.started','{}',?)`).run(NOW - 20 * 60_000);
    agentDb.prepare(`INSERT INTO butler_turn_events VALUES('e2','t_z','s1',NULL,1,2,'chunk','{}',?)`).run(NOW - 20 * 60_000);
    const p = computeStatus(db, agentDb, NOW, NOW - 1000, ENV);
    const core = p.systems.find((s) => s.id === 'agent-core')!;
    expect(core.state).toBe('degraded');
    expect(String(core.detail['zombie candidates'])).toContain('t_z');
    agentDb.prepare(`DELETE FROM butler_turn_events WHERE turn_id='t_z'`).run();
  });

  it('outbox backlog > 0 → degraded', () => {
    agentDb.prepare(`INSERT INTO butler_outbox VALUES('ob1','s1','{}',NULL,0)`).run();
    const p = computeStatus(db, agentDb, NOW, NOW - 1000, ENV);
    expect(p.systems.find((s) => s.id === 'agent-core')!.state).toBe('degraded');
    agentDb.prepare(`DELETE FROM butler_outbox`).run();
  });

  it('context burn (empty-answer failure within 24h) → llm-backend degraded', () => {
    agentDb.prepare(`INSERT INTO butler_turn_events VALUES('e3','t_b','s1',NULL,1,1,'turn.failed','{"error":"empty answer after work"}',?)`).run(NOW - 3_600_000);
    const p = computeStatus(db, agentDb, NOW, NOW - 1000, ENV);
    expect(p.systems.find((s) => s.id === 'llm-backend')!.state).toBe('degraded');
    agentDb.prepare(`DELETE FROM butler_turn_events WHERE turn_id='t_b'`).run();
  });

  it('fresh turn answers within 15min are live, not zombies (no-op twin)', () => {
    agentDb.prepare(`INSERT INTO butler_turn_events VALUES('e4','t_f','s1',NULL,1,1,'turn.started','{}',?)`).run(NOW - 2 * 60_000);
    const p = computeStatus(db, agentDb, NOW, NOW - 1000, ENV);
    const core = p.systems.find((s) => s.id === 'agent-core')!;
    expect(core.state).toBe('ok');
    expect(core.detail['live turns']).toBe(1);
    agentDb.prepare(`DELETE FROM butler_turn_events WHERE turn_id='t_f'`).run();
  });

  it('SECRET HYGIENE: no API key value anywhere in the payload', () => {
    const p = computeStatus(db, agentDb, NOW, NOW - 1000, ENV);
    const flat = JSON.stringify(p);
    expect(flat).not.toContain('sk-secret-value');
    const llm = p.systems.find((s) => s.id === 'llm-backend')!;
    expect(llm.detail['endpoint']).toBe('api.z.ai');
    expect(llm.detail['key present']).toBe(true);
  });

  it('orphaned manual session → engine degraded', () => {
    db.exec(`CREATE TABLE IF NOT EXISTS manual_sessions(id TEXT PRIMARY KEY, started_at INTEGER, finished_at INTEGER);`);
    db.prepare(`INSERT INTO manual_sessions VALUES('m1', ?, NULL)`).run(NOW - 20 * 60_000);
    const p = computeStatus(db, agentDb, NOW, NOW - 1000, ENV);
    expect(p.systems.find((s) => s.id === 'engine')!.state).toBe('degraded');
    db.prepare(`DELETE FROM manual_sessions`).run();
  });

  it('stale run (> 7d) → data-freshness degraded with the stale label', () => {
    db.prepare(`INSERT INTO runs VALUES('r1','done',?)`).run(NOW - 9 * 86_400_000);
    const p = computeStatus(db, agentDb, NOW, NOW - 1000, ENV);
    const fresh = p.systems.find((s) => s.id === 'data-freshness')!;
    expect(fresh.state).toBe('degraded');
    expect(String(fresh.detail['stale beyond threshold'])).toContain('last run');
    db.prepare(`DELETE FROM runs`).run();
  });
});

describe('route wiring', () => {
  it('GET /api/status serves the payload (operator-gated by requireRole in real app)', async () => {
    const { registerStatusRoutes } = await import('../src/routes/status.ts');
    const app = Fastify();
    registerStatusRoutes(app, db, join(tmp, 'a.db'), ENV, /* gated */ false);
    await app.ready();
    const r = await app.inject({ method: 'GET', url: '/api/status' });
    expect(r.statusCode).toBe(200);
    const body = r.json() as { systems: unknown[]; cached: boolean; checkedAt: number };
    expect(body.systems.length).toBe(6);
    expect(typeof body.cached).toBe('boolean');
    // second hit within TTL is served cached
    const r2 = await app.inject({ method: 'GET', url: '/api/status' });
    expect((r2.json() as { cached: boolean }).cached).toBe(true);
  });
});
