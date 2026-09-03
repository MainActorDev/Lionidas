import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerTemplateRoutes } from '../src/routes/templates.ts';
import { migrateM1 } from '../src/db/schema.ts';

/** T1: YAML routes — validate (pure), GET :id/yaml (name resolution for
 *  runFlow), PUT :id/yaml (validate → resolve → persist). One validator backs
 *  both preview and save. */

let db: Database.Database;
let app: FastifyInstance;

const mkCase = (id: string, name: string, steps: unknown[], extra = ''): void => {
  db.prepare(
    `INSERT INTO templates(id, name, description, ticket_key, udid, logical_w, logical_h, steps_json, app_bundle_id, tags_json, created_by, created_at, updated_at${extra ? ', app_name, app_version' : ''})
     VALUES (?, ?, NULL, NULL, '', 428, 926, ?, NULL, '[]', 't', 1, 1${extra ? ", NULL, NULL" : ''})`,
  ).run(id, name, JSON.stringify(steps));
};

beforeEach(async () => {
  db = new Database(':memory:');
  migrateM1(db);
  app = Fastify();
  registerTemplateRoutes(app, db);
  await app.ready();
});
afterEach(async () => { await app.close(); db.close(); });

describe('POST /api/templates/yaml/validate (pure)', () => {
  it('valid yaml → ok with parsed case', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/templates/yaml/validate', payload: { yaml: 'name: x\nsteps:\n  - scroll: down\n' } });
    expect(res.statusCode).toBe(200);
    const b = res.json() as { ok: boolean; case: { name: string; steps: unknown[] } };
    expect(b.ok).toBe(true);
    expect(b.case.name).toBe('x');
    expect(b.case.steps).toHaveLength(1);
  });
  it('invalid yaml → ok:false with errors (not a 500)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/templates/yaml/validate', payload: { yaml: 'steps: []' } });
    const b = res.json() as { ok: boolean; errors: Array<{ message: string }> };
    expect(b.ok).toBe(false);
    expect(b.errors.length).toBeGreaterThan(0);
  });
});

describe('GET /api/templates/:id/yaml', () => {
  it('serializes steps; runFlow ids resolve to child case NAMES', async () => {
    mkCase('tpl_child01', 'dismiss-onboarding', [{ action: 'scroll', direction: 'down', idx: 0 }]);
    mkCase('tpl_parent1', 'parent', [
      { action: 'tap', x: 10, y: 20, idx: 0, selector: { label: 'Go' } },
      { action: 'runFlow', templateId: 'tpl_child01', idx: 1 },
    ]);
    const res = await app.inject({ method: 'GET', url: '/api/templates/tpl_parent1/yaml' });
    expect(res.statusCode).toBe(200);
    const { yaml } = res.json() as { yaml: string };
    expect(yaml).toContain('name: parent');
    expect(yaml).toContain('on: Go');
    expect(yaml).toContain('runFlow: { name: dismiss-onboarding }');
    expect(yaml).not.toContain('tpl_child01'); // id never surfaces to humans
  });
  it('404 unknown', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/templates/nope/yaml' })).statusCode).toBe(404);
  });
});

describe('PUT /api/templates/:id/yaml', () => {
  it('round-trip: GET yaml → edit → PUT → steps_json reflects the edit', async () => {
    mkCase('tpl_editme1', 'edit me', [{ action: 'tap', x: 1, y: 2, idx: 0, selector: { label: 'Old' } }]);
    const got = (await app.inject({ method: 'GET', url: '/api/templates/tpl_editme1/yaml' })).json() as { yaml: string };
    const edited = got.yaml
      .replace('on: Old', 'on: New')
      .replace('name: edit me', 'name: edited name')
      + '  - expect: Saved\n';
    const res = await app.inject({ method: 'PUT', url: '/api/templates/tpl_editme1/yaml', payload: { yaml: edited } });
    expect(res.statusCode).toBe(200);
    const row = db.prepare('SELECT name, steps_json FROM templates WHERE id = ?').get('tpl_editme1') as { name: string; steps_json: string };
    expect(row.name).toBe('edited name');
    const steps = JSON.parse(row.steps_json) as Array<Record<string, unknown>>;
    expect(steps[0]).toMatchObject({ selector: { label: 'New' } });
    expect(steps[1]).toMatchObject({ action: 'expect', selector: { label: 'Saved' } });
  });

  it('422 with the validator errors on schema violation', async () => {
    mkCase('tpl_badyaml', 'bad', [{ action: 'scroll', direction: 'down', idx: 0 }]);
    const res = await app.inject({ method: 'PUT', url: '/api/templates/tpl_badyaml/yaml', payload: { yaml: 'name: x\nsteps:\n  - tap: { point: [1, 2], optinal: true }\n' } });
    expect(res.statusCode).toBe(422);
    const b = res.json() as { errors: Array<{ message: string }> };
    expect(b.errors[0]!.message).toContain('optinal');
  });

  it('409 on runFlow name that does not exist; resolves valid names to ids', async () => {
    mkCase('tpl_flowa01', 'flow-a', [{ action: 'scroll', direction: 'down', idx: 0 }]);
    mkCase('tpl_flowb02', 'uses-flow', [{ action: 'scroll', direction: 'up', idx: 0 }]);
    const missing = await app.inject({ method: 'PUT', url: '/api/templates/tpl_flowb02/yaml', payload: { yaml: 'name: x\nsteps:\n  - runFlow: no-such-case\n' } });
    expect(missing.statusCode).toBe(409);
    const ok = await app.inject({ method: 'PUT', url: '/api/templates/tpl_flowb02/yaml', payload: { yaml: 'name: x\nsteps:\n  - runFlow: flow-a\n' } });
    expect(ok.statusCode).toBe(200);
    const steps = JSON.parse((db.prepare('SELECT steps_json FROM templates WHERE id = ?').get('tpl_flowb02') as { steps_json: string }).steps_json) as Array<Record<string, unknown>>;
    expect(steps[0]).toMatchObject({ action: 'runFlow', templateId: 'tpl_flowa01' }); // name resolved to id
  });

  it('rename collision via yaml → 409 (templates.name is UNIQUE — ambiguity impossible)', async () => {
    mkCase('tpl_dup00001', 'taken', []);
    mkCase('tpl_dup00002', 'renamer', []);
    const res = await app.inject({ method: 'PUT', url: '/api/templates/tpl_dup00002/yaml', payload: { yaml: 'name: taken\nsteps:\n  - scroll: down\n' } });
    expect(res.statusCode).toBe(409);
    expect(((res.json() as { errors: Array<{ message: string }> }).errors[0]!.message)).toContain('already exists');
  });

  it('404 unknown id', async () => {
    expect((await app.inject({ method: 'PUT', url: '/api/templates/nope/yaml', payload: { yaml: 'name: x\nsteps:\n  - scroll: down\n' } })).statusCode).toBe(404);
  });
});
