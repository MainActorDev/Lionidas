/** Suite play-state: last-play batch derivation + freshness signals.
 *
 *  A suite's PILL describes its last play AS IT HAPPENED (batch rollup),
 *  while member rows read live per-member truth. When the two can disagree
 *  (membership edited, member case content edited since the play), these
 *  signals name the gap instead of letting verdicts drift silently:
 *
 *    lastPlay.membersChanged — membership set or variant pins differ from
 *      the last play's batch (order-insensitive: reorder is presentation)
 *    member.stale           — the case's CURRENT steps hash ≠ the hash of
 *      the case_version its last run pinned (rename-only edits never trip:
 *      identity = steps_json + scenario choice, as case-versions.ts)
 *    member.staleVariants   — pinned variant ids missing from the case's
 *      current vocabulary (ghost lanes)
 *
 *  All pure SQL derivations over runs/case_versions/suite_members — nothing
 *  new is stored; a play reconciles everything. */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

export interface LastPlayInfo {
  at: number | null;
  runIds: string[];
  membersChanged: boolean;
}

/** Fingerprint a membership: sorted (templateId, sorted-variant-pins) pairs.
 *  Order-insensitive by design — reordering members is presentation, not a
 *  different pack. Null pins (default = all variants) and explicit pins are
 *  distinct. */
function membershipFingerprint(members: Array<{ templateId: string; variantIds: string[] | null }>): string {
  const parts = members
    .map((m) => `${m.templateId}:${m.variantIds ? [...m.variantIds].sort().join(',') : '*'}`)
    .sort();
  return parts.join('|');
}

/** The last play of a suite = the newest run batch stamped with it. Runs of
 *  one play share suite_id + triggered_by('suite:<name>') + a started_at
 *  window (lanes start within seconds; variant lanes per member too). We
 *  take the newest run, then its batch = all suite runs within a 120s
 *  window of the batch start whose member case was in the play. */
export function lastSuitePlay(db: Database.Database, suiteId: string, currentMembers: Array<{ templateId: string; variantIds: string[] | null }>): LastPlayInfo {
  const newest = db.prepare(
    `SELECT id, started_at FROM runs WHERE suite_id = ? ORDER BY started_at DESC LIMIT 1`,
  ).get(suiteId) as { id: string; started_at: number | null } | undefined;
  if (!newest || newest.started_at == null) return { at: null, runIds: [], membersChanged: false };
  const WINDOW_MS = 120_000;
  const batch = db.prepare(
    `SELECT id, template_id FROM runs
     WHERE suite_id = ? AND started_at IS NOT NULL AND started_at >= ? - ? AND started_at <= ? + ?
     ORDER BY started_at ASC`,
  ).all(suiteId, newest.started_at, WINDOW_MS, newest.started_at, WINDOW_MS) as Array<{ id: string; template_id: string }>;
  // played membership: distinct member cases in the batch, with the variant
  // pins RECOVERED from the runs' variant_id values (a play of a pinned
  // subset stamps each lane's variant; default = all → distinct variant ids
  // of that case's runs within the batch reconstruct the pin)
  const played = new Map<string, Set<string>>();
  for (const r of batch) {
    if (r.template_id == null) continue;
    if (!played.has(r.template_id)) played.set(r.template_id, new Set());
  }
  const varStmt = db.prepare('SELECT DISTINCT variant_id FROM runs WHERE suite_id = ? AND template_id = ? AND started_at >= ? AND started_at <= ?');
  for (const tid of played.keys()) {
    const vs = varStmt.all(suiteId, tid, (newest.started_at as number) - WINDOW_MS, (newest.started_at as number) + WINDOW_MS) as Array<{ variant_id: string | null }>;
    for (const v of vs) if (v.variant_id != null) played.get(tid)!.add(v.variant_id);
  }
  const playedMembers = [...played.entries()].map(([templateId, vs]) => ({
    templateId,
    variantIds: vs.size > 0 ? [...vs].sort() : null,
  }));
  const changed = membershipFingerprint(playedMembers) !== membershipFingerprint(currentMembers);
  return { at: newest.started_at, runIds: batch.map((r) => r.id), membersChanged: changed };
}

/** Per-member staleness: current steps hash vs the hash of the version its
 *  last suite-scoped run pinned. Also surfaces ghost variant pins. */
export interface MemberFreshness {
  stale: boolean;
  staleVariants: string[];
}

export function memberFreshness(db: Database.Database, suiteId: string, templateId: string, pinnedVariants: string[] | null, currentVariants: string[]): MemberFreshness {
  // ghost pins: pinned ids absent from the case's current vocabulary
  const staleVariants = pinnedVariants ? pinnedVariants.filter((v) => !currentVariants.includes(v)) : [];
  // content staleness: only when we have a suite-scoped last run to compare
  const lastRun = db.prepare(
    `SELECT case_version_id FROM runs WHERE suite_id = ? AND template_id = ? AND case_version_id IS NOT NULL ORDER BY started_at DESC LIMIT 1`,
  ).get(suiteId, templateId) as { case_version_id: string } | undefined;
  if (!lastRun) return { stale: false, staleVariants };
  const vSha = db.prepare('SELECT steps_sha256 FROM case_versions WHERE id = ?').get(lastRun.case_version_id) as { steps_sha256: string } | undefined;
  const cur = db.prepare('SELECT steps_json FROM templates WHERE id = ?').get(templateId) as { steps_json: string } | undefined;
  if (!vSha || !cur) return { stale: false, staleVariants };
  const curSha = createHash('sha256').update(cur.steps_json).digest('hex');
  return { stale: vSha.steps_sha256 !== curSha, staleVariants };
}

/** Any in-flight run stamped with this suite → editing members must wait. */
export function suiteRunning(db: Database.Database, suiteId: string): boolean {
  const r = db.prepare(`SELECT 1 FROM runs WHERE suite_id = ? AND status IN ('queued','running') LIMIT 1`).get(suiteId);
  return r != null;
}
