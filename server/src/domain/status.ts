/** Pure status derivation (PLAN §2): computed, never stored. */
import type Database from 'better-sqlite3';

export type AcStatus = 'pass' | 'fail' | 'skip' | 'changes-pending' | 'quarantined' | 'none';

export interface AcRow {
  ac_id: string;
  ac_text: string;
  category: string;
}

/** Latest automated results per AC. Manual NEVER rolls up (structural).
 *  M1: no amber (baselines are M2) and no gray (quarantine is M3). */
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

  const acs = acRows.map((ac) => {
    const rows = latestRows.filter((x) => x.ac_id === ac.ac_id);
    if (rows.length === 0) return { ...ac, status: 'none' as AcStatus, lastRunId: null, flows: [] };
    // AND over the latest-run rows for this AC (single run ⇒ single row; PK run+ac)
    const anyFail = rows.some((r) => r.status === 'fail');
    const allSkip = rows.every((r) => r.status === 'skip');
    const status: AcStatus = anyFail ? 'fail' : allSkip ? 'skip' : 'pass';
    const flows = rows.flatMap((r) => JSON.parse(r.flows) as string[]);
    return { ...ac, status, lastRunId: rows[0]!.run_id, flows };
  });

  const ticketStatus: 'pass' | 'fail' | 'none' =
    acs.length === 0 ? 'none' : acs.some((a) => a.status === 'fail') ? 'fail' : 'pass';
  return { acs, ticketStatus };
}
