import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { migrateM1 } from '../src/db/schema.ts';
import { parseVariants, variantScenarioNames, type YamlVariant } from '@crucible/shared/yaml-variants';
import { registerTemplateRoutes } from '../src/routes/templates.ts';

/** S2 — scenario sets: variants reference multiple scenarios; effective
 *  presets = union (dedup by preset id); duplicate (method, path) across the
 *  union is a save-time 409; singular networkScenario stays as sugar. */

let tmp: string;
let db: Database.Database;
let app: FastifyInstance;

function seedScenario(name: string, endpoints: Array<[string, string]>): string {
  const sid = `s_${name.replace(/[^a-z0-9]/g, '').slice(0, 8)}${Math.floor(Math.random() * 1000)}`;
  db.prepare('INSERT INTO scenarios(id, name, created_by) VALUES (?, ?, ?)').run(sid, name, 't');
  for (const [method, path] of endpoints) {
    const pid = `p_${Math.random().toString(36).slice(2, 10)}`;
    db.prepare(`INSERT INTO presets(id, method, path_pattern, match, status, created_by, created_at, sha256) VALUES (?, ?, ?, 'exact', 200, 't', 1, 'x')`).run(pid, method, path);
    db.prepare('INSERT INTO scenario_overrides(scenario_id, preset_id, enabled) VALUES (?, ?, 1)').run(sid, pid);
  }
  return sid;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 's2-sets-'));
  db = new Database(join(tmp, 't.db'));
  migrateM1(db);
  app = Fastify();
  registerTemplateRoutes(app, db, { emit: () => undefined } as never);
});

