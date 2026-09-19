/** Phase A T1 — case_versions schema contract: fresh-DB creation, ALTER
 *  columns, idempotent migration (tsx-watch re-runs), backfill honesty. */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { migrateM1 } from '../src/db/schema.ts';

const seedTemplate = (db: Database.Database, id: string, steps = '[]'): void => {
  db.prepare(`INSERT INTO templates(id, name, ticket_key, udid, steps_json, created_by, created_at, updated_at)
              VALUES (?, ?, NULL, 'sim-1', ?, 'qa', 100, 200)`).run(id, id, steps);
};

const cols = (db: Database.Database, table: string): string[] =>
  (db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as Array<{ name: string }>).map((c) => c.name);

describe('case_versions schema', () => {
  it('fresh DB: table + indexes exist, runs gains case_version_id/variant_id', () => {
    const db = new Database(':memory:');
    migrateM1(db);
    expect(cols(db, 'case_versions')).toContain('steps_sha256');
    expect(cols(db, 'case_versions')).toContain('yaml_canonical');
    expect(cols(db, 'case_versions')).toContain('scenario_snapshot_json');
    expect(cols(db, 'runs')).toContain('case_version_id');
    expect(cols(db, 'runs')).toContain('variant_id');
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_case_versions_template'").get();
    expect(idx).toBeTruthy();
  });

  it('backfills revision 1 for existing templates with the honest steps hash', () => {
    const db = new Database(':memory:');
    // templates must exist BEFORE migrate for the backfill to see them —
    // so migrate once (creates tables), seed, then run the backfill era by
    // calling migrate again (the guard makes it idempotent).
    migrateM1(db);
    seedTemplate(db, 'tpl_abc', JSON.stringify([{ idx: 0, action: 'tap', x: 1, y: 2 }]));
    migrateM1(db); // second pass: backfill sees the template now
    const rows = db.prepare('SELECT id, revision, source, steps_sha256 FROM case_versions WHERE template_id = ?').all('tpl_abc');
    expect(rows).toHaveLength(1);
    const v = rows[0] as { id: string; revision: number; source: string; steps_sha256: string };
    expect(v.revision).toBe(1);
    expect(v.source).toBe('backfill');
    expect(v.steps_sha256).toBe(
      // same hash the snapshot service will compute — sha256 of the RAW stored steps_json
      createHash('sha256').update(JSON.stringify([{ idx: 0, action: 'tap', x: 1, y: 2 }])).digest('hex'));
  });

  it('re-migrating never duplicates backfill rows (tsx-watch safety)', () => {
    const db = new Database(':memory:');
    migrateM1(db);
    seedTemplate(db, 'tpl_x', '[]');
    migrateM1(db);
    migrateM1(db);
    migrateM1(db);
    expect(db.prepare('SELECT COUNT(*) n FROM case_versions WHERE template_id = ?').get('tpl_x'))
      .toMatchObject({ n: 1 });
  });

  it('template deleted → version rows survive (no FK cascade, by design)', () => {
    const db = new Database(':memory:');
    migrateM1(db);
    seedTemplate(db, 'tpl_gone', '[]');
    migrateM1(db);
    db.prepare('DELETE FROM templates WHERE id = ?').run('tpl_gone');
    expect(db.prepare('SELECT COUNT(*) n FROM case_versions WHERE template_id = ?').get('tpl_gone'))
      .toMatchObject({ n: 1 });
  });

  it('UNIQUE(template_id, revision) is enforced', () => {
    const db = new Database(':memory:');
    migrateM1(db);
    expect(() => {
      db.prepare(`INSERT INTO case_versions(id, template_id, revision, steps_sha256, yaml_canonical, source, created_at)
                  VALUES ('a', 't', 1, 'x', '', 'run', 0)`).run();
      db.prepare(`INSERT INTO case_versions(id, template_id, revision, steps_sha256, yaml_canonical, source, created_at)
                  VALUES ('b', 't', 1, 'y', '', 'run', 0)`).run();
    }).toThrow();
  });
});

