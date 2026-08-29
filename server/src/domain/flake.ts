/** Flake analytics: alternation rate over last N runs per flow; auto-quarantine
 *  when >=3 alternations within 7 days. Roll-up exclusion happens in status.ts. */
import type Database from 'better-sqlite3';

export interface FlowHistoryEntry {
  run_id: string;
  status: string; // step status: pass|fail|skip|error
  started_at: number;
}

export function flowHistory(db: Database.Database, flowKey: string, limit = 10): FlowHistoryEntry[] {
  return db
    .prepare(
      `SELECT rs.run_id, rs.status, r.started_at FROM run_steps rs
       JOIN runs r ON r.id = rs.run_id
       WHERE rs.flow_name = ? AND r.kind IN ('automated','rerun')
         AND (r.note IS NULL OR r.note != 'rehearse')
       ORDER BY r.started_at DESC LIMIT ?`,
    )
    .all(flowKey, limit) as FlowHistoryEntry[];
}

/** alternations = adjacent results differ (pass vs fail/error). skip ignored (not counted as either). */
export function alternationCount(history: FlowHistoryEntry[]): number {
  const seq = history.map((h) => (h.status === 'pass' ? 'pass' : h.status === 'skip' ? null : 'fail')).filter((x) => x !== null) as string[];
  let alt = 0;
  for (let i = 1; i < seq.length; i++) if (seq[i] !== seq[i - 1]) alt++;
  return alt;
}

export function flakeScore(history: FlowHistoryEntry[]): number {
  const seq = history.filter((h) => h.status !== 'skip');
  if (seq.length < 2) return 0;
  return alternationCount(history) / (seq.length - 1);
}

/** Auto-quarantine rule: >=3 alternations AND all within the last 7 days. */
export function shouldAutoQuarantine(history: FlowHistoryEntry[]): boolean {
  const window = history.filter((h) => h.started_at >= Date.now() - 7 * 24 * 3600 * 1000);
  if (window.length < 4) return false; // need >=4 results for 3 alternations
  return alternationCount(window) >= 3;
}

/** Check + apply auto-quarantine for every flow in a just-finished run. Returns quarantined keys. */
export function applyAutoQuarantine(db: Database.Database, runId: string): string[] {
  const flows = db.prepare('SELECT DISTINCT flow_name FROM run_steps WHERE run_id = ?').all(runId) as Array<{ flow_name: string }>;
  const quarantined: string[] = [];
  for (const { flow_name } of flows) {
    if (db.prepare('SELECT 1 FROM flow_quarantine WHERE flow_key = ? AND released_at IS NULL').get(flow_name)) continue;
    const hist = flowHistory(db, flow_name);
    if (shouldAutoQuarantine(hist)) {
      db.prepare(`INSERT OR REPLACE INTO flow_quarantine(flow_key, reason, by, at) VALUES (?, ?, 'auto', ?)`)
        .run(flow_name, `auto: ${alternationCount(hist)} alternations in last ${hist.length} runs`, Date.now());
      quarantined.push(flow_name);
    }
  }
  return quarantined;
}
