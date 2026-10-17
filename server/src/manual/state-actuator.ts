/** Device-scoped actuator serialization (phase A S4, plan 20261017T112229Z).
 *
 *  An app-states recipe actuator that touches the DEVICE (uninstallReinstall,
 *  privacyGrant) must run while the current run EXCLUSIVELY owns the udid.
 *  Playback's front gate (B5) already refuses contended starts — this guard
 *  is defense-in-depth for the window between the gate and the actuator
 *  (lane churn, queue promotion). Contention = honest named failure, never
 *  forced eviction, never wait-forever.
 *
 *  Semantics (lesson h, self-deadlock class):
 *  - the CALLING run's own row is EXCLUDED (it is legitimately active)
 *  - kind='manual' rows are EXCLUDED (a manual session's own parent row is
 *    running by design — counting it deadlocks the session class)
 *  - queued + running automated rows on the SAME udid DO contend (a sibling
 *    lane's future play would inherit a mutated device)
 */
import type Database from 'better-sqlite3';

export interface ContenderRow { id: string }

export function deviceContender(db: Database.Database, udid: string, selfRunId: string): ContenderRow | undefined {
  return db
    .prepare("SELECT id FROM runs WHERE device_udid = ? AND status IN ('queued','running') AND kind != 'manual' AND id != ? LIMIT 1")
    .get(udid, selfRunId) as ContenderRow | undefined;
}