afterEach(() => {
  app.close();
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('S2 — parse: scenarios key', () => {
  it('accepts plural scenarios list', () => {
    const errors: Array<{ line: number; message: string }> = [];
    const out = parseVariants([{ id: 'sg', scenarios: ['countries-sg', 'rates-degraded'] }], errors);
    expect(errors).toEqual([]);
    expect(out).toEqual([{ id: 'sg', scenarios: ['countries-sg', 'rates-degraded'] }]);
  });

  it('rejects both keys at once, empty list, dup entries, non-strings', () => {
    const errors: Array<{ line: number; message: string }> = [];
    parseVariants([{ id: 'a', networkScenario: 'x', scenarios: ['y'] }], errors);
    parseVariants([{ id: 'b', scenarios: [] }], errors);
    parseVariants([{ id: 'c', scenarios: ['x', 'x'] }], errors);
    parseVariants([{ id: 'd', scenarios: ['x', 5] }], errors);
    expect(errors.map((e) => e.message)).toEqual([
      expect.stringContaining('not both'),
      expect.stringContaining('non-empty list'),
      expect.stringContaining('duplicate scenario "x"'),
      expect.stringContaining('non-empty list'),
    ]);
  });

  it('singular stays valid (back-compat sugar)', () => {
    const errors: Array<{ line: number; message: string }> = [];
    const out = parseVariants([{ id: 'sg', networkScenario: 'countries-sg' }], errors);
    expect(errors).toEqual([]);
    expect(out).toEqual([{ id: 'sg', networkScenario: 'countries-sg' }]);
  });
});

describe('S2 — variantScenarioNames accessor', () => {
  it('plural as authored; singular as [x]; none as []', () => {
    expect(variantScenarioNames({ id: 'a', scenarios: ['x', 'y'] } as YamlVariant)).toEqual(['x', 'y']);
    expect(variantScenarioNames({ id: 'b', networkScenario: 'x' } as YamlVariant)).toEqual(['x']);
    expect(variantScenarioNames({ id: 'c' } as YamlVariant)).toEqual([]);
    expect(variantScenarioNames(null)).toEqual([]);
  });
});

describe('S2 — save validation (PUT yaml)', () => {
  const CASE = (variantsYaml: string): string => `name: setcase\napp: com.x.y\nsteps:\n  - tap: { point: [1, 1], on: b }\n${variantsYaml}`;

  it('unknown scenario in a set → 422 naming it', async () => {
    seedScenario('real-one', [['GET', '/v1/real']]);
    db.prepare(`INSERT INTO templates(id, name, udid, steps_json, tags_json, created_by, created_at, updated_at) VALUES ('tpl_s2a', 'setcase', 'sim', '[]', '[]', 't', 1, 1)`).run();
    const r = await app.inject({ method: 'PUT', url: '/api/templates/tpl_s2a/yaml', payload: { yaml: CASE('variants:\n  - id: mixed\n    scenarios:\n      - real-one\n      - nope') } });
    expect(r.statusCode).toBe(422);
    expect((r.json() as { errors: Array<{ message: string }> }).errors[0]!.message).toContain('unknown scenario "nope"');
  });

  it('two scenarios faking the same endpoint → 409 naming both', async () => {
    seedScenario('countries-sg', [['GET', '/v1/rates']]);
    seedScenario('rates-degraded', [['GET', '/v1/rates']]);
    db.prepare(`INSERT INTO templates(id, name, udid, steps_json, tags_json, created_by, created_at, updated_at) VALUES ('tpl_s2b', 'setcase', 'sim', '[]', '[]', 't', 1, 1)`).run();
    const r = await app.inject({ method: 'PUT', url: '/api/templates/tpl_s2b/yaml', payload: { yaml: CASE('variants:\n  - id: mixed\n    scenarios:\n      - countries-sg\n      - rates-degraded') } });
    expect(r.statusCode).toBe(409);
    const msg = (r.json() as { errors: Array<{ message: string }> }).errors[0]!.message;
    expect(msg).toContain('countries-sg');
    expect(msg).toContain('rates-degraded');
    expect(msg).toContain('GET /v1/rates');
  });

  it('disjoint scenarios in a set save fine; singular path unchanged', async () => {
    seedScenario('countries-sg', [['GET', '/v1/rates']]);
    seedScenario('auth-happy', [['POST', '/v1/auth']]);
    db.prepare(`INSERT INTO templates(id, name, udid, steps_json, tags_json, created_by, created_at, updated_at) VALUES ('tpl_s2c', 'setcase', 'sim', '[]', '[]', 't', 1, 1)`).run();
    const ok = await app.inject({ method: 'PUT', url: '/api/templates/tpl_s2c/yaml', payload: { yaml: CASE('variants:\n  - id: mixed\n    scenarios:\n      - countries-sg\n      - auth-happy') } });
    expect(ok.statusCode).toBe(200);
    const stored = db.prepare("SELECT variants_json FROM templates WHERE id='tpl_s2c'").get() as { variants_json: string };
    expect(JSON.parse(stored.variants_json)).toEqual([{ id: 'mixed', scenarios: ['countries-sg', 'auth-happy'] }]);
    // singular sugar on the same case still saves
    const ok2 = await app.inject({ method: 'PUT', url: '/api/templates/tpl_s2c/yaml', payload: { yaml: CASE('variants:\n  - id: solo\n    networkScenario: countries-sg') } });
    expect(ok2.statusCode).toBe(200);
  });
});

describe('S2 — union activation shape (SQL contract)', () => {
  it('DISTINCT across set members dedupes shared presets', () => {
    const sidA = seedScenario('alpha', [['GET', '/a']]);
    const sidB = seedScenario('beta', [['GET', '/b']]);
    // shared preset: same preset in both scenarios
    const shared = 'p_shared01';
    db.prepare(`INSERT INTO presets(id, method, path_pattern, match, status, created_by, created_at, sha256) VALUES (?, 'GET', '/shared', 'exact', 200, 't', 1, 'x')`).run(shared);
    db.prepare('INSERT INTO scenario_overrides(scenario_id, preset_id, enabled) VALUES (?, ?, 1)').run(sidA, shared);
    db.prepare('INSERT INTO scenario_overrides(scenario_id, preset_id, enabled) VALUES (?, ?, 1)').run(sidB, shared);
    const rows = db.prepare(
      `SELECT DISTINCT p.id FROM presets p JOIN scenario_overrides so ON so.preset_id = p.id WHERE so.scenario_id IN (?, ?) AND so.enabled = 1`,
    ).all(sidA, sidB) as Array<{ id: string }>;
    expect(rows.map((r) => r.id).sort()).toEqual([shared, ...rows.map((r) => r.id).filter((x) => x !== shared)].sort());
    expect(rows.length).toBe(new Set(rows.map((r) => r.id)).size); // no dup rows
    expect(rows.length).toBe(3); // /a + /b + /shared once
  });
});
