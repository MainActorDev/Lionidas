import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { migrateM1 } from '../src/db/schema.ts';
import { registerTemplateRoutes } from '../src/routes/templates.ts';

/** R2 S4 — save-time resolution: world steps resolve against the case's own
 *  declared worlds/variants; screen steps resolve against the app registry
 *  (including state names on expect screen). 422s name the offender. */

let tmp: string;
let db: Database.Database;
let app: FastifyInstance;

const BUNDLE = 'com.test.app';

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 's4-res-'));
  db = new Database(join(tmp, 't.db'));
  migrateM1(db);
  app = Fastify();
  registerTemplateRoutes(app, db, { emit: () => undefined } as never);
  // seed a registry screen: tracking { loading, loaded, error }
  db.prepare('INSERT INTO app_screens(app_bundle_id, screen_id, entry_json, refresh_json, states_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(BUNDLE, 'tracking', JSON.stringify({ deepLink: 'tracking' }), JSON.stringify({ gesture: 'pull' }),
      JSON.stringify({ loading: { any: [{ labelContains: 'Memuat' }] }, loaded: { all: [{ labelContains: 'STATUS' }] }, error: { any: [{ labelContains: 'Gagal' }] } }), 1);
});

afterEach(() => {
  app.close();
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const put = (yaml: string) => app.inject({ method: 'PUT', url: '/api/templates/tpl_v2/yaml', payload: { yaml } });

describe('S4 — save resolution', () => {
  beforeEach(() => {
    db.prepare(`INSERT INTO templates(id, name, udid, steps_json, tags_json, created_by, created_at, updated_at) VALUES ('tpl_v2', 'v2case', 'sim', '[]', '[]', 't', 1, 1)`).run();
  });

  it('fully-resolved v2 case saves; steps_json carries the R2 verbs', async () => {
    const r = await put([
      `name: v2case`,
      `app: ${BUNDLE}`,
      'worlds:',
      '  - id: sg',
      '    networkScenario: does-not-matter',
      'steps:',
      '  - arrive: tracking',
      '  - expect screen: tracking.loaded',
      '  - world: sg',
      '  - refresh: tracking',
      '  - expect screen: tracking.state != loading',
    ].join('\n'));
    expect(r.statusCode).toBe(200);
    const stored = db.prepare("SELECT steps_json FROM templates WHERE id='tpl_v2'").get() as { steps_json: string };
    const steps = JSON.parse(stored.steps_json) as Array<{ action: string }>;
    expect(steps.map((s) => s.action)).toEqual(['arrive', 'expectScreen', 'world', 'refresh', 'expectScreen']);
  });

  it('world step referencing an undeclared id → 422 naming it', async () => {
    const r = await put(['name: v2case', `app: ${BUNDLE}`, 'steps:', '  - world: nowhere'].join('\n'));
    expect(r.statusCode).toBe(422);
    expect((r.json() as { errors: Array<{ message: string }> }).errors[0]!.message).toContain('"nowhere"');
  });

  it('unknown screen → 422 pointing at the registry endpoint', async () => {
    const r = await put(['name: v2case', `app: ${BUNDLE}`, 'steps:', '  - arrive: ghost-screen'].join('\n'));
    expect(r.statusCode).toBe(422);
    const msg = (r.json() as { errors: Array<{ message: string }> }).errors[0]!.message;
    expect(msg).toContain('unknown screen "ghost-screen"');
    expect(msg).toContain(`/api/apps/${BUNDLE}/screens`);
  });

  it('expect screen with undeclared state → 422 listing declared states', async () => {
    const r = await put(['name: v2case', `app: ${BUNDLE}`, 'steps:', '  - expect screen: tracking.happy'].join('\n'));
    expect(r.statusCode).toBe(422);
    const msg = (r.json() as { errors: Array<{ message: string }> }).errors[0]!.message;
    expect(msg).toContain('no state "happy"');
    expect(msg).toContain('loading, loaded, error');
  });

  it('screen steps with no app → 422 asking for app:', async () => {
    const r = await put(['name: v2case', 'steps:', '  - arrive: tracking'].join('\n'));
    expect(r.statusCode).toBe(422);
    expect((r.json() as { errors: Array<{ message: string }> }).errors[0]!.message).toContain('need an app');
  });

  it('worlds-only case persists worlds into variants_json (storage back-compat)', async () => {
    const r = await put([
      'name: v2case',
      `app: ${BUNDLE}`,
      'worlds:',
      '  - id: sg',
      '    networkScenario: countries-sg',
      'steps:',
      '  - arrive: tracking',
    ].join('\n'));
    expect(r.statusCode).toBe(200);
    const stored = db.prepare("SELECT variants_json FROM templates WHERE id='tpl_v2'").get() as { variants_json: string };
    expect(JSON.parse(stored.variants_json)).toEqual([{ id: 'sg', networkScenario: 'countries-sg' }]);
  });
});