describe('case_versions schema — real file (WAL parity with buildApp)', () => {
  it('migrates a file DB and cleans up', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cv-schema-'));
    try {
      const db = new Database(join(tmp, 't.db'));
      db.pragma('journal_mode = WAL');
      migrateM1(db);
      expect(cols(db, 'case_versions').length).toBeGreaterThan(5);
      db.close();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('suites schema (Phase D T1)', () => {
  it('fresh DB: suites + suite_members tables, runs/plans gain suite_id, index exists', () => {
    const db = new Database(':memory:');
    migrateM1(db);
    for (const c of ['id', 'name', 'description', 'created_by', 'created_at', 'updated_at']) {
      expect(cols(db, 'suites')).toContain(c);
    }
    for (const c of ['suite_id', 'template_id', 'variant_ids_json', 'position']) {
      expect(cols(db, 'suite_members')).toContain(c);
    }
    expect(cols(db, 'runs')).toContain('suite_id');
    expect(cols(db, 'plans')).toContain('suite_id');
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_suite_members_suite'").get();
    expect(idx).toBeTruthy();
  });

  it('existing DB (pre-suite era) migrates in place — ALTER loop adds both suite_id columns', () => {
    // simulate an older DB: create the pre-D shapes (only what the shared
    // CREATE exec's INDEX statements touch on runs — the block must survive),
    // then run the full migration
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE runs(id TEXT PRIMARY KEY, ticket_key TEXT NOT NULL, kind TEXT NOT NULL,
              status TEXT NOT NULL, triggered_by TEXT NOT NULL, device_udid TEXT NOT NULL, note TEXT,
              started_at INTEGER, app_version TEXT, template_id TEXT)`);
    db.exec(`CREATE TABLE plans(id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, tags_json TEXT NOT NULL DEFAULT '[]',
              udid TEXT, app_bundle_id TEXT, scenario_id TEXT, env_json TEXT NOT NULL DEFAULT '{}',
              created_by TEXT NOT NULL DEFAULT 'qa', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    migrateM1(db);
    expect(cols(db, 'runs')).toContain('suite_id');
    expect(cols(db, 'plans')).toContain('suite_id');
  });

  it('membership dies with its case (CASCADE); suite deletion nulls runs.suite_id (SET NULL)', () => {
    const db = new Database(':memory:');
    migrateM1(db);
    seedTemplate(db, 'tpl_m');
    db.prepare(`INSERT INTO suites(id, name, created_by, created_at, updated_at) VALUES ('st_1', 's1', 'qa', 1, 1)`).run();
    db.prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, note, suite_id)
                VALUES ('run_s1', 'T', 'manual', 'passed', 'qa', 'sim-1', NULL, 'st_1')`).run();
    db.prepare(`INSERT INTO suite_members(suite_id, template_id, variant_ids_json, position) VALUES ('st_1', 'tpl_m', NULL, 0)`).run();
    // case deleted → membership row gone, suite survives
    db.prepare('DELETE FROM templates WHERE id = ?').run('tpl_m');
    expect(db.prepare('SELECT COUNT(*) n FROM suite_members WHERE suite_id = ?').get('st_1')).toMatchObject({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) n FROM suites WHERE id = ?').get('st_1')).toMatchObject({ n: 1 });
    // suite deleted → run row survives with suite_id nulled
    db.prepare('DELETE FROM suites WHERE id = ?').run('st_1');
    const run = db.prepare('SELECT suite_id FROM runs WHERE id = ?').get('run_s1') as { suite_id: string | null };
    expect(run.suite_id).toBeNull();
  });

  it('UNIQUE(suite_id, template_id) and UNIQUE suites.name are enforced', () => {
    const db = new Database(':memory:');
    migrateM1(db);
    seedTemplate(db, 'tpl_u');
    db.prepare(`INSERT INTO suites(id, name, created_by, created_at, updated_at) VALUES ('st_1', 'dup', 'qa', 1, 1)`).run();
    expect(() => db.prepare(`INSERT INTO suites(id, name, created_by, created_at, updated_at) VALUES ('st_2', 'dup', 'qa', 1, 1)`).run()).toThrow();
    db.prepare(`INSERT INTO suite_members(suite_id, template_id, variant_ids_json, position) VALUES ('st_1', 'tpl_u', NULL, 0)`).run();
    expect(() => db.prepare(`INSERT INTO suite_members(suite_id, template_id, variant_ids_json, position) VALUES ('st_1', 'tpl_u', NULL, 1)`).run()).toThrow();
  });
});
