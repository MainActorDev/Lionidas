/** Quarantine roll-up: gray + excluded; manual runs never roll up; rehearse excluded. */
import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrateM1 } from '../src/db/schema.ts';
import { deriveTicketMatrix } from '../src/domain/status.ts';

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  migrateM1(db);
});

function run(id: string, kind: string, t: number, note: string | null = null): void {
  db.prepare(`INSERT INTO runs(id,ticket_key,kind,status,triggered_by,device_udid,started_at,note) VALUES (?,'T1',?,'passed','t','SIM',?,?)`).run(id, kind, t, note);
}
function ac(runId: string, acId: string, status: string, flows: string[]): void {
  db.prepare(`INSERT INTO ac_results(run_id,ticket_key,ac_id,ac_text,category,status,flow_names_json,bundle_id) VALUES (?,'T1',?,'x','interaction',?,?,?)`)
    .run(runId, acId, status, JSON.stringify(flows), runId);
}

describe('quarantine + roll-up', () => {
  it('quarantined flow → AC gray (quarantined), excluded from ticket fail', () => {
    run('r1', 'automated', 100);
    ac('r1', 'AC-1', 'fail', ['flaky-flow']);
    db.prepare(`INSERT INTO flow_quarantine(flow_key,reason,by,at) VALUES ('flaky-flow','test','qa',?)`).run(Date.now());
    const m = deriveTicketMatrix(db, 'T1');
    expect(m.acs[0]!.status).toBe('quarantined');
    expect(m.ticketStatus).toBe('pass'); // nothing live failing
  });
  it('un-quarantine (release) restores normal roll-up', () => {
    run('r1', 'automated', 100);
    ac('r1', 'AC-1', 'fail', ['flaky-flow']);
    db.prepare(`INSERT INTO flow_quarantine(flow_key,reason,by,at,released_by,released_at) VALUES ('flaky-flow','t','qa',?, 'qa', ?)`).run(Date.now() - 1000, Date.now());
    const m = deriveTicketMatrix(db, 'T1');
    expect(m.acs[0]!.status).toBe('fail');
  });
  it('mixed AC: one quarantined flow + one live flow → AND over live only', () => {
    run('r1', 'automated', 100);
    ac('r1', 'AC-1', 'pass', ['flaky', 'solid']);
    db.prepare(`INSERT INTO flow_quarantine(flow_key,reason,by,at) VALUES ('flaky','x','qa',?)`).run(Date.now());
    const m = deriveTicketMatrix(db, 'T1');
    expect(m.acs[0]!.status).toBe('pass'); // 'solid' pass decides
  });
  it('manual + rehearse runs never roll up', () => {
    run('r1', 'automated', 100);
    ac('r1', 'AC-1', 'fail', ['f']);
    run('r2', 'manual', 200);
    ac('r2', 'AC-1', 'pass', ['f']);
    run('r3', 'automated', 300, 'rehearse');
    ac('r3', 'AC-1', 'pass', ['f']);
    const m = deriveTicketMatrix(db, 'T1');
    expect(m.acs[0]!.status).toBe('fail'); // only r1 counts
  });
});
