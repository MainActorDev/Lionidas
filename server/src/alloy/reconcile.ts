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
  buildsFailed: number;
}

export async function bootReconcile(db: Database.Database, bus: TypedEventBus<AppEvents>, dispatchDeps: unknown): Promise<ReconcileReport> {
  const report: ReconcileReport = { sessionsClosed: 0, queueAborted: 0, deviceClaimsCleared: 0, buildsFailed: 0 };
  // lazy: the alloy client is only needed when device rows exist; building it eagerly
  // throws on machines with no alloy repo (CI) and the reconcile of DB-only state
  // (queue, runs, builds) must never depend on an external tool being configured.
  let alloy: ReturnType<typeof crucibleAlloy> | null = null;
  const getAlloy = () => (alloy ??= crucibleAlloy());

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
    const res = (await getAlloy().dispatch('alloy_release', { udid }, dispatchDeps)) as { ok: boolean };
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

  // 5. builds stuck 'running' from a previous process → failed. The build
  //    child (xcodebuild/xcbuddy) died with the old process tree — no
  //    re-attach exists — so a surviving 'running' row is a display lie and
  //    a retention anomaly. Mark honestly; log/console content is kept.
  //    (No bus event: the builds page polls on interval.)
  const orphanBuilds = db.prepare("SELECT id FROM builds WHERE status = 'running'").all() as Array<{ id: string }>;
  for (const { id } of orphanBuilds) {
    db.prepare(`UPDATE builds SET status = 'failed', finished_at = ?, error = ? WHERE id = ?`)
      .run(Date.now(), 'server restarted mid-build — orphaned build reaped at boot', id);
    report.buildsFailed++;
  }

  return report;
}
