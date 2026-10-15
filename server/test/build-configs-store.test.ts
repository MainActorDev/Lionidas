/** Recipe store (S2): revision chain, active-row law, verify stamping, R1 lazy backfill */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrateBuildConfigs } from '../src/db/schema.ts';
import { activeBuildConfig, writeBuildConfigRevision, listBuildConfigRevisions, stampVerify, backfillBuildConfigFromColumns } from '../src/projects/build-configs.ts';

let db: Database.Database;
let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'recipes-'));
  db = new Database(join(root, 't.db'));
  db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY, name TEXT, repo_url TEXT, local_path TEXT, default_branch TEXT, auth_token TEXT, build_scheme TEXT, build_configuration TEXT, repo_shape TEXT, default_suite_id TEXT, retention INTEGER, created_at INTEGER, updated_at INTEGER);`);
  migrateBuildConfigs(db);
});
afterAll(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

describe('recipe store', () => {
  it('write → active; second write supersedes, chain intact', () => {
    db.prepare("INSERT INTO projects(id) VALUES ('p1')").run();
    const r1 = writeBuildConfigRevision(db, { projectId: 'p1', transport: 'generic', scheme: 'A', configuration: 'Debug', prepare: [{ run: 'x' }], provenance: { by: 'user', at: 1 } });
    expect(activeBuildConfig(db, 'p1')?.id).toBe(r1.id);
    const r2 = writeBuildConfigRevision(db, { projectId: 'p1', transport: 'generic', scheme: 'A2', provenance: { by: 'ai+user', at: 2, evidence: ['repo.read: project.yml'] } });
    expect(r2.revision).toBe(2);
    expect(activeBuildConfig(db, 'p1')?.scheme).toBe('A2');
    const revs = listBuildConfigRevisions(db, 'p1');
    expect(revs).toHaveLength(2);
    expect(revs.find((r) => r.id === r1.id)?.supersededBy).toBe(r2.id);
  });

  it('verify stamps land on the revision (S4 contract)', () => {
    const r = activeBuildConfig(db, 'p1')!;
    stampVerify(db, r.id, 'green', 'BUILD OK 308s');
    expect(activeBuildConfig(db, 'p1')?.verifyState).toBe('green');
    expect(activeBuildConfig(db, 'p1')?.verifiedAt).toBeGreaterThan(0);
  });

  it('R1 lazy backfill: columns → first recipe once, never again', () => {
    db.prepare("INSERT INTO projects(id, build_scheme, build_configuration) VALUES ('p2', 'LegacyScheme', 'Release')").run();
    const r = backfillBuildConfigFromColumns(db, { id: 'p2', build_scheme: 'LegacyScheme', build_configuration: 'Release' });
    expect(r?.scheme).toBe('LegacyScheme');
    expect(r?.provenance.by).toBe('import');
    // second call returns the SAME row (no duplicate revision)
    expect(backfillBuildConfigFromColumns(db, { id: 'p2', build_scheme: 'LegacyScheme', build_configuration: 'Release' })?.id).toBe(r?.id);
    // no columns AND no existing row → no recipe (use a fresh project)
    db.prepare("INSERT INTO projects(id) VALUES ('p3')").run();
    expect(backfillBuildConfigFromColumns(db, { id: 'p3', build_scheme: null, build_configuration: null })).toBeNull();
    // existing row + empty columns → the existing row (no backfire)
    expect(backfillBuildConfigFromColumns(db, { id: 'p1', build_scheme: null, build_configuration: null })?.projectId).toBe('p1');
  });
});

describe('R4: resolution contract — store-driven builds are distinguishable', () => {
  it('resolveBuildConfig prefers root manifest, then the store, then legacy', async () => {
    const { resolveBuildConfig } = await import('../src/projects/builds.ts');
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    // ws WITHOUT any manifest → store row wins
    const ws = mkdtempSync(join(tmpdir(), 'res-'));
    mkdirSync(join(ws, '.git')); // cloned marker
    const none = resolveBuildConfig(db, 'p1', ws);
    expect(none.resolution.from).toBe('recipes'); // p1 has an active row from earlier tests
    expect(none.recipeRevision).toBeGreaterThan(0);
    // root manifest WINS over the store
    writeFileSync(join(ws, 'lionidas.yml'), 'build:\n  scheme: RepoScheme\n  configuration: Debug\n');
    const root = resolveBuildConfig(db, 'p1', ws);
    expect(root.resolution.from).toBe('manifest');
    expect(root.manifest?.scheme).toBe('RepoScheme');
    // project with NO rows at all + legacy .lionidas manifest
    db.prepare("INSERT INTO projects(id) VALUES ('p4')").run();
    const ws2 = mkdtempSync(join(tmpdir(), 'res2-'));
    mkdirSync(join(ws2, '.git'));
    mkdirSync(join(ws2, '.lionidas'), { recursive: true });
    writeFileSync(join(ws2, '.lionidas', 'lionidas.yml'), 'build:\n  scheme: Legacy\n');
    const legacy = resolveBuildConfig(db, 'p4', ws2);
    expect(legacy.resolution.from).toBe('manifest-legacy');
    // nothing anywhere → from: null (discovery is the CALLER's explicit choice)
    const ws3 = mkdtempSync(join(tmpdir(), 'res3-'));
    mkdirSync(join(ws3, '.git'));
    expect(resolveBuildConfig(db, 'p4', ws3).resolution.from).toBeNull();
  });
});

describe('S4: verify flow shape (startBuildVerify guards; compile stubbed at route level)', () => {
  it('NO_RECIPE when the project has no recipe row', async () => {
    const { startBuildVerify } = await import('../src/projects/builds.ts');
    db.prepare("INSERT INTO projects(id, name) VALUES ('p9', 'proj-nine')").run();
    // projectWorkspace needs a name; no recipe row exists → NO_RECIPE before any fs touch
    const r = startBuildVerify(db, 'p9');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('NO_RECIPE');
  });
});

describe('S5: commands + apply-proposal (AI proposes, host disposes)', () => {
  it('both recipe commands registered with HARD STOP + secrets law in instructions', async () => {
    const { COMMANDS } = await import('../src/agent/commands.ts');
    const propose = COMMANDS.find((c) => c.cmd === '/build-config-propose');
    const diagnose = COMMANDS.find((c) => c.cmd === '/build-diagnose');
    expect(propose?.order).toBe(5);
    expect(diagnose?.order).toBe(6);
    for (const c of [propose, diagnose]) {
      expect(c?.instructions).toMatch(/HARD STOP/);
      expect(c?.instructions).toMatch(/NEEDS_SECRETS|HUMAN gate/i);
      expect(c?.instructions).toMatch(/never (write|decide)/i);
    }
  });

  it('apply-proposal writes an ai+user revision with evidence provenance', async () => {
    const row = writeBuildConfigRevision(db, {
      projectId: 'p1', transport: 'generic', scheme: 'FromAI', configuration: 'Debug',
      prepare: [{ run: 'pod install' }],
      provenance: { by: 'ai+user', at: Date.now(), source: 'test', evidence: ['repo.read: project.yml:12'] },
    });
    expect(row.provenance.by).toBe('ai+user');
    expect(row.provenance.evidence).toContain('repo.read: project.yml:12');
    expect(activeBuildConfig(db, 'p1')?.scheme).toBe('FromAI');
  });
});
