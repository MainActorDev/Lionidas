/** Dispatcher loop: head entry → run → executeRun → mark done. 250ms tick.
 *  LEASE_HELD (bypass holder) → backoff ×3 → abort. */
import type Database from 'better-sqlite3';
import type { TypedEventBus, AppEvents } from '../ws/bus.ts';
import { nextDispatchable, markDispatched, markDone, backoffOrAbort, type QueueRow, type QueueSpec } from './store.ts';
import { executeRun, type RunnerDeps } from '../alloy/runner.ts';

export interface DispatcherDeps extends RunnerDeps {
  db: Database.Database;
  bus: TypedEventBus<AppEvents>;
}

const attempts = new Map<string, number>();

export async function dispatchTick(deps: DispatcherDeps): Promise<boolean> {
  const row = nextDispatchable(deps.db) as QueueRow | null;
  if (!row) return false;
  const spec = JSON.parse(row.spec_json) as QueueSpec;
  try {
    markDispatched(deps.db, row.id, `pending-${row.id}`); // linked immediately; runId patch below
    const runId = await executeRun(
      {
        ticketKey: spec.ticketKey,
        flowsDir: spec.flowsDir,
        udid: spec.udid,
        app: spec.app,
        artifactPath: spec.artifactPath,
        ...(spec.srcPath !== undefined ? { srcPath: spec.srcPath } : {}),
        ...(spec.launchArgs !== undefined ? { launchArgs: spec.launchArgs } : {}),
        triggeredBy: spec.triggeredBy,
        ...(spec.triage !== undefined ? { triage: spec.triage } : {}),
        ...(spec.kind !== undefined ? { kind: spec.kind } : {}),
        ...(spec.parentRunId !== undefined ? { parentRunId: spec.parentRunId } : {}),
      },
      deps,
    );
    deps.db.prepare(`UPDATE queue SET dispatched_run_id = ? WHERE id = ?`).run(runId, row.id);
    markDone(deps.db, row.id);
    attempts.delete(row.id);
    deps.bus.emit('run.queued', { runId, queueId: row.id }); // completion signal for queue watchers
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('LEASE_HELD')) {
      const outcome = backoffOrAbort(deps.db, row.id, attempts);
      if (outcome === 'aborted') deps.bus.emit('run.aborted', { queueId: row.id });
      return true;
    }
    // hard failure: mark done (the run row inside executeRun already failed) or abort if no run row
    markDone(deps.db, row.id);
    return true;
  }
}

export function startDispatcher(deps: DispatcherDeps, intervalMs = 250): () => void {
  const timer = setInterval(() => {
    dispatchTick(deps).catch(() => undefined);
  }, intervalMs);
  return () => clearInterval(timer);
}
