/** Phase B S1 — state proposals: the AI write-proposal inbox API contract.
 *  Create validates against the registry grammar + 409s registry collisions
 *  before storing; idempotent on the open (bundle, state_id) pair; accept is
 *  the only proposal→registry bridge (provenance 'ai+user', source_proposal,
 *  history rev 1) and 409s on drift/double-decide; reject is final.
 *  Route tests ride requireRole OFF via direct registration (app-states style). */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify, { type FastifyInstance } from 'fastify';
import { migrateM1 } from '../src/db/schema.ts';
import { registerStateProposalRoutes } from '../src/routes/state-proposals.ts';
import { registerAppStateRoutes } from '../src/routes/app-states.ts';

let tmp: string;
let db: Database.Database;
let app: FastifyInstance;

const BUNDLE = 'com.example.foodiary';

const DRAFT = {
  bundle: BUNDLE,
  stateId: 'on_meals_tab',
  label: 'Meals tab selected',
  probe: { identifier: 'meals_tab_button' },
  recipe: { steps: [{ tap: { on: 'meals_tab_button' } }] },
  verify: { identifier: 'meals_list' },
  rationale: 'run_abc converged via recipe in 3111ms; probe=target of final expect',
  sourceRunId: 'run_abc',
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'state-proposals-'));
  db = new Database(join(tmp, 't.db'));
  migrateM1(db);
  app = Fastify();
  registerStateProposalRoutes(app, db);
  registerAppStateRoutes(app, db); // accept path must respect the real registry
  app.addHook('onRequest', async (req) => {
    (req as unknown as { user: { name: string; id: string; role: string } }).user = { name: 'drill-qa', id: 'drill-qa', role: 'operator' };
  });
});

