/** Pure status derivation (PLAN §2): computed, never stored. */
import type Database from 'better-sqlite3';

export type AcStatus = 'pass' | 'fail' | 'skip' | 'changes-pending' | 'quarantined' | 'none';

export interface AcRow {
  ac_id: string;
  ac_text: string;
  category: string;
}

/** Latest automated results per AC. Manual NEVER rolls up (structural).
 *  M2: amber (changes-pending) is live — any pending baseline diff for an AC's
 *  flow scopes turns the AC amber (needs judgment, neither green nor red).
 *  Gray (quarantine) arrives in M3. */
export function deriveTicketMatrix(db: Database.Database, ticketKey: string): {
  acs: Array<AcRow & { status: AcStatus; lastRunId: string | null; flows: string[] }>;
  ticketStatus: 'pass' | 'fail' | 'none';
} {
  const acRows = db
    .prepare(
      `SELECT ac_id, ac_text, category FROM ac_results
       WHERE ticket_key = ? GROUP BY ac_id
       ORDER BY ac_id`,
    )
    .all(ticketKey) as AcRow[];

  const latestStmt = db.prepare(
    `SELECT r.ac_id AS ac_id, r.status AS status, r.run_id AS run_id, r.flow_names_json AS flows
     FROM ac_results r
     JOIN runs run ON run.id = r.run_id
     WHERE r.ticket_key = ? AND run.kind IN ('automated','rerun')
     AND run.started_at = (
       SELECT MAX(run2.started_at) FROM ac_results r2
       JOIN runs run2 ON run2.id = r2.run_id
       WHERE r2.ticket_key = r.ticket_key AND r2.ac_id = r.ac_id
         AND run2.kind IN ('automated','rerun')
     )`,
  );
  const latestRows = latestStmt.all(ticketKey) as Array<{
    ac_id: string;
    status: string;
    run_id: string;
    flows: string;
  }>;

  const pendingScopes = new Set(
    (db.prepare(`SELECT scope_key FROM baseline_diffs WHERE state = 'pending'`).all() as Array<{ scope_key: string }>).map((r) => r.scope_key),
  );

  const acs = acRows.map((ac) => {
    const rows = latestRows.filter((x) => x.ac_id === ac.ac_id);
    if (rows.length === 0) return { ...ac, status: 'none' as AcStatus, lastRunId: null, flows: [] };
    const anyFail = rows.some((r) => r.status === 'fail');
    const allSkip = rows.every((r) => r.status === 'skip');
    const flows = rows.flatMap((r) => JSON.parse(r.flows) as string[]);
    // amber: pending baseline decision on any of this AC's flow scopes
    const amber = flows.some((f) => pendingScopes.has(f));
    const status: AcStatus = amber ? 'changes-pending' : anyFail ? 'fail' : allSkip ? 'skip' : 'pass';
    return { ...ac, status, lastRunId: rows[0]!.run_id, flows };
  });

  const ticketStatus: 'pass' | 'fail' | 'none' =
    acs.length === 0 ? 'none' : acs.some((a) => a.status === 'fail') ? 'fail' : 'pass';
  return { acs, ticketStatus }; // amber does not fail a ticket (blocked ≠ failed)

}
