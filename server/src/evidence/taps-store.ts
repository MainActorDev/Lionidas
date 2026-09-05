/** run_taps — persisted tap/fill points per manual run (Tier 2.2).
 *  Written at the step.tap emit site in playback (same values, one row
 *  per dispatch); read by the evidence player for the overlay. Guards:
 *  logical dims must be > 0 (playback emits targetW ?? 0 pre-snapshot)
 *  and the point must lie inside the logical rect (fraction math
 *  correctness). Retention stays the owner of deletion (ON DELETE
 *  CASCADE rides the runs row). */
import type Database from 'better-sqlite3';

export interface TapRecord {
  runId: string;
  idx: number | null;
  x: number;
  y: number;
  logicalW: number;
  logicalH: number;
}

export interface TapRow extends TapRecord {
  seq: number;
  ts: number;
}

/** Store one tap. ts injected (epoch ms) for determinism in tests.
 *  Returns the row's seq, or null when rejected by the guards. */
export function recordTap(db: Database.Database, tap: TapRecord, ts: number): number | null {
  const { runId, idx, x, y, logicalW, logicalH } = tap;
  if (!(logicalW > 0) || !(logicalH > 0)) return null;
  if (!(x >= 0 && x <= logicalW) || !(y >= 0 && y <= logicalH)) return null;
  const seq = (db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM run_taps WHERE run_id = ?').get(runId) as { next: number }).next;
  db.prepare('INSERT INTO run_taps(run_id, seq, ts, idx, x, y, logical_w, logical_h) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(runId, seq, ts, idx, x, y, logicalW, logicalH);
  return seq;
}

/** All taps of a run, oldest first (player replays in order). */
export function tapsForRun(db: Database.Database, runId: string): TapRow[] {
  return db.prepare('SELECT seq, ts, idx, x, y, logical_w AS logicalW, logical_h AS logicalH FROM run_taps WHERE run_id = ? ORDER BY seq').all(runId) as TapRow[];
}