afterEach(() => {
  app.close();
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('schema', () => {
  it('state_proposals exists on fresh migrate and re-migrate is a no-op', () => {
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='state_proposals'").get();
    expect(t).toBeTruthy();
    expect(() => migrateM1(db)).not.toThrow();
  });

  it('pre-existing app_states (phase A DB) gains source_proposal via guarded ALTER', () => {
    const old = new Database(join(tmp, 'old.db'));
    // a phase A-shaped table: no source_proposal column
    old.exec(`CREATE TABLE app_states(
      id TEXT PRIMARY KEY, app_bundle_id TEXT NOT NULL, state_id TEXT NOT NULL, label TEXT NOT NULL,
      probe_json TEXT NOT NULL, recipe_json TEXT NOT NULL, verify_json TEXT NOT NULL,
      provenance TEXT NOT NULL CHECK(provenance IN ('user','ai+user','import')),
      revision INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(app_bundle_id, state_id))`);
    old.close();
    const again = new Database(join(tmp, 'old.db'));
    expect(() => migrateM1(again)).not.toThrow();
    const cols = (again.prepare('PRAGMA table_info(app_states)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('source_proposal');
    again.close();
  });
});

describe('create', () => {
  it('stores an open proposal and lists it', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/states/proposals', payload: DRAFT });
    expect(r.statusCode).toBe(201);
    const body = r.json() as { proposal: { id: string; status: string; stateId: string } };
    expect(body.proposal.status).toBe('open');
    expect(body.proposal.stateId).toBe('on_meals_tab');

    const list = await app.inject({ method: 'GET', url: `/api/apps/${BUNDLE}/proposals` });
    const { proposals } = list.json() as { proposals: Array<{ id: string; status: string }> };
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.status).toBe('open');
  });

  it('is idempotent on the open (bundle, state_id) pair — no duplicate inbox rows (edge 2)', async () => {
    const r1 = await app.inject({ method: 'POST', url: '/api/states/proposals', payload: DRAFT });
    const r2 = await app.inject({ method: 'POST', url: '/api/states/proposals', payload: DRAFT });
    expect(r1.statusCode).toBe(201);
    expect(r2.statusCode).toBe(200);
    const b1 = r1.json() as { proposal: { id: string } };
    const b2 = r2.json() as { proposal: { id: string }, deduped: boolean };
    expect(b2.deduped).toBe(true);
    expect(b2.proposal.id).toBe(b1.proposal.id);
  });

  it('409s a registry collision BEFORE storing (edge 1 create half)', async () => {
    await app.inject({ method: 'POST', url: `/api/apps/${BUNDLE}/states`, payload: { stateId: 'on_meals_tab', label: 'Meals tab', probe: DRAFT.probe, recipe: DRAFT.recipe, verify: DRAFT.verify } });
    const r = await app.inject({ method: 'POST', url: '/api/states/proposals', payload: DRAFT });
    expect(r.statusCode).toBe(409);
    const list = await app.inject({ method: 'GET', url: `/api/apps/${BUNDLE}/proposals` });
    expect((list.json() as { proposals: unknown[] }).proposals).toHaveLength(0);
  });

  it('422s an invalid draft — the inbox never holds an unacceptable state', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/states/proposals', payload: { ...DRAFT, recipe: { steps: [] } } });
    expect(r.statusCode).toBe(422);
  });

  it('422s a proposal without rationale — drafts cite evidence (plan S2)', async () => {
    const { rationale: _drop, ...noWhy } = DRAFT;
    const r = await app.inject({ method: 'POST', url: '/api/states/proposals', payload: noWhy });
    expect(r.statusCode).toBe(422);
  });
});

describe('accept', () => {
  it('creates the registry entry with provenance ai+user + source_proposal + history rev 1', async () => {
    const created = (await app.inject({ method: 'POST', url: '/api/states/proposals', payload: DRAFT })).json() as { proposal: { id: string } };
    const r = await app.inject({ method: 'POST', url: `/api/states/proposals/${created.proposal.id}/accept` });
    expect(r.statusCode).toBe(200);
    const { stateId } = r.json() as { stateId: string };

    const st = db.prepare('SELECT * FROM app_states WHERE id = ?').get(stateId) as { provenance: string; source_proposal: string; revision: number; state_id: string };
    expect(st.provenance).toBe('ai+user');
    expect(st.source_proposal).toBe(created.proposal.id);
    expect(st.revision).toBe(1);
    expect(st.state_id).toBe('on_meals_tab');

    const hist = db.prepare('SELECT revision, snapshot_json FROM app_states_history WHERE app_state_id = ?').all(stateId) as Array<{ revision: number; snapshot_json: string }>;
    expect(hist).toHaveLength(1);
    expect(JSON.parse(hist[0]!.snapshot_json).sourceProposal).toBe(created.proposal.id);

    const p = db.prepare('SELECT status, decided_by FROM state_proposals WHERE id = ?').get(created.proposal.id) as { status: string; decided_by: string };
    expect(p.status).toBe('accepted');
    expect(p.decided_by).toBe('drill-qa');
  });

  it('409s double-accept (edge 6) and rejects-after-accept', async () => {
    const created = (await app.inject({ method: 'POST', url: '/api/states/proposals', payload: DRAFT })).json() as { proposal: { id: string } };
    await app.inject({ method: 'POST', url: `/api/states/proposals/${created.proposal.id}/accept` });
    const second = await app.inject({ method: 'POST', url: `/api/states/proposals/${created.proposal.id}/accept` });
    expect(second.statusCode).toBe(409);
    const rej = await app.inject({ method: 'POST', url: `/api/states/proposals/${created.proposal.id}/reject` });
    expect(rej.statusCode).toBe(409);
  });

  it('409s when the registry grew the state after drafting (edge 1 accept half) — proposal stays open', async () => {
    const created = (await app.inject({ method: 'POST', url: '/api/states/proposals', payload: DRAFT })).json() as { proposal: { id: string } };
    await app.inject({ method: 'POST', url: `/api/apps/${BUNDLE}/states`, payload: { stateId: 'on_meals_tab', label: 'Meals tab', probe: DRAFT.probe, recipe: DRAFT.recipe, verify: DRAFT.verify } });
    const r = await app.inject({ method: 'POST', url: `/api/states/proposals/${created.proposal.id}/accept` });
    expect(r.statusCode).toBe(409);
    const p = db.prepare('SELECT status FROM state_proposals WHERE id = ?').get(created.proposal.id) as { status: string };
    expect(p.status).toBe('open');
  });
});

describe('reject', () => {
  it('is final and records the decider (edge 5)', async () => {
    const created = (await app.inject({ method: 'POST', url: '/api/states/proposals', payload: DRAFT })).json() as { proposal: { id: string } };
    const r = await app.inject({ method: 'POST', url: `/api/states/proposals/${created.proposal.id}/reject` });
    expect(r.statusCode).toBe(200);
    const p = r.json() as { proposal: { status: string; decidedBy: string } };
    expect(p.proposal.status).toBe('rejected');
    expect(p.proposal.decidedBy).toBe('drill-qa');
    const again = await app.inject({ method: 'POST', url: `/api/states/proposals/${created.proposal.id}/reject` });
    expect(again.statusCode).toBe(409);
  });

  it('a rejected state_id may be re-proposed as a NEW row (edge 5)', async () => {
    const created = (await app.inject({ method: 'POST', url: '/api/states/proposals', payload: DRAFT })).json() as { proposal: { id: string } };
    await app.inject({ method: 'POST', url: `/api/states/proposals/${created.proposal.id}/reject` });
    const r2 = await app.inject({ method: 'POST', url: '/api/states/proposals', payload: DRAFT });
    expect(r2.statusCode).toBe(201); // not deduped — the open pair is free again
    const list = await app.inject({ method: 'GET', url: `/api/apps/${BUNDLE}/proposals` });
    const { proposals } = list.json() as { proposals: Array<{ status: string }> };
    expect(proposals).toHaveLength(2);
  });
});

describe('unknown ids', () => {
  it('404s honestly on every verb', async () => {
    for (const url of ['/api/states/proposals/sp_nope/accept', '/api/states/proposals/sp_nope/reject']) {
      const r = await app.inject({ method: 'POST', url });
      expect(r.statusCode).toBe(404);
    }
  });
});
