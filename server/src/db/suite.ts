/** Batch 4 — suite management queries: last verdict + trend per test case,
 *  and per-case run history. Pure SQL derivations over runs.template_id —
 *  status stays COMPUTED (never stored beyond the run's own truth).
 *
 *  Trend glyphs (single source of truth, rendered as-is):
 *    p = passed · f = failed · a = aborted · uppercase = blocked (infra)
 *  Window: last 10 runs, ordered oldest → newest. */
import type Database from 'better-sqlite3';

export interface CaseVerdict {
  lastRunId: string | null;
  lastStatus: string | null;
  lastBlocked: number;
  lastFinishedAt: number | null;
  lastAppVersion: string | null;
  trend: string | null;       // null = never run
  totalRuns: number;
}

export interface HistoryRow {
  id: string;
  status: string;
  blocked: number;
  started_at: number;
  finished_at: number | null;
  app_version: string | null;
  note: string | null;
}

/** One row per template that has runs: latest verdict + trend, in one query.
 *  Templates with zero runs are ABSENT here — callers render "never run".
 *  suiteId filters to runs stamped with that suite: a member's verdict is the
 *  last time THIS suite played it, not the case's last run anywhere (shared
 *  members must not leak status across suites). Null/omitted = all runs
 *  (cases-page semantics). */
export function suiteVerdicts(db: Database.Database, suiteId?: string | null): Map<string, CaseVerdict> {
  const rows = db.prepare(`
    WITH ranked AS (
      SELECT r.*,
             ROW_NUMBER() OVER (PARTITION BY r.template_id ORDER BY r.started_at DESC) AS rn,
             COUNT(*) OVER (PARTITION BY r.template_id) AS total
      FROM runs r WHERE r.template_id IS NOT NULL
      ${suiteId ? 'AND r.suite_id = ?' : ''}
    ),
    newest AS (
      SELECT template_id, started_at AS batch_start FROM ranked WHERE rn = 1
    ),
    batch AS (
      -- lanes of the LAST PLAY. Within the batch window (same 120s as
      -- lastSuitePlay), each VARIANT is one lane collapsed to its newest
      -- run — sequential re-runs of the same variant supersede each other,
      -- while sibling variants of one play all count. A multi-variant
      -- verdict is the worst lane.
      SELECT r.template_id, r.status, r.blocked
      FROM ranked r
      JOIN newest n ON n.template_id = r.template_id
      WHERE r.started_at >= n.batch_start - 120000
        AND r.started_at = (
          SELECT MAX(r2.started_at) FROM ranked r2
          WHERE r2.template_id = r.template_id
            AND r2.variant_id IS r.variant_id
            AND r2.started_at >= n.batch_start - 120000
        )
    )
    SELECT template_id,
           (SELECT id FROM ranked l WHERE l.template_id = ranked.template_id AND l.rn = 1) AS last_run_id,
           -- worst-of-batch: any failed lane → failed; else any blocked lane
           -- → blocked flag; else the newest lane as-is
           (SELECT CASE
              WHEN EXISTS (SELECT 1 FROM batch b WHERE b.template_id = ranked.template_id AND b.status = 'failed') THEN 'failed'
              ELSE l.status
            END
            FROM ranked l WHERE l.template_id = ranked.template_id AND l.rn = 1) AS last_status,
           (SELECT CASE
              WHEN EXISTS (SELECT 1 FROM batch b WHERE b.template_id = ranked.template_id AND b.blocked = 1) THEN 1
              ELSE l.blocked
            END
            FROM ranked l WHERE l.template_id = ranked.template_id AND l.rn = 1) AS last_blocked,
           (SELECT finished_at FROM ranked l WHERE l.template_id = ranked.template_id AND l.rn = 1) AS last_finished_at,
           (SELECT app_version FROM ranked l WHERE l.template_id = ranked.template_id AND l.rn = 1) AS last_app_version,
           total,
           (SELECT group_concat(g, '') FROM (
              SELECT CASE
                WHEN status = 'passed' THEN 'p'
                WHEN blocked = 1 THEN 'F'
                WHEN status = 'failed' THEN 'f'
                WHEN status = 'aborted' THEN 'a'
                ELSE '?'
              END AS g
              FROM ranked t2
              WHERE t2.template_id = ranked.template_id
              ORDER BY t2.started_at DESC LIMIT 6
           )) AS trend_desc
    FROM ranked WHERE rn = 1
  `).all(...(suiteId ? [suiteId] : [])) as Array<{
    template_id: string; last_run_id: string; last_status: string; last_blocked: number;
    last_finished_at: number | null; last_app_version: string | null; total: number; trend_desc: string | null;
  }>;
  const out = new Map<string, CaseVerdict>();
  for (const r of rows) {
    out.set(r.template_id, {
      lastRunId: r.last_run_id,
      lastStatus: r.last_status,
      lastBlocked: r.last_blocked,
      lastFinishedAt: r.last_finished_at,
      lastAppVersion: r.last_app_version,
      trend: r.trend_desc ? r.trend_desc.split('').reverse().join('') : null, // stored newest→oldest
      totalRuns: r.total,
    });
  }
  return out;
}

/** Newest-first run history for one case. */
export function runTrend(db: Database.Database, templateId: string, limit = 50): HistoryRow[] {
  return db.prepare(
    `SELECT id, status, blocked, started_at, finished_at, app_version, note
     FROM runs WHERE template_id = ? ORDER BY started_at DESC LIMIT ?`,
  ).all(templateId, limit) as HistoryRow[];
}
