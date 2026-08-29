import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrateM1 } from '../src/db/schema.ts';
import { deriveTicketMatrix } from '../src/domain/status.ts';

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrateM1(db);
});

function seedRun(id: string, kind: string, startedAt: number): void {
  db.prepare(
    `INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at)
     VALUES (?, 'CUST-1', ?, 'passed', 'test', 'SIM', ?)`,
  ).run(id, kind, startedAt);
}
function seedAc(runId: string, acId: string, status: string): void {
  db.prepare(
    `INSERT INTO ac_results(run_id, ticket_key, ac_id, ac_text, category, status, flow_names_json, bundle_id)
     VALUES (?, 'CUST-1', ?, 'text', 'interaction', ?, '[]', ?)`,
  ).run(runId, acId, status, runId);
}

describe('deriveTicketMatrix', () => {
  it('no runs → all none, ticket none', () => {
    const m = deriveTicketMatrix(db, 'CUST-9');
    expect(m.ticketStatus).toBe('none');
    expect(m.acs).toHaveLength(0);
  });
  it('latest automated run decides; older runs ignored', () => {
    seedRun('r1', 'automated', 100);
    seedAc('r1', 'AC-1', 'fail');
    seedRun('r2', 'automated', 200);
    seedAc('r2', 'AC-1', 'pass');
    const m = deriveTicketMatrix(db, 'CUST-1');
    expect(m.acs[0]!.status).toBe('pass');
    expect(m.ticketStatus).toBe('pass');
  });
  it('fail in latest → fail rolls up', () => {
    seedRun('r1', 'automated', 100);
    seedAc('r1', 'AC-1', 'pass');
    seedRun('r2', 'automated', 200);
    seedAc('r2', 'AC-1', 'fail');
    const m = deriveTicketMatrix(db, 'CUST-1');
    expect(m.acs[0]!.status).toBe('fail');
    expect(m.ticketStatus).toBe('fail');
  });
  it('MANUAL runs never roll up (structural exclusion)', () => {
    seedRun('r1', 'automated', 100);
    seedAc('r1', 'AC-1', 'fail');
    seedRun('r2', 'manual', 200);
    seedAc('r2', 'AC-1', 'pass');
    const m = deriveTicketMatrix(db, 'CUST-1');
    expect(m.acs[0]!.status).toBe('fail'); // manual pass ignored
    expect(m.acs[0]!.lastRunId).toBe('r1');
  });
  it('rerun kind DOES roll up', () => {
    seedRun('r1', 'automated', 100);
    seedAc('r1', 'AC-1', 'fail');
    seedRun('r2', 'rerun', 200);
    seedAc('r2', 'AC-1', 'pass');
    const m = deriveTicketMatrix(db, 'CUST-1');
    expect(m.acs[0]!.status).toBe('pass');
  });
  it('M1: no amber and no gray statuses returned', () => {
    seedRun('r1', 'automated', 100);
    seedAc('r1', 'AC-1', 'pass');
    const m = deriveTicketMatrix(db, 'CUST-1');
    expect(m.acs.every((a) => a.status !== 'changes-pending' && a.status !== 'quarantined')).toBe(true);
  });
});
