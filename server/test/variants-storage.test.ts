/** Phase B T3 — variants storage: PUT yaml persists variants_json with
 *  scenario-name validation; GET yaml round-trips; table shape carries ids;
 *  variantless cases unchanged (compat). */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/index.ts';
import { migrateM1 } from '../src/db/schema.ts';

let db: Database.Database;
let tmp: string;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'var-t3-'));
  const dbPath = join(tmp, 't.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  migrateM1(db);
  migrateM1(db);
  app = await buildApp({ CRUCIBLE_REQUIRE_AUTH: '0', CRUCIBLE_DB_PATH: dbPath, CRUCIBLE_ARTIFACTS_DIR: tmp, VITEST: 'true' });
  await app.app.ready();
  db.prepare(`INSERT INTO templates(id, name, ticket_key, udid, steps_json, tags_json, created_by, created_at, updated_at)
              VALUES ('tpl_v', 'case v', NULL, 'sim-1', ?, '[]', 'qa', 0, 0)`)
    .run(JSON.stringify([{ idx: 0, action: 'tap', x: 1, y: 2 }]));
  db.prepare(`INSERT INTO scenarios(id, name, created_by) VALUES ('sc1', 'account-active', 'qa')`).run();
});
afterEach(async () => {
  await app.close();
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const YAML_3 = `name: case v
variants:
  - id: active
    networkScenario: account-active
    env:
      expected_title: "Account Active"
  - id: pending
    env:
      expected_title: "Verification Pending"
steps:
  - tap: { point: [1, 2] }
  - expect: "\${expected_title}"
`;

describe('variants storage round-trip', () => {
  it('PUT yaml persists variants_json; GET yaml returns them; table carries ids', async () => {
    const put = await app.app.inject({ method: 'PUT', url: '/api/templates/tpl_v/yaml', payload: { yaml: YAML_3 } });
    expect(put.statusCode).toBe(200);
    const stored = db.prepare('SELECT variants_json FROM templates WHERE id = ?').get('tpl_v') as { variants_json: string | null };
    expect(stored.variants_json).toBeTruthy();
    expect(JSON.parse(stored.variants_json!)).toHaveLength(2);

    const get = await app.app.inject({ method: 'GET', url: '/api/templates/tpl_v/yaml' });
    expect(get.statusCode).toBe(200);
    const y = (get.json() as { yaml: string }).yaml;
    expect(y).toContain('variants:');
    expect(y).toContain('- id: active');
    expect(y).toContain('networkScenario: account-active');
    expect(y).toContain('expected_title:');

    const row = await app.app.inject({ method: 'GET', url: '/api/templates/tpl_v' });
    expect((row.json() as { variants?: string[] }).variants).toEqual(['active', 'pending']);
  });

  it('unknown scenario → 422 naming variant + scenario; nothing persisted', async () => {
    const bad = YAML_3.replace('account-active', 'no-such-scenario');
    const put = await app.app.inject({ method: 'PUT', url: '/api/templates/tpl_v/yaml', payload: { yaml: bad } });
    expect(put.statusCode).toBe(422);
    const body = put.json() as { errors: Array<{ message: string }> };
    expect(body.errors[0]!.message).toContain('variant "active": unknown scenario "no-such-scenario"');
    const stored = db.prepare('SELECT variants_json FROM templates WHERE id = ?').get('tpl_v') as { variants_json: string | null };
    expect(stored.variants_json).toBeNull(); // unchanged
  });

  it('variantless save leaves variants_json NULL and GET yaml has no variants block (compat)', async () => {
    const plain = 'name: case v\nsteps:\n  - tap: { point: [1, 2] }\n';
    const put = await app.app.inject({ method: 'PUT', url: '/api/templates/tpl_v/yaml', payload: { yaml: plain } });
    expect(put.statusCode).toBe(200);
    const get = await app.app.inject({ method: 'GET', url: '/api/templates/tpl_v/yaml' });
    const y = (get.json() as { yaml: string }).yaml;
    expect(y).not.toContain('variants');
    const row = db.prepare('SELECT variants_json FROM templates WHERE id = ?').get('tpl_v') as { variants_json: string | null };
    expect(row.variants_json).toBeNull();
  });

  it('removing the variants key clears variants_json (not just left stale)', async () => {
    await app.app.inject({ method: 'PUT', url: '/api/templates/tpl_v/yaml', payload: { yaml: YAML_3 } });
    const plain = 'name: case v\nsteps:\n  - tap: { point: [1, 2] }\n';
    await app.app.inject({ method: 'PUT', url: '/api/templates/tpl_v/yaml', payload: { yaml: plain } });
    const row = db.prepare('SELECT variants_json FROM templates WHERE id = ?').get('tpl_v') as { variants_json: string | null };
    expect(row.variants_json).toBeNull();
  });
});
