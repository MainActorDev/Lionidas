import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { enqueue, abort, type QueueSpec } from '../queue/store.ts';
import { abortRun } from '../manual/playback.ts';
import type { TypedEventBus, AppEvents } from '../ws/bus.ts';
import { executeRun } from '../alloy/runner.ts';
import { jiraConfig, buildCommentBody, postComment } from '../integrations/jira.ts';
import { alloyDispatchDepsSync } from '../alloy/runtime.ts';
import { scanFlowSet } from '../domain/acs.ts';
import { diskState } from '../gc/retention.ts';
import { requireRole } from '../auth/roles.ts';

interface RunRow {
  id: string; ticket_key: string; kind: string; status: string; triggered_by: string;
  device_udid: string; artifact_hash: string | null; freshness: string;
  launch_args_json: string; started_at: number | null; finished_at: number | null;
  /** phase A: the case version this run executed (null = pre-versioning) */
  case_version_id?: string | null;
  template_id?: string | null;
}

export function registerRunRoutes(app: FastifyInstance, db: Database.Database, bus?: TypedEventBus<AppEvents>): void {
  app.post('/api/runs', { preHandler: requireRole('operator') }, async (req, reply) => {
    const body = req.body as Partial<QueueSpec> & {
      priority?: 'manual' | 'scheduled' | 'agent';
      scenarioId?: string;
      /** fan-out (plan R4): queue the same spec on several devices at once */
      udids?: string[];
      allBooted?: boolean;
    };
    // disk quota: pause new runs at 100% (PLAN §11)
    const disk = diskState(process.env['CRUCIBLE_ARTIFACTS_DIR'] ?? './artifacts');
    if (disk.paused) {
      return reply.code(507).send({ error: `evidence quota exhausted (${Math.round(disk.usageBytes / 1e9)}GB ≥ limit) — run GC or raise CRUCIBLE_QUOTA_BYTES` });
    }
    // pre-flight: everything validated BEFORE enqueue (invalid never queues).
    // Device targeting: exactly one of `udid` (single) / `udids` / `allBooted`.
    const fanout = body.udids ?? null;
    const fieldCount = [body.udid, fanout, body.allBooted].filter(Boolean).length;
    if (fieldCount > 1) return reply.code(400).send({ error: 'pick one of udid / udids / allBooted' });
    const required: Array<keyof QueueSpec> = ['ticketKey', 'flowsDir', 'app', 'artifactPath', 'triggeredBy'];
    if (!body.udid && !fanout && !body.allBooted) required.push('udid');
    for (const k of required) {
      if (k === 'udid' && (fanout || body.allBooted)) continue;
      if (!body[k]) return reply.code(400).send({ error: `missing field: ${k}` });
    }
    if (!existsSync(body.flowsDir!)) return reply.code(400).send({ error: `flowsDir not found: ${body.flowsDir}` });
    const set = scanFlowSet(body.flowsDir!);
    if (set.duplicateAcError) return reply.code(400).send({ error: `pre-flight: ${set.duplicateAcError}` });
    if (set.flows.length === 0) return reply.code(400).send({ error: 'no flows in flowsDir' });
    if (!existsSync(body.artifactPath!)) return reply.code(400).send({ error: `artifactPath not found: ${body.artifactPath}` });

    // resolve the target list
    let targets: string[];
    if (body.allBooted) {
      targets = (db.prepare(`SELECT udid FROM devices WHERE state = 'Booted'`).all() as Array<{ udid: string }>).map((r) => r.udid);
      if (targets.length === 0) return reply.code(400).send({ error: 'no booted devices' });
    } else if (fanout) {
      targets = fanout;
    } else {
      targets = [body.udid!];
    }
    // per-device existence check (names the offender)
    for (const u of targets) {
      const dev = db.prepare('SELECT udid FROM devices WHERE udid = ?').get(u);
      if (!dev) return reply.code(400).send({ error: `unknown device: ${u} (is the poller running?)` });
    }

    const prio = body.priority === 'agent' ? 2 : body.priority === 'scheduled' ? 1 : 0;
    const queueIds: string[] = [];
    for (const u of targets) {
      const spec: QueueSpec = {
        ticketKey: body.ticketKey!,
        flowsDir: body.flowsDir!,
        udid: u,
        app: body.app!,
        artifactPath: body.artifactPath!,
        ...(body.srcPath !== undefined ? { srcPath: body.srcPath } : {}),
        ...(body.launchArgs !== undefined ? { launchArgs: body.launchArgs } : {}),
        triggeredBy: body.triggeredBy!,
        ...(body.triage !== undefined ? { triage: body.triage } : {}),
        ...(body.kind !== undefined ? { kind: body.kind } : {}),
        ...(body.parentRunId !== undefined ? { parentRunId: body.parentRunId } : {}),
      };
      const queueId = enqueue(db, spec, req.user?.name ?? body.triggeredBy!, prio); // session wins
      bus?.emit('queue.changed', { queueId, state: 'waiting' });
      queueIds.push(queueId);
    }
    // single-device response shape unchanged; fan-out returns the list
    if (queueIds.length === 1 && !fanout && !body.allBooted) return reply.code(202).send({ queueId: queueIds[0] });
    return reply.code(202).send({ queueIds });
  });

  app.get('/api/queue', async () => {
    const rows = db.prepare('SELECT * FROM queue ORDER BY priority ASC, enqueued_at ASC').all();
    return { queue: rows };
  });

  app.delete('/api/queue/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = abort(db, id);
    if (!ok) return reply.code(409).send({ error: 'not abortable (already dispatched/done)' });
    bus?.emit('queue.changed', { queueId: id, state: 'aborted' });
    return { aborted: true };
  });

  app.get('/api/runs', async (req) => {
    const q = req.query as { ticket?: string; limit?: string; template?: string; app_version?: string; suite?: string; variant?: string; status?: string; before?: string };
    const limit = Math.min(Number.parseInt(q.limit ?? '50', 10) || 50, 200);
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.ticket) { where.push('ticket_key = ?'); params.push(q.ticket); }
    if (q.template) { where.push('template_id = ?'); params.push(q.template); }
    if (q.app_version) { where.push('app_version = ?'); params.push(q.app_version); }
    // status: exact match, plus two pseudo-statuses — 'active' (running OR
    // queued, the non-terminal set) and 'blocked' (the blocked COLUMN, not a
    // status value; the schema CHECK forbids status='blocked' outright).
    if (q.status === 'active') { where.push("status IN ('running','queued')"); }
    else if (q.status === 'blocked') { where.push('blocked = 1'); }
    else if (q.status) { where.push('status = ?'); params.push(q.status); }
    // cursor paging (017-C): strictly older than the given epoch-ms. NULL
    // started_at rows sort last and are naturally excluded — matches how the
    // client walks history (passes the oldest loaded row's started_at).
    const beforeMs = Number.parseInt(q.before ?? '', 10);
    if (Number.isFinite(beforeMs) && beforeMs > 0) { where.push('started_at < ?'); params.push(beforeMs); }
    // Phase D T7: suite filter. A suite id matches its stamped runs even
    // after the suite is deleted (honest history; name renders as
    // <deleted>). 'unassigned' matches both null suite_id AND null
    // variant_id runs (pre-D / ad-hoc plays). Composable with variant.
    if (q.suite !== undefined) {
      if (q.suite === 'unassigned') where.push('suite_id IS NULL');
      else { where.push('suite_id = ?'); params.push(q.suite); }
    }
    if (q.variant !== undefined) { where.push('variant_id = ?'); params.push(q.variant); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = db.prepare(`SELECT * FROM runs ${clause} ORDER BY started_at DESC LIMIT ?`).all(...params, limit);
    // Phase A breadcrumb: the revision each run executed + whether it is the
    // case's CURRENT one (drives the ⚠ stale chip). Two lookups over the
    // page's ids — no N+1 per row.
    const byId = new Map<string, RunRow>(
      (rows as RunRow[]).filter((r) => r.case_version_id).map((r) => [r.case_version_id as string, r]),
    );
    let versionMeta: Record<string, { revision: number; current: boolean }> = {};
    if (byId.size > 0) {
      const vids = [...byId.keys()];
      const placeholders = vids.map(() => '?').join(',');
      const vrows = db.prepare(
        `SELECT id, template_id, revision FROM case_versions WHERE id IN (${placeholders})`,
      ).all(...vids) as Array<{ id: string; template_id: string; revision: number }>;
      const tplIds = [...new Set(vrows.map((v) => v.template_id))];
      const tplaceholders = tplIds.map(() => '?').join(',');
      const cur = db.prepare(
        `SELECT template_id, MAX(revision) AS revision FROM case_versions WHERE template_id IN (${tplaceholders}) GROUP BY template_id`,
      ).all(...tplIds) as Array<{ template_id: string; revision: number }>;
      const curMap = new Map(cur.map((c) => [c.template_id, c.revision]));
      versionMeta = Object.fromEntries(vrows.map((v) => [v.id, { revision: v.revision, current: curMap.get(v.template_id) === v.revision }]));
    }
    return {
      runs: rows.map((r) => {
        const run = r as RunRow;
        return {
          ...run,
          versionInfo: run.case_version_id ? versionMeta[run.case_version_id] ?? null : null,
          // Phase C: explicit snake→camel for the variant chip (runs already
          // carry variant_id from T1; UI reads variantId)
          variantId: (run as RunRow & { variant_id?: string | null }).variant_id ?? null,
        };
      }),
    };
  });

  app.get('/api/runs/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
    if (!run) return reply.code(404).send({ error: 'run not found' });
    // bundle id from the run's case (single source of truth: templates) —
    // the run itself never stored it; manual/template-less runs carry null
    const bundle = run.template_id
      ? (db.prepare('SELECT app_bundle_id FROM templates WHERE id = ?').get(run.template_id) as { app_bundle_id: string | null } | undefined)?.app_bundle_id ?? null
      : null;
    // run-level evidence (video/screenshot/logs/network) — the run detail
    // surfaces it for EVERY verdict, not only failed-step triage; a passing
    // run's video was previously unreachable from the UI
    const evidence = db.prepare('SELECT id, type, path, bytes FROM evidence WHERE bundle_id = ? ORDER BY type').all(id) as Array<{ id: string; type: string; path: string; bytes: number }>;
    return { run: { ...run, app_bundle_id: bundle }, evidence };
  });

  // B2: abort a running manual/template run — idempotent on terminal runs.
  // Wedged dispatch promises can't be cancelled (no engine abort), but the
  // run record terminates and the device frees (B5 guard reads status).
  app.post('/api/runs/:id/abort', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const res = abortRun(db, id, bus);
      return res;
    } catch (err) {
      return reply.code(404).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Triage bundle for one failed step: reason + evidence (screenshot/diff/video/logs/network)
  app.get('/api/runs/:id/steps/:idx/triage', async (req, reply) => {
    const { id, idx } = req.params as { id: string; idx: string };
    const step = db.prepare('SELECT * FROM run_steps WHERE run_id = ? AND idx = ?').get(id, Number(idx)) as
      | { idx: number; flow_name: string; status: string; reason: string | null; evidence_ids_json: string; duration_ms: number; evaluated_json: string }
      | undefined;
    if (!step) return reply.code(404).send({ error: 'step not found' });
    // wait-vs-work split (telemetry): verb steps carry waitMs/workMs in
    // evaluated_json; absence = non-waiting step (tap/type/expect path)
    const timing = (() => { try { const j = JSON.parse(step.evaluated_json) as { waitMs?: number; workMs?: number }; return { waitMs: j.waitMs ?? null, workMs: j.workMs ?? null }; } catch { return { waitMs: null, workMs: null }; } })();
    const evIds = JSON.parse(step.evidence_ids_json) as string[];
    const evidence = evIds.length
      ? (db.prepare(`SELECT id, type, path, sha256, bytes FROM evidence WHERE id IN (${evIds.map(() => '?').join(',')})`).all(...evIds) as Array<{ id: string; type: string; path: string; sha256: string; bytes: number }>)
      : [];
    // video + logs attach at run level
    const runEvidence = db.prepare(`SELECT id, type FROM evidence WHERE bundle_id = ? AND type IN ('video','logs','network')`).all(id) as Array<{ id: string; type: string }>;
    const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Record<string, unknown>;
    return {
      step: { idx: step.idx, flow: step.flow_name, status: step.status, reason: step.reason, durationMs: step.duration_ms, waitMs: timing.waitMs, workMs: timing.workMs },
      evidence,
      runEvidence,
      run: { ticket: run['ticket_key'], artifactHash: run['artifact_hash'], freshness: run['freshness'], launchArgs: run['launch_args_json'], device: run['device_udid'] },
    };
  });

  // Jira evidence attachment (opt-in via env; 404 when disabled)
  app.post('/api/runs/:id/attach', async (req, reply) => {
    const cfg = jiraConfig();
    if (!cfg) return reply.code(404).send({ error: 'jira integration disabled (set JIRA_BASE/EMAIL/TOKEN)' });
    const { id } = req.params as { id: string };
    const built = buildCommentBody(db, id, cfg);
    if (!built) return reply.code(404).send({ error: 'run not found' });
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const commentId = await postComment(cfg, built.ticket, built.body);
        db.prepare('UPDATE runs SET jira_comment_id = ? WHERE id = ?').run(commentId, id);
        return { attached: true, commentId, ticket: built.ticket };
      } catch (err) {
        lastErr = err;
      }
    }
    return reply.code(502).send({ error: `jira failed twice: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}` });
  });

  // Re-run fragment: single flow, rerun kind, parent linked (synchronous for gate; queue path in M3 UI)
  app.post('/api/runs/:id/steps/:idx/rerun', async (req, reply) => {
    const { id, idx } = req.params as { id: string; idx: string };
    const step = db.prepare('SELECT flow_name FROM run_steps WHERE run_id = ? AND idx = ?').get(id, Number(idx)) as { flow_name: string } | undefined;
    if (!step) return reply.code(404).send({ error: 'step not found' });
    const q = db.prepare('SELECT spec_json FROM queue WHERE dispatched_run_id = ? ORDER BY rowid DESC LIMIT 1').get(id) as { spec_json: string } | undefined;
    if (!q) return reply.code(409).send({ error: 'original queue spec not found (runs API rerun requires queue-originated runs)' });
    const spec = JSON.parse(q.spec_json) as QueueSpec;
    const rerunId = await executeRun(
      {
        ticketKey: spec.ticketKey,
        flowsDir: spec.flowsDir,
        udid: spec.udid,
        app: spec.app,
        artifactPath: spec.artifactPath,
        ...(spec.srcPath !== undefined ? { srcPath: spec.srcPath } : {}),
        triggeredBy: `rerun:${(req.body as { by?: string } | undefined)?.by ?? 'api'}`,
        kind: 'rerun',
        parentRunId: id,
        onlyFlow: step.flow_name,
      },
      { db, bus: (req.server as unknown as { crucibleBus: TypedEventBus<AppEvents> }).crucibleBus, artifactsDir: process.env['CRUCIBLE_ARTIFACTS_DIR'] ?? './artifacts', dispatchDeps: alloyDispatchDepsSync() },
    );
    return { rerunId };
  });

  // Evidence overlay fine-align (plan 20261009T000000Z T2.3): per-run
  // offset + per-device remembered default (operator decision "both").
  // Admin-gated (destructive-ish: rewrites replay alignment), clamp ±10s.
  app.patch('/api/runs/:id/overlay-offset', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { offsetMs?: number };
    if (typeof b.offsetMs !== 'number' || !Number.isFinite(b.offsetMs)) {
      return reply.code(422).send({ error: 'offsetMs (number) required' });
    }
    const CLAMP = 10_000;
    const offsetMs = Math.max(-CLAMP, Math.min(CLAMP, Math.round(b.offsetMs)));
    const run = db.prepare('SELECT id, device_udid FROM runs WHERE id = ?').get(id) as { id: string; device_udid: string | null } | undefined;
    if (!run) return reply.code(404).send({ error: 'run not found' });
    db.prepare('UPDATE runs SET overlay_offset_ms = ? WHERE id = ?').run(offsetMs, id);
    // seed/refresh the device default (skipped when the run has no udid — F3)
    if (run.device_udid) {
      db.prepare(`INSERT INTO device_overlay_defaults(udid, offset_ms, updated_at) VALUES (?, ?, ?)
                  ON CONFLICT(udid) DO UPDATE SET offset_ms = excluded.offset_ms, updated_at = excluded.updated_at`)
        .run(run.device_udid, offsetMs, Date.now());
    }
    return { ok: true, offsetMs, source: 'run' as const };
  });

  app.get('/api/runs/:id/steps', async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = db.prepare('SELECT id FROM runs WHERE id = ?').get(id);
    if (!run) return reply.code(404).send({ error: 'run not found' });
    const steps = db.prepare('SELECT * FROM run_steps WHERE run_id = ? ORDER BY idx').all(id);
    return { steps };
  });
}
