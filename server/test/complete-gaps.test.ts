/** Complete-plan gap tests: auth gate, retention GC, boot reconciliation, quota pause. */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateM1 } from '../src/db/schema.ts';
import { runGc, diskState } from '../src/gc/retention.ts';
import type { AppEvents } from '../src/ws/bus.ts';
import { hasAlloy } from './helpers/capabilities.ts';
const describeIfAlloy = describe.skipIf(!(hasAlloy()));

let db: Database.Database;
let artDir: string;

beforeEach(() => {
  db = new Database(':memory:');
  migrateM1(db);
  artDir = mkdtempSync(join(tmpdir(), 'gc-'));
});
afterEach(() => rmSync(artDir, { recursive: true, force: true }));

function seedRun(id: string, status: string, ageDays: number): string {
  db.prepare(`INSERT INTO runs(id,ticket_key,kind,status,triggered_by,device_udid,started_at,finished_at) VALUES (?,'T','automated',?,'t','SIM',?,?)`)
    .run(id, status, Date.now() - ageDays * 86400_000, Date.now() - ageDays * 86400_000 + 1000);
  return id;
}
function seedEvidence(runId: string, path: string, bytes: number, ageDays: number): void {
  writeFileSync(path, 'x'.repeat(bytes));
  db.prepare(`INSERT INTO evidence(id,bundle_id,type,path,sha256,bytes,moov_ok,created_at) VALUES (?,?,?,?,?,?,NULL,?)`)
    .run(`ev_${path.length}_${ageDays}`, runId, 'screenshot', path, `sha-${path}`, bytes, Date.now() - ageDays * 86400_000);
}

describe('retention GC (§11)', () => {
  it('success evidence older than 14d is deleted with its file', () => {
    const run = seedRun('r1', 'passed', 30);
    const f = join(artDir, 'a.png');
    seedEvidence(run, f, 1000, 30);
    const rep = runGc(db, artDir);
    expect(rep.deletedEvidence).toBe(1);
    expect(rep.deletedFiles).toBe(1);
    expect(() => statSync(f)).toThrow();
  });
  it('failure evidence kept under 180d (no Jira fallback)', () => {
    const run = seedRun('r2', 'failed', 90);
    seedEvidence(run, join(artDir, 'b.png'), 1000, 90);
    const rep = runGc(db, artDir);
    expect(rep.deletedEvidence).toBe(0);
  });
  it('failure evidence older than 180d is deleted', () => {
    const run = seedRun('r3', 'failed', 200);
    const f = join(artDir, 'c.png');
    seedEvidence(run, f, 1000, 200);
    const rep = runGc(db, artDir);
    expect(rep.deletedEvidence).toBe(1);
  });
  it('fresh success kept (within 14d)', () => {
    const run = seedRun('r4', 'passed', 5);
    seedEvidence(run, join(artDir, 'd.png'), 1000, 5);
    expect(runGc(db, artDir).deletedEvidence).toBe(0);
  });
  it('dedup: shared file only deleted when last reference goes', () => {
    const r1 = seedRun('r5', 'passed', 30);
    const shared = join(artDir, 'shared.png');
    seedEvidence(r1, shared, 500, 30);
    const r2 = seedRun('r6', 'failed', 30);
    // second row referencing the SAME file path (dedup case)
    db.prepare(`INSERT INTO evidence(id,bundle_id,type,path,sha256,bytes,moov_ok,created_at) VALUES ('ev2',?,'diff',?,'sha2',500,NULL,?)`)
      .run(r2, shared, Date.now() - 30 * 86400_000);
    const rep = runGc(db, artDir); // r1's row expires (success 30d); r2's stays (failure)
    expect(rep.deletedEvidence).toBe(1);
    expect(rep.deletedFiles).toBe(0); // still referenced by r2
    expect(() => statSync(shared)).not.toThrow();
  });
});

describe('disk quota (§12/§11)', () => {
  it('diskState reflects warn/pause thresholds', () => {
    const s = diskState(artDir);
    expect(s.paused).toBe(false);
    expect(s.warn).toBe(false);
  });
});

// auth gate (§16.3) tests retired with the PIN gate — roles.ts owns auth now (test/auth.test.ts)

// capability gate: needs the alloy runtime (scripts/setup.sh)
describeIfAlloy('boot reconciliation (M1 §5)', () => {
  it('stale waiting queue rows aborted; stuck runs aborted', async () => {
    db.prepare(`INSERT INTO queue(id,spec_json,priority,state,requested_by,enqueued_at) VALUES ('q1','{}',0,'waiting','t',1)`).run();
    db.prepare(`INSERT INTO runs(id,ticket_key,kind,status,triggered_by,device_udid,started_at) VALUES ('r9','T','automated','running','t','SIM-1',1)`).run();
    const { bootReconcile } = await import('../src/alloy/reconcile.ts');
    const { createEventBus } = await import('../src/ws/bus.ts');
    const bus = createEventBus<AppEvents>();
    // stub alloy release via module mock is heavy; call with a stub dispatch deps
    // that returns ok — reconcile treats alloy as a black box via crucibleAlloy,
    // so we assert the DB-side effects only when no device rows exist (SIM-1 not
    // in devices ⇒ release loop skipped)
    db.prepare('DELETE FROM devices').run();
    const rep = await bootReconcile(db, bus, {});
    expect(rep.queueAborted).toBe(1);
    const q = db.prepare('SELECT state FROM queue WHERE id = ?').get('q1') as { state: string };
    expect(q.state).toBe('aborted');
    const r = db.prepare('SELECT status FROM runs WHERE id = ?').get('r9') as { status: string };
    expect(r.status).toBe('aborted');
  });
});
