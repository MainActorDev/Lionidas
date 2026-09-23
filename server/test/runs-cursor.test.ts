import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { migrateM1 } from '../src/db/schema.ts';
import { registerRunRoutes } from '../src/routes/runs.ts';

/** 017-C T1 — /api/runs cursor + pseudo-statuses.
 *  before = strictly-older epoch-ms cursor (NULL started_at sorts last and is
 *  excluded); status=blocked maps to the blocked COLUMN (schema CHECK forbids
 *  status='blocked'); status=active = running OR queued (pinned for the chip). */

let tmp: string;
let db: Database.Database;
let app: FastifyInstance;

function run(id: string, status: string, started: number | null, blocked = 0, finished: number | null = null): void {
  db.prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at, finished_at, blocked)
              VALUES (?, 'T', 'manual', ?, 'qa', 'sim', ?, ?, ?)`).run(id, status, started, finished, blocked);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'runs-cursor-'));
  db = new Database(join(tmp, 't.db'));
  migrateM1(db);
  app = Fastify();
  registerRunRoutes(app, db);
});

afterEach(() => {
  app.close();
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const ids = (r: { json: () => unknown }) => ((r.json() as { runs: Array<{ id: string }> }).runs.map((x) => x.id));

describe('T1 — before cursor', () => {
  it('returns strictly older rows only', async () => {
    run('r_new', 'passed', 3000, 0, 3100);
    run('r_mid', 'passed', 2000, 0, 2100);
    run('r_old', 'passed', 1000, 0, 1100);
    const r = await app.inject({ method: 'GET', url: '/api/runs?before=2000' });
    expect(r.statusCode).toBe(200);
    expect(ids(r)).toEqual(['r_old']); // 2000 itself excluded (strict <)
  });

  it('composes with status filter', async () => {
    run('r_new_fail', 'failed', 3000);
    run('r_old_fail', 'failed', 1000);
    run('r_old_pass', 'passed', 900);
    const r = await app.inject({ method: 'GET', url: '/api/runs?before=2000&status=failed' });
    expect(ids(r)).toEqual(['r_old_fail']);
  });

  it('absent before = today\'s behavior (regression pin)', async () => {
    run('r_a', 'passed', 1000);
    run('r_b', 'passed', 2000);
    const r = await app.inject({ method: 'GET', url: '/api/runs' });
    expect(ids(r)).toEqual(['r_b', 'r_a']); // newest first
  });

  it('garbage before ignored, not an error', async () => {
    run('r_a', 'passed', 1000);
    const r = await app.inject({ method: 'GET', url: '/api/runs?before=banana' });
    expect(r.statusCode).toBe(200);
    expect(ids(r)).toEqual(['r_a']);
  });
});

describe('T1 — blocked pseudo-status', () => {
  it('matches failed+blocked row, not unblocked failed', async () => {
    run('r_blocked', 'failed', 3000, 1);
    run('r_plainfail', 'failed', 2000);
    const r = await app.inject({ method: 'GET', url: '/api/runs?status=blocked' });
    expect(ids(r)).toEqual(['r_blocked']);
  });

  it('composes with before', async () => {
    run('r_blocked_new', 'failed', 3000, 1);
    run('r_blocked_old', 'failed', 1000, 1);
    const r = await app.inject({ method: 'GET', url: '/api/runs?status=blocked&before=2000' });
    expect(ids(r)).toEqual(['r_blocked_old']);
  });
});

describe('T1 — active pseudo includes queued (chip pin)', () => {
  it('returns running and queued, excludes terminal', async () => {
    run('r_run', 'running', 3000);
    run('r_queued', 'queued', 2000);
    run('r_pass', 'passed', 2500);
    const r = await app.inject({ method: 'GET', url: '/api/runs?status=active' });
    expect(ids(r).sort()).toEqual(['r_queued', 'r_run']);
  });
});
