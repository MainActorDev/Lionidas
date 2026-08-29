/** Queue store: SQLite-backed FIFO with priority classes (PLAN §8).
 *  manual(0) > scheduled(1) > agent(2); FIFO in class; starvation guard. */
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export type QueuePriority = 0 | 1 | 2;

export interface QueueSpec {
  ticketKey: string;
  flowsDir: string;
  udid: string;
  app: string;
  artifactPath: string;
  srcPath?: string;
  launchArgs?: string[];
  triggeredBy: string;
  triage?: boolean;
  kind?: 'automated' | 'rerun';
  parentRunId?: string;
}

export interface QueueRow {
  id: string;
  spec_json: string;
  priority: number;
  state: 'waiting' | 'dispatched' | 'done' | 'aborted';
  requested_by: string;
  enqueued_at: number;
  dispatched_run_id: string | null;
}

export function enqueue(db: Database.Database, spec: QueueSpec, requestedBy: string, priority: QueuePriority): string {
  const id = `q_${randomUUID().slice(0, 8)}`;
  db.prepare(
    `INSERT INTO queue(id, spec_json, priority, state, requested_by, enqueued_at)
     VALUES (?, ?, ?, 'waiting', ?, ?)`,
  ).run(id, JSON.stringify(spec), priority, requestedBy, Date.now());
  return id;
}

/** Next dispatchable entry: priority asc, enqueued asc, whose device has no
 *  active run AND whose priority class isn't starved out (manual waiting >60s
 *  defers agent entries for that device). */
export function nextDispatchable(db: Database.Database): QueueRow | null {
  const waiting = db
    .prepare(`SELECT * FROM queue WHERE state = 'waiting' ORDER BY priority ASC, enqueued_at ASC`)
    .all() as QueueRow[];
  if (waiting.length === 0) return null;

  const busy = new Set(
    (db.prepare(`SELECT device_udid FROM runs WHERE status IN ('queued','running')`).all() as Array<{ device_udid: string }>).map((r) => r.device_udid),
  );

  const now = Date.now();
  const starvingManual = waiting.some(
    (w) => w.priority === 0 && now - w.enqueued_at > 60_000 && !busy.has((JSON.parse(w.spec_json) as QueueSpec).udid),
  );

  for (const w of waiting) {
    const spec = JSON.parse(w.spec_json) as QueueSpec;
    if (busy.has(spec.udid)) continue;
    if (starvingManual && w.priority === 2) continue; // agent yields
    return w;
  }
  return null;
}

export function markDispatched(db: Database.Database, queueId: string, runId: string): void {
  db.prepare(`UPDATE queue SET state = 'dispatched', dispatched_run_id = ? WHERE id = ?`).run(runId, queueId);
}

export function markDone(db: Database.Database, queueId: string): void {
  db.prepare(`UPDATE queue SET state = 'done' WHERE id = ?`).run(queueId);
}

export function abort(db: Database.Database, queueId: string): boolean {
  const r = db.prepare(`UPDATE queue SET state = 'aborted' WHERE id = ? AND state = 'waiting'`).run(queueId);
  return r.changes > 0;
}

export function backoffOrAbort(db: Database.Database, queueId: string, attempts: Map<string, number>): 'requeued' | 'aborted' {
  const n = (attempts.get(queueId) ?? 0) + 1;
  attempts.set(queueId, n);
  if (n >= 3) {
    db.prepare(`UPDATE queue SET state = 'aborted' WHERE id = ?`).run(queueId);
    return 'aborted';
  }
  const delays = [5000, 15000, 45000] as const;
  db.prepare(`UPDATE queue SET enqueued_at = enqueued_at + ? WHERE id = ?`).run(delays[n - 1] ?? 45000, queueId);
  db.prepare(`UPDATE queue SET state = 'waiting' WHERE id = ?`).run(queueId);
  return 'requeued';
}
