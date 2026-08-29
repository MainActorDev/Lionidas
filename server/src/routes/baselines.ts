/** Baseline approvals: pending diffs → approve (updateBaselines rerun) | reject.
 *  Approve writes a NEW baseline row with supersedes lineage. */
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type { TypedEventBus, AppEvents } from '../ws/bus.ts';
import type { RunnerDeps } from '../alloy/runner.ts';
import { executeRun } from '../alloy/runner.ts';

export function registerBaselineRoutes(
  app: FastifyInstance,
  db: Database.Database,
  deps: { bus: TypedEventBus<AppEvents> } & RunnerDeps,
): void {
  app.get('/api/baselines/diffs', async (req) => {
    const q = req.query as { state?: string };
    const state = q.state === 'approved' || q.state === 'rejected' ? q.state : 'pending';
    const rows = db
      .prepare(
        `SELECT bd.*, e.path AS new_image_path, e2.path AS old_image_path
         FROM baseline_diffs bd
         LEFT JOIN evidence e ON e.id = bd.evidence_id
         LEFT JOIN baselines b ON b.image_sha256 = bd.old_sha
         LEFT JOIN evidence e2 ON e2.id = b.evidence_id
         WHERE bd.state = ? ORDER BY bd.rowid DESC LIMIT 100`,
      )
      .all(state);
    return { diffs: rows };
  });

  app.get('/api/baselines', async () => {
    const rows = db.prepare('SELECT * FROM baselines ORDER BY approved_at DESC LIMIT 200').all();
    return { baselines: rows };
  });

  app.post('/api/baselines/diffs/:id/approve', async (req, reply) => {
    const { id } = req.params as { id: string };
    const decidedBy = ((req.body as { by?: string } | undefined)?.by) ?? 'unknown';
    const row = db
      .prepare('SELECT * FROM baseline_diffs WHERE id = ? AND state = ?')
      .get(id, 'pending') as
      | { id: string; run_id: string; scope_key: string; old_sha: string | null; new_sha: string; evidence_id: string }
      | undefined;
    if (!row) return reply.code(404).send({ error: 'pending diff not found' });

    // lineage
    const prev = db
      .prepare('SELECT id FROM baselines WHERE scope_key = ? ORDER BY approved_at DESC LIMIT 1')
      .get(row.scope_key) as { id: string } | undefined;

    const run = db.prepare('SELECT ticket_key, device_udid FROM runs WHERE id = ?').get(row.run_id) as
      | { ticket_key: string; device_udid: string }
      | undefined;

    // 1) re-run ONLY this flow with updateBaselines:true (engine writes fresh baseline PNGs)
    let rerunOk = false;
    try {
      const spec = db
        .prepare('SELECT spec_json FROM queue WHERE dispatched_run_id = ? ORDER BY rowid DESC LIMIT 1')
        .get(row.run_id) as { spec_json: string } | undefined;
      const flowsDir = spec ? (JSON.parse(spec.spec_json) as { flowsDir: string }).flowsDir : undefined;
      const app_ = spec ? (JSON.parse(spec.spec_json) as { app: string }).app : undefined;
      const artifact = spec ? (JSON.parse(spec.spec_json) as { artifactPath: string }).artifactPath : undefined;
      if (flowsDir && app_ && artifact && run) {
        const rerunId = await executeRun(
          {
            ticketKey: run.ticket_key,
            flowsDir,
            udid: run.device_udid,
            app: app_,
            artifactPath: artifact,
            triggeredBy: `baseline-approve:${decidedBy}`,
            kind: 'rerun',
            parentRunId: row.run_id,
            onlyFlow: row.scope_key,
          },
          { ...deps, dispatchDeps: (deps as { dispatchDeps?: unknown }).dispatchDeps },
        );
        const rerunShot = db
          .prepare(`SELECT e.sha256, e.id FROM evidence e JOIN run_steps rs ON rs.run_id = ? WHERE e.type = 'screenshot' ORDER BY e.created_at DESC LIMIT 1`)
          .get(rerunId) as { sha256: string; id: string } | undefined;
        const newSha = rerunShot?.sha256 ?? row.new_sha;
        const newEvidence = rerunShot?.id ?? row.evidence_id;
        const bid = `b_${createHash('sha256').update(`${row.scope_key}${newSha}`).digest('hex').slice(0, 10)}`;
        db.prepare(
          `INSERT OR REPLACE INTO baselines(id, scope_key, image_sha256, evidence_id, approved_by, approved_at, supersedes_id, ticket_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(bid, row.scope_key, newSha, newEvidence, decidedBy, Date.now(), prev?.id ?? null, run?.ticket_key ?? null);
        rerunOk = true;
      }
    } catch { /* fall through to direct-baseline write */ }
    if (!rerunOk) {
      const bid = `b_${createHash('sha256').update(`${row.scope_key}${row.new_sha}`).digest('hex').slice(0, 10)}`;
      db.prepare(
        `INSERT OR REPLACE INTO baselines(id, scope_key, image_sha256, evidence_id, approved_by, approved_at, supersedes_id, ticket_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(bid, row.scope_key, row.new_sha, row.evidence_id, decidedBy, Date.now(), prev?.id ?? null, run?.ticket_key ?? null);
    }

    db.prepare(`UPDATE baseline_diffs SET state = 'approved', decided_by = ?, decided_at = ? WHERE id = ?`).run(decidedBy, Date.now(), id);
    deps.bus.emit('baseline.diff.decided', { diffId: id, state: 'approved', scopeKey: row.scope_key });
    return { approved: true, withRerun: rerunOk };
  });

  app.post('/api/baselines/diffs/:id/reject', async (req, reply) => {
    const { id } = req.params as { id: string };
    const decidedBy = ((req.body as { by?: string } | undefined)?.by) ?? 'unknown';
    const r = db.prepare(`UPDATE baseline_diffs SET state = 'rejected', decided_by = ?, decided_at = ? WHERE id = ? AND state = 'pending'`).run(decidedBy, Date.now(), id);
    if (r.changes === 0) return reply.code(404).send({ error: 'pending diff not found' });
    const row = db.prepare('SELECT scope_key FROM baseline_diffs WHERE id = ?').get(id) as { scope_key: string };
    deps.bus.emit('baseline.diff.decided', { diffId: id, state: 'rejected', scopeKey: row.scope_key });
    return { rejected: true };
  });
}
