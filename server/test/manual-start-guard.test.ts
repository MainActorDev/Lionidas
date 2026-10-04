import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

/** startManualSession's QUEUE_ACTIVE guard must block on TESTCASE runs
 *  (template_id set — incl. cockpit plays, which carry kind=manual) and NOT
 *  on bare manual-session rows (template_id NULL). */

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE runs (id TEXT PRIMARY KEY, ticket_key TEXT, kind TEXT, status TEXT, triggered_by TEXT, device_udid TEXT, started_at INTEGER, finished_at INTEGER, note TEXT, template_id TEXT);`);
  return db;
}

// the guard is inline in startManualSession; exercise the QUERY shape directly
// (the full function needs engine dispatch — the guard is a pure DB predicate)
const GUARD_SQL = `SELECT 1 FROM runs WHERE device_udid = ? AND status IN ('queued','running') AND template_id IS NOT NULL LIMIT 1`;

describe('manual start guard', () => {
  it('blocks while a template run (testcase) holds the device — even kind=manual', () => {
    const db = makeDb();
    db.prepare(`INSERT INTO runs(id, kind, status, device_udid, template_id) VALUES ('r1', 'manual', 'running', 'SIM-G', 'tpl_x')`).run();
    expect(db.prepare(GUARD_SQL).get('SIM-G')).toBeTruthy();
  });
  it('does NOT block on bare manual-session rows', () => {
    const db = makeDb();
    db.prepare(`INSERT INTO runs(id, kind, status, device_udid, template_id, note) VALUES ('r2', 'manual', 'running', 'SIM-G', NULL, 'manual:ms_1')`).run();
    expect(db.prepare(GUARD_SQL).get('SIM-G')).toBeUndefined();
  });
  it('does not block on finished runs', () => {
    const db = makeDb();
    db.prepare(`INSERT INTO runs(id, kind, status, device_udid, template_id) VALUES ('r3', 'batch', 'passed', 'SIM-G', 'tpl_x')`).run();
    expect(db.prepare(GUARD_SQL).get('SIM-G')).toBeUndefined();
  });
});
