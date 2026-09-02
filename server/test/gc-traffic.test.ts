import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrateM1 } from '../src/db/schema.ts';
import { gcTrafficBodies, TRAFFIC_BODY_DAYS } from '../src/gc/retention.ts';

/** B7: traffic_bodies retention — age cap with reference keep. A body is
 *  deletable only when it is older than the window AND no surviving traffic
 *  row still references it (run detail opens bodies via req_sha/res_sha). */

let db: Database.Database;
const DAY = 24 * 3600 * 1000;

beforeEach(() => {
  db = new Database(':memory:');
  migrateM1(db);
});
afterEach(() => db.close());

function addBody(sha: string, ageDays: number): void {
  db.prepare('INSERT INTO traffic_bodies(sha, content_type, body, bytes, first_seen) VALUES (?, ?, ?, 1, ?)')
    .run(sha, 'application/json', Buffer.from('{}'), Date.now() - ageDays * DAY);
}
function addTraffic(id: string, reqSha: string | null, resSha: string | null, ageDays: number): void {
  db.prepare('INSERT INTO traffic(id, run_id, ts, mode, method, host, path, matched_preset_id, status, latency_ms, req_sha, res_sha) VALUES (?, NULL, ?, ?, ?, ?, ?, NULL, 200, 1, ?, ?)')
    .run(id, Date.now() - ageDays * DAY, 'mitm-hybrid', 'GET', 'x.test', '/x', reqSha, resSha);
}

describe('gcTrafficBodies (B7)', () => {
  it('deletes old bodies nothing references', () => {
    addBody('old_orphan', TRAFFIC_BODY_DAYS + 5);
    const r = gcTrafficBodies(db, Date.now());
    expect(r.deleted).toBe(1);
    expect(db.prepare('SELECT COUNT(*) c FROM traffic_bodies WHERE sha = ?').get('old_orphan')).toMatchObject({ c: 0 });
  });

  it('keeps old bodies still referenced by a recent traffic row', () => {
    addBody('old_kept', TRAFFIC_BODY_DAYS + 5);
    addTraffic('t1', 'old_kept', null, 1); // traffic row is recent
    gcTrafficBodies(db, Date.now());
    expect(db.prepare('SELECT COUNT(*) c FROM traffic_bodies WHERE sha = ?').get('old_kept')).toMatchObject({ c: 1 });
  });

  it('deletes an old body referenced only by an OLD traffic row', () => {
    addBody('old_both', TRAFFIC_BODY_DAYS + 5);
    addTraffic('t2', 'old_both', null, TRAFFIC_BODY_DAYS + 5); // reference itself expired
    gcTrafficBodies(db, Date.now());
    expect(db.prepare('SELECT COUNT(*) c FROM traffic_bodies WHERE sha = ?').get('old_both')).toMatchObject({ c: 0 });
  });

  it('never deletes fresh bodies regardless of references', () => {
    addBody('fresh', 1);
    gcTrafficBodies(db, Date.now());
    expect(db.prepare('SELECT COUNT(*) c FROM traffic_bodies WHERE sha = ?').get('fresh')).toMatchObject({ c: 1 });
  });

  it('count cap: oldest first beyond the row cap', () => {
    for (let i = 0; i < 25; i++) addBody(`cap_${String(i).padStart(3, '0')}`, 2); // all fresh-ish
    const r = gcTrafficBodies(db, Date.now(), 10); // cap 10
    expect(r.deleted).toBe(15);
    // the YOUNGEST 10 survive (highest first_seen)
    const kept = (db.prepare('SELECT sha FROM traffic_bodies ORDER BY sha DESC').all() as Array<{ sha: string }>).map((x) => x.sha);
    expect(kept).toHaveLength(10);
    expect(kept[0]).toBe('cap_024'); // newest inserted = youngest
  });
});
