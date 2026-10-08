import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrateM1 } from '../src/db/schema.ts';
import { enforceRetention } from '../src/projects/retention.ts';
import { secretStatus, envGithubToken, GITHUB_TOKEN_ENV, JIRA_TOKEN_ENV } from '../src/secrets.ts';

let dir: string;
let db: Database.Database;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ret-'));
  db = new Database(':memory:');
  migrateM1(db);
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

function mkProject(name: string, retention: number | null): string {
  const id = `prj_${name}`;
  db.prepare(`INSERT INTO projects(id, name, repo_url, created_at, updated_at${retention !== null ? ', retention' : ''}) VALUES (?, ?, 'https://x/y.git', 0, 0${retention !== null ? ', ?' : ''})`)
    .run(...(retention !== null ? [id, name, retention] : [id, name]));
  return id;
}

function mkBuild(pid: string, n: number, status: 'passed' | 'failed'): { id: string; path: string } {
  const id = `bld_${n}`;
  const path = join(dir, `art-${n}.ipa`);
  writeFileSync(path, `fake ${n}`);
  db.prepare(`INSERT INTO builds(id, project_id, number, status, transport, started_at, artifact_path) VALUES (?, ?, ?, ?, 'generic', ?, ?)`)
    .run(id, pid, n, status, n * 1000, path);
  db.prepare('INSERT INTO package_owner(package_path, project_id) VALUES (?, ?)').run(path, pid);
  return { id, path };
}

describe('retention (T1)', () => {
  it('keeps newest N; deletes file + claim; row stays with nulled path', () => {
    const pid = mkProject('a', 3);
    const builds = [1, 2, 3, 4, 5].map((n) => mkBuild(pid, n, n === 2 ? 'failed' : 'passed'));
    const reports = enforceRetention(db, pid);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.deleted).toEqual([builds[1]!.path, builds[0]!.path]); // oldest two
    expect(existsSync(builds[0]!.path)).toBe(false);
    expect(existsSync(builds[4]!.path)).toBe(true);
    // rows all survive; deleted ones have NULL artifact_path
    const rows = db.prepare('SELECT id, artifact_path FROM builds WHERE project_id = ? ORDER BY number').all(pid) as Array<{ id: string; artifact_path: string | null }>;
    expect(rows).toHaveLength(5);
    expect(rows[0]!.artifact_path).toBeNull();
    expect(rows[4]!.artifact_path).toBeTruthy();
    // claims died with the files
    const claims = db.prepare('SELECT COUNT(*) AS c FROM package_owner').get() as { c: number };
    expect(claims.c).toBe(3);
  });

  it('evidence immunity: run-referenced builds survive beyond N', () => {
    const pid = mkProject('b', 2);
    const b1 = mkBuild(pid, 1, 'passed');
    mkBuild(pid, 2, 'passed');
    mkBuild(pid, 3, 'passed');
    mkBuild(pid, 4, 'passed');
    // a run points at build #1 (the oldest — beyond N)
    db.prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at, build_id) VALUES ('r1', 'X', 'manual', 'passed', 't', 'u', 1, ?)`).run(b1.id);
    enforceRetention(db, pid);
    const row = db.prepare('SELECT artifact_path FROM builds WHERE id = ?').get(b1.id) as { artifact_path: string | null };
    expect(row.artifact_path).toBeTruthy(); // immune
    expect(existsSync(b1.path)).toBe(true);
  });

  it('newest passing survives even when all newest are failed', () => {
    const pid = mkProject('c', 1);
    const old = mkBuild(pid, 1, 'passed');
    mkBuild(pid, 2, 'failed');
    mkBuild(pid, 3, 'failed');
    enforceRetention(db, pid);
    // N=1 keeps #3 (newest); newest PASSING is #1 — immune too
    expect(existsSync(old.path)).toBe(true);
    const kept = db.prepare('SELECT COUNT(*) AS c FROM builds WHERE project_id = ? AND artifact_path IS NOT NULL').get(pid) as { c: number };
    expect(kept.c).toBe(2);
  });

  it('default 10 when retention NULL', () => {
    const pid = mkProject('d', null);
    for (let n = 1; n <= 12; n++) mkBuild(pid, n, 'passed');
    const reports = enforceRetention(db, pid);
    expect(reports[0]!.deleted).toHaveLength(2); // 12 − 10
  });

  it('retention 0 keeps only immune set', () => {
    const pid = mkProject('e', 0);
    const b1 = mkBuild(pid, 1, 'passed');
    enforceRetention(db, pid);
    // newest passing is immune even at 0
    expect(existsSync(b1.path)).toBe(true);
  });
});

describe('env secrets (T3)', () => {
  it('status is presence-only; values never surface', () => {
    const env = { [GITHUB_TOKEN_ENV]: 'ghp_secret_value', [JIRA_TOKEN_ENV]: '' } as NodeJS.ProcessEnv;
    const st = secretStatus(env);
    expect(st).toEqual({ githubToken: true, jiraToken: false, keys: { githubToken: GITHUB_TOKEN_ENV, jiraToken: JIRA_TOKEN_ENV } });
    expect(JSON.stringify(st)).not.toContain('ghp_secret_value');
  });

  it('envGithubToken: value when set, null when absent/empty', () => {
    expect(envGithubToken({ [GITHUB_TOKEN_ENV]: 'tok' } as NodeJS.ProcessEnv)).toBe('tok');
    expect(envGithubToken({} as NodeJS.ProcessEnv)).toBeNull();
    expect(envGithubToken({ [GITHUB_TOKEN_ENV]: '' } as NodeJS.ProcessEnv)).toBeNull();
  });
});

// keep imports referenced
void mkdirSync; void rmSync; void writeFileSync;
