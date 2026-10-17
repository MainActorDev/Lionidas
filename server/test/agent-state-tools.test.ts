/** Phase A S7 — agent read tools (states.list / states.get), the
 *  system-prompt vocabulary section, and the editor-completions vocabulary
 *  route. Grammar the agent doesn't know is vocabulary nobody proposes
 *  (step-schema seam #5): all three surfaces land together. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrateM1 } from '../src/db/schema.ts';

let db: Database.Database;
let tmp: string;

const B = 'com.example.foodiary';

function seedState(bundle: string, stateId: string, rev = 1): string {
  const id = `st_${bundle.replace(/[^a-z0-9]/gi, '_')}_${stateId}`;
  db.prepare("INSERT INTO app_states(id, app_bundle_id, state_id, label, probe_json, recipe_json, verify_json, provenance, revision, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'user', ?, 'qa', 0, 0)")
    .run(id, bundle, stateId, stateId, JSON.stringify({ screen: 'home.landed' }), JSON.stringify({ steps: [{ tap: { on: 'open_login' } }] }), JSON.stringify({ screen: 'home.landed' }), rev);
  db.prepare('INSERT INTO app_states_history(id, app_state_id, revision, snapshot_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(`sth_${id}`, id, rev, JSON.stringify({ stateId }), 'qa', 0);
  return id;
}

async function reg() {
  const { buildToolRegistry } = await import('../src/agent/tools.ts');
  const storage = { run: () => undefined, get: () => undefined } as never;
  const retriever = { retrieve: async () => [] } as never;
  return buildToolRegistry({ db, storage, retriever, artifactsDir: tmp });
}
async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await reg();
  const tool = (r as unknown as { list: () => Array<{ name: string; execute: (a: Record<string, unknown>) => Promise<string> }> }).list().find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return JSON.parse(await tool.execute(args)) as Record<string, unknown>;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 's7-'));
  db = new Database(':memory:');
  migrateM1(db);
});
afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('states.list / states.get — tool contracts', () => {
  it('lists states with bundle filter; parses to registry rows', async () => {
    seedState(B, 'fresh_install');
    seedState(B, 'logged_in', 2);
    seedState('com.other.app', 'fresh_install'); // same id, different bundle
    const rows = (await call('states.list', { appBundle: B })) as unknown as Array<Record<string, unknown>>;
    expect(rows.map((r) => r['state_id'])).toEqual(['fresh_install', 'logged_in']);
    expect(rows[0]).toMatchObject({ app_bundle_id: B, provenance: 'user', revision: 1 });
    expect(JSON.parse(String(rows[0]!['recipe_json']))).toEqual({ steps: [{ tap: { on: 'open_login' } }] });
    const all = (await call('states.list', {})) as unknown as Array<Record<string, unknown>>;
    expect(all).toHaveLength(3); // no filter → every bundle
  });

  it('states.get returns the full state + revision history (newest first)', async () => {
    seedState(B, 'logged_in', 2);
    const out = (await call('states.get', { appBundle: B, stateId: 'logged_in' })) as { state: Record<string, unknown>; history: Array<{ revision: number }> };
    expect(out.state).toMatchObject({ state_id: 'logged_in', revision: 2 });
    expect(out.history.map((h) => h.revision)).toEqual([2]);
  });

  it('unknown state → honest error naming the fix, not a throw', async () => {
    const out = await call('states.get', { appBundle: B, stateId: 'nope' });
    expect(out['error']).toMatch(/"nope" is not registered.*states\.list/);
  });
});

describe('system prompt teaches ensure state (seam #5: assert on the LIVE module)', () => {
  it('the vocabulary section exists and names the judgment, not just syntax', async () => {
    const { LIONIDAS_SYSTEM_PROMPT } = await import('../src/agent/system-prompt.ts');
    expect(LIONIDAS_SYSTEM_PROMPT).toMatch(/ensure state: <state_id>/);
    expect(LIONIDAS_SYSTEM_PROMPT).toMatch(/states\.list/);
    expect(LIONIDAS_SYSTEM_PROMPT).toMatch(/probe hit = instant pass/);
    expect(LIONIDAS_SYSTEM_PROMPT).toMatch(/A state nobody can name is a state nobody tests/);
  });
});

describe('vocabulary route ships appStates', () => {
  it('GET /api/templates/vocabulary carries bundle-tagged state ids', async () => {
    seedState(B, 'fresh_install');
    const { registerTemplateRoutes } = await import('../src/routes/templates.ts');
    const Fastify = (await import('fastify')).default;
    const app = Fastify();
    app.addHook('onRequest', async (req) => {
      (req as unknown as { user: { name: string; id: string; role: string } }).user = { name: 'qa', id: 'qa', role: 'operator' };
    });
    registerTemplateRoutes(app, db);
    const r = await app.inject({ method: 'GET', url: '/api/templates/vocabulary' });
    const body = JSON.parse(r.body) as { appStates?: Array<{ state: string; bundle: string }> };
    expect(body.appStates).toEqual([{ state: 'fresh_install', bundle: B }]);
    await app.close();
  });
});
