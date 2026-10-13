/** Mention-palette Stage A tests: unified local-tier search. */

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fuzzyScore, searchLocalRefs } from '../src/agent/mention-search.ts';

let dir: string;
let db: Database.Database;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mention-'));
  db = new Database(':memory:');
  db.exec(`CREATE TABLE templates(id TEXT PRIMARY KEY, name TEXT, status TEXT, app_bundle_id TEXT, tags_json TEXT)`);
  db.exec(`CREATE TABLE agent_attachments(id TEXT PRIMARY KEY, file_name TEXT NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT 'x')`);
  db.prepare("INSERT INTO templates VALUES ('c1','login_flow_ok','active','com.lionparcel.consumer','[]')").run();
  db.prepare("INSERT INTO templates VALUES ('c2','tracking_milestone_labels','draft','com.lionparcel.consumer','[]')").run();
  db.prepare("INSERT INTO templates VALUES ('c3','guest_checkout_voucher','active','com.lionparcel.consumer','[]')").run();
  db.prepare("INSERT INTO agent_attachments VALUES ('a1','milestone_config.json',2148,'sha','json','2026-10-13')").run();
  // a real git repo in cwd/repos/fixture so repo search finds commits
  const repo = join(dir, 'repos', 'fixture-repo');
  db.exec('CREATE TABLE dummy(x)'); void repo;
  execFileSync('mkdir', ['-p', repo]);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'feat: milestone stepper', '--allow-empty'], { cwd: repo });
});

afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

// ctx built lazily — `db` assigns in beforeAll, module-load capture would see undefined
const ctxOf = () => ({ db: db! }) as unknown as Parameters<typeof searchLocalRefs>[0];

describe('fuzzyScore', () => {
  it('subsequence matching with run bonus; null on miss', () => {
    expect(fuzzyScore('cust', 'CUST-6223 milestone')).not.toBeNull();
    expect(fuzzyScore('zzz', 'CUST-6223')).toBeNull();
    expect(fuzzyScore('', 'anything')).toBe(1);
  });
});

describe('searchLocalRefs (local tier)', () => {
  it('empty q → recent-ish sample across kinds', async () => {
    const rows = await searchLocalRefs(ctxOf(), '');
    expect(rows.some((r) => r.kind === 'case')).toBe(true);
    expect(rows.some((r) => r.kind === 'file')).toBe(true);
    expect(rows.length).toBeLessThanOrEqual(16);
  });

  it('case fuzzy: "milestone" finds the tracking case + the attachment, both wire-shaped', async () => {
    const rows = await searchLocalRefs(ctxOf(), 'milestone');
    const caseHit = rows.find((r) => r.kind === 'case' && r.id === 'case:c2');
    expect(caseHit).toBeTruthy();
    expect(caseHit!.ref).toEqual({ kind: 'case', locator: 'c2' });
    expect(rows.find((r) => r.kind === 'file' && r.title === 'milestone_config.json')).toBeTruthy();
  });

  it('caps: 6 per kind, 16 total', async () => {
    for (let i = 0; i < 30; i++) db.prepare(`INSERT INTO templates VALUES ('cx${i}','padding_case_${i}','active',NULL,'[]')`).run();
    const rows = await searchLocalRefs(ctxOf(), 'padding_case');
    expect(rows.filter((r) => r.kind === 'case').length).toBeLessThanOrEqual(6);
    expect(rows.length).toBeLessThanOrEqual(16);
  });

  it('empty db tables do not throw (honest empty)', async () => {
    const bare = { db: new Database(':memory:') } as unknown as Parameters<typeof searchLocalRefs>[0];
    const rows = await searchLocalRefs(bare, 'anything');
    expect(Array.isArray(rows)).toBe(true);
  });
});
