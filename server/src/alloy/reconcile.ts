/** Boot reconciliation (M1 §5): engine device claims survive orchestrator
 *  crashes as host-global files — without this cleanup, devices read
 *  DEVICE_IN_USE forever. On boot: close sessions not owned by an active run,
 *  abort stale waiting queue rows. */
import type Database from 'better-sqlite3';
import type { TypedEventBus, AppEvents } from '../ws/bus.ts';
import { crucibleAlloy } from '../alloy/client.ts';

export interface ReconcileReport {
  sessionsClosed: number;
  queueAborted: number;
  deviceClaimsCleared: number;
}

export async function bootReconcile(db: Database.Database, bus: TypedEventBus<AppEvents>, dispatchDeps: unknown): Promise<ReconcileReport> {
  const report: ReconcileReport = { sessionsClosed: 0, queueAborted: 0, deviceClaimsCleared: 0 };
  const alloy = crucibleAlloy();

  // 1. abort stale waiting queue rows (enqueued before this boot)
  const stale = db.prepare(`SELECT id FROM queue WHERE state = 'waiting'`).all() as Array<{ id: string }>;
  for (const { id } of stale) {
    db.prepare(`UPDATE queue SET state = 'aborted' WHERE id = ?`).run(id);
    report.queueAborted++;
    bus.emit('queue.changed', { queueId: id, state: 'aborted' });
  }

  // 2. any run stuck 'running'/'queued' from a previous process → aborted
  const stuck = db.prepare(`SELECT id, device_udid FROM runs WHERE status IN ('running','queued')`).all() as Array<{ id: string; device_udid: string }>;
  for (const r of stuck) {
    db.prepare(`UPDATE runs SET status = 'aborted', finished_at = ? WHERE id = ?`).run(Date.now(), r.id);
  }

  // 3. close orphaned engine sessions (release clears alloy leases + engine
  //    claims for every device we had open)
  const touched = new Set<string>();
  for (const r of stuck) touched.add(r.device_udid);
  for (const udid of touched) {
    const res = (await alloy.dispatch('alloy_release', { udid }, dispatchDeps)) as { ok: boolean };
    if (res.ok) report.sessionsClosed++;
    // clear the mirror lease state
    db.prepare(`UPDATE devices SET lease_holder = NULL, lease_engine = NULL WHERE udid = ?`).run(udid);
    report.deviceClaimsCleared++;
  }

  // 4. manual sessions left open by a dead process → finished
  const orphanManual = db.prepare('SELECT id FROM manual_sessions WHERE finished_at IS NULL').all() as Array<{ id: string }>;
  for (const { id } of orphanManual) {
    db.prepare('UPDATE manual_sessions SET finished_at = ? WHERE id = ?').run(Date.now(), id);
  }

  return report;
}
