/**
 * executeRun — the ONLY flow-execution path (M1 invariant). Engine-phased
 * sequence per plans/M1 §2.1 (A4-based): A-session without lease, B drives,
 * A captures, release always. Steps emit WS events as they land.
 */
import { createHash } from 'node:crypto';
import { statSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { crucibleAlloy } from '../alloy/client.ts';
import { initAlloyRuntime } from './runtime.ts';
import { scanFlowSet, type FlowMeta } from '../domain/acs.ts';
import { applyAutoQuarantine } from '../domain/flake.ts';
import type { TypedEventBus, AppEvents } from '../ws/bus.ts';
import { recordArtifact } from '../manual/app-catalog-store.ts';
import { importArtifact, appsStoreDir } from '../manual/artifacts.ts';

export interface RunSpec {
  ticketKey: string;
  flowsDir: string;
  udid: string;
  app: string;
  artifactPath: string;
  srcPath?: string;
  launchArgs?: string[];
  triggeredBy: string;
  triage?: boolean;
  kind?: 'automated' | 'manual' | 'rerun';
  parentRunId?: string;
  /** Rerun-fragment: execute only the named flow from the flow set. */
  onlyFlow?: string;
  /** Free-form label; 'rehearse' excludes the run from AC roll-up (status.ts). */
  note?: string;
}

export interface RunnerDeps {
  db: Database.Database;
  bus: TypedEventBus<AppEvents>;
  artifactsDir: string;
  /** Alloy dispatch deps (leases+state). Tests inject; production resolves lazily. */
  dispatchDeps?: unknown;
}

interface StepRecord {
  idx: number;
  flow_name: string;
  kind: string;
  name: string;
  status: 'pass' | 'fail' | 'skip' | 'error';
  reason?: string;
  duration_ms: number;
  evidence_ids: string[];
}

/** Copy engine-owned evidence into crucible artifacts (copy-at-ingest, decision 8). */
function ingestEvidence(
  deps: RunnerDeps,
  runId: string,
  bundleId: string,
  type: string,
  srcPath: string | undefined,
): string | null {
  if (!srcPath || !existsSync(srcPath)) return null;
  mkdirSync(join(deps.artifactsDir, runId), { recursive: true });
  const dest = join(deps.artifactsDir, runId, `${type}-${createHash('sha256').update(srcPath).digest('hex').slice(0, 8)}-${srcPath.split('/').pop()}`);
  if (!existsSync(dest)) copyFileSync(srcPath, dest);
  const sha = createHash('sha256').update(dest).digest('hex');
  const bytes = statSync(dest).size;
  const id = `ev_${sha.slice(0, 12)}`;
  deps.db
    .prepare(
      `INSERT OR IGNORE INTO evidence(id, bundle_id, type, path, sha256, bytes, moov_ok, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, bundleId, type, dest, sha, bytes, null, Date.now());
  return id;
}

export async function executeRun(spec: RunSpec, deps: RunnerDeps): Promise<string> {
  const alloy = crucibleAlloy();
  const setAll = scanFlowSet(spec.flowsDir);
  if (setAll.duplicateAcError) throw new Error(`pre-flight: ${setAll.duplicateAcError}`);
  if (setAll.flows.length === 0) throw new Error(`pre-flight: no flows in ${spec.flowsDir}`);
  const set = spec.onlyFlow
    ? { ...setAll, flows: setAll.flows.filter((f) => f.name === spec.onlyFlow),
        unmapped: setAll.unmapped.filter((f) => f.name === spec.onlyFlow) }
    : setAll;
  if (spec.onlyFlow && set.flows.length === 0) throw new Error(`pre-flight: flow "${spec.onlyFlow}" not found in ${spec.flowsDir}`);

  const runId = `run_${createHash('sha256').update(`${spec.ticketKey}${Date.now()}${Math.random()}`).digest('hex').slice(0, 8)}`;
  let artifactHash: string | null = null;
  let artifactMtime: number | null = null;
  if (spec.artifactPath && existsSync(spec.artifactPath)) {
    artifactHash = createHash('sha256').update(spec.artifactPath).digest('hex'); // path-stable M1 hash; content-hash with bundle digest in M2
    artifactMtime = Math.round(statSync(spec.artifactPath).mtimeMs);
  }

  deps.db
    .prepare(
      `INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid,
        artifact_path, artifact_hash, artifact_mtime, src_path, launch_args_json, parent_run_id, started_at)
       VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(runId, spec.ticketKey, spec.kind ?? 'automated', spec.triggeredBy, spec.udid, spec.artifactPath, artifactHash, artifactMtime, spec.srcPath ?? null, JSON.stringify(spec.launchArgs ?? []), spec.parentRunId ?? null, Date.now());
  if (spec.note !== undefined) {
    deps.db.prepare('UPDATE runs SET note = ? WHERE id = ?').run(spec.note, runId);
  }
  deps.bus.emit('run.started', { runId, ticketKey: spec.ticketKey, udid: spec.udid });

  const steps: StepRecord[] = [];
  let runStatus: 'passed' | 'failed' = 'passed';
  let freshness: 'fresh' | 'stale_ignored' | 'unchecked' = 'unchecked';
  let sessionOpen = false;

  const call = async (tool: string, input: Record<string, unknown>) => {
    if (process.env['CRUCIBLE_DEBUG_CALLS']) console.error('[dbg] call', tool, JSON.stringify(input).slice(0, 80));
    const r = await alloy.dispatch(tool, input, dispatchDeps);
    if (!r.ok) {
      const err = new Error(`${tool}: ${r.error.message}`) as Error & { code: string; details?: unknown };
      err.code = r.error.code;
      err.details = r.error.details;
      throw err;
    }
    return r.result as Record<string, unknown>;
  };

  const dispatchDeps = deps.dispatchDeps ?? (await initAlloyRuntime()).deps;

  try {
    // 1. A: install (+freshness gate)
    if (spec.artifactPath && spec.srcPath) {
      try {
        await call('alloy_apps', { action: 'install', path: spec.artifactPath, srcPath: spec.srcPath, app: spec.app, udid: spec.udid });
        freshness = 'fresh';
        // provenance — record the STORE path, not the caller's repo/DerivedData
        // path (repo cleans must never rot the catalog). Best-effort only.
        try {
          const storePath = spec.artifactPath.startsWith(appsStoreDir()) ? spec.artifactPath : importArtifact(spec.artifactPath);
          recordArtifact(deps.db, { bundleId: spec.app, artifactPath: storePath });
        } catch { /* provenance best-effort */ }
      } catch (err) {
        if ((err as { code?: string }).code === 'STALE_ARTIFACT') {
          freshness = 'stale_ignored';
          runStatus = 'failed';
          deps.db
            .prepare(`UPDATE runs SET freshness = ?, status = 'failed', finished_at = ? WHERE id = ?`)
            .run(freshness, Date.now(), runId);
          deps.bus.emit('run.freshness.checked', { runId, freshness });
          deps.bus.emit('run.finished', { runId, status: 'failed', udid: spec.udid });
          return runId;
        }
        throw err;
      }
      deps.bus.emit('run.freshness.checked', { runId, freshness });
    }

    // 2. A: open WITHOUT lease (A4) — session for logs/network
    await call('alloy_apps', { action: 'open', app: spec.app, udid: spec.udid, launchArgs: spec.launchArgs ?? [], hold: false });
    sessionOpen = true;

    // 3. A: logs start (per-call; session alive)
    await call('alloy_logs', { udid: spec.udid, action: 'start' }).catch(() => undefined);

    // 4. B: video start (per-call recorder persists)
    const vid = await call('alloy_video', { udid: spec.udid, action: 'start' }).catch(() => null);

    // 5. flows (sorted ticket/ac/name), B holds the lease per flow
    const mapped = set.flows
      .filter((f) => f.mapped)
      .sort((a, b) => `${a.ticket}|${a.acId}|${a.name}`.localeCompare(`${b.ticket}|${b.acId}|${b.name}`));
    const allFlows = [...mapped, ...set.unmapped];

    const acAgg = new Map<string, { flows: string[]; statuses: string[]; meta: FlowMeta }>();

    for (const flow of allFlows) {
      const idx = steps.length;
      deps.bus.emit('step.started', { runId, idx, flow: flow.name, name: flow.name });
      const t0 = Date.now();
      let status: StepRecord['status'] = 'pass';
      let reason: string | undefined;
      try {
        const res = (await call('alloy_flow', { udid: spec.udid, flowPath: flow.file })) as {
          ok?: boolean;
          steps?: Array<{ status?: string; reason?: string }>;
          passed?: number;
          failed?: number;
          errored?: number;
        };
        const failed = (res.failed ?? 0) + (res.errored ?? 0);
        if (!res.ok || failed > 0) {
          status = 'fail';
          const firstBad = res.steps?.find((s) => s.status === 'fail' || s.status === 'error');
          reason = firstBad?.reason ?? `flow reported failed=${res.failed ?? '?'} errored=${res.errored ?? '?'}`;
        }
      } catch (err) {
        status = 'error';
        reason = err instanceof Error ? err.message : String(err);
      }
      const duration = Date.now() - t0;
      const rec: StepRecord = {
        idx,
        flow_name: flow.name,
        kind: 'flow',
        name: flow.name,
        status,
        duration_ms: duration,
        evidence_ids: [],
        ...(reason !== undefined ? { reason } : {}),
      };
      // Triage capture on fail (spec.triage !== false): screenshot + baseline diff
      if (status !== 'pass' && spec.triage !== false) {
        try {
          const shot = (await call('alloy_screenshot', { udid: spec.udid })) as { path?: string };
          const shotEv = ingestEvidence(deps, runId, runId, 'screenshot', shot?.path);
          if (shotEv) rec.evidence_ids.push(shotEv);
          // baseline diff: compare against latest approved baseline for this flow scope
          const scopeKey = flow.name;
          const baseline = deps.db
            .prepare('SELECT id, image_sha256, evidence_id FROM baselines WHERE scope_key = ? ORDER BY approved_at DESC LIMIT 1')
            .get(scopeKey) as { id: string; image_sha256: string; evidence_id: string | null } | undefined;
          let diffEv: string | null = null;
          if (baseline?.evidence_id) {
            const baseRow = deps.db.prepare('SELECT path FROM evidence WHERE id = ?').get(baseline.evidence_id) as { path: string } | undefined;
            if (baseRow && shot?.path) {
              try {
                const d = (await call('alloy_screenshot_diff', {
                  baselinePath: baseRow.path,
                  currentPath: shot.path,
                  udid: spec.udid,
                })) as { diff?: { hostPath?: string } | string };
                const diffPath = typeof d?.diff === 'string' ? d.diff : (d?.diff as { hostPath?: string } | undefined)?.hostPath;
                diffEv = ingestEvidence(deps, runId, runId, 'diff', diffPath);
                if (diffEv) rec.evidence_ids.push(diffEv);
              } catch { /* diff is best-effort evidence */ }
            }
          }
          // pending baseline decision row (new candidate = the fail screenshot).
          // VISUAL ACs only: the baseline judgment is the drift question;
          // interaction/data assertion failures are plain red and never spawn
          // a judgment row. (Found in dogfood DOGFOOD-1.)
          if (shotEv && flow.category === 'visual') {
            const newSha = deps.db.prepare('SELECT sha256 FROM evidence WHERE id = ?').get(shotEv) as { sha256: string };
            deps.db
              .prepare(`INSERT INTO baseline_diffs(id, run_id, scope_key, old_sha, new_sha, evidence_id, state)
                        VALUES (?, ?, ?, ?, ?, ?, 'pending')`)
              .run(`bd_${runId}_${idx}`, runId, scopeKey, baseline?.image_sha256 ?? null, newSha.sha256, shotEv);
            deps.bus.emit('baseline.diff.pending', { diffId: `bd_${runId}_${idx}`, scopeKey, runId });
          }
        } catch { /* triage capture is best-effort; never fails the run */ }
      }
      steps.push(rec);
      deps.bus.emit('step.finished', { runId, idx, flow: flow.name, name: flow.name, status, durationMs: duration });

      if (flow.mapped) {
        const key = `${flow.ticket}|${flow.acId}`;
        const agg = acAgg.get(key) ?? { flows: [], statuses: [], meta: flow };
        agg.flows.push(flow.name);
        agg.statuses.push(status);
        acAgg.set(key, agg);
      }
      if (status !== 'pass') runStatus = 'failed';
    }

    // 6. B: video stop
    if (vid) {
      const stop = await call('alloy_video', { udid: spec.udid, action: 'stop', label: runId }).catch(() => null);
      const hostPath = (stop as { video?: { hostPath?: string } } | null)?.video?.hostPath;
      const videoEv = ingestEvidence(deps, runId, runId, 'video', hostPath);
      if (videoEv) steps.forEach((s) => s.evidence_ids.push(videoEv));
    }

    // 7. A: logs capture + network (no holder; session alive)
    const logs = await call('alloy_logs', { udid: spec.udid, action: 'capture' }).catch(() => null);
    const logPath = (logs as { path?: string } | null)?.path;
    const logEv = ingestEvidence(deps, runId, runId, 'logs', logPath);
    if (logEv && steps.some((s) => s.status !== 'pass')) steps.find((s) => s.status !== 'pass')?.evidence_ids.push(logEv);
    await call('alloy_logs', { udid: spec.udid, action: 'stop' }).catch(() => undefined);

    // persist steps + ac_results
    const insStep = deps.db.prepare(
      `INSERT INTO run_steps(run_id, idx, flow_name, kind, name, status, reason, started_at, duration_ms, evidence_ids_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    steps.forEach((s) => insStep.run(runId, s.idx, s.flow_name, s.kind, s.name, s.status, s.reason ?? null, Date.now() - s.duration_ms, s.duration_ms, JSON.stringify(s.evidence_ids)));
    const insAc = deps.db.prepare(
      `INSERT INTO ac_results(run_id, ticket_key, ac_id, ac_text, category, status, flow_names_json, bundle_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const [key, agg] of acAgg) {
      const [ticket, acId] = key.split('|');
      const anyFail = agg.statuses.some((s) => s === 'fail' || s === 'error');
      const allSkip = agg.statuses.every((s) => s === 'skip');
      insAc.run(runId, ticket, acId, agg.meta.acText, agg.meta.category ?? 'interaction', anyFail ? 'fail' : allSkip ? 'skip' : 'pass', JSON.stringify(agg.flows), runId);
    }
  } catch (err) {
    runStatus = 'failed';
    const idx = steps.length;
    const rec: StepRecord = {
      idx,
      flow_name: 'run',
      kind: 'error',
      name: 'runner',
      status: 'error',
      reason: err instanceof Error ? err.message : String(err),
      duration_ms: 0,
      evidence_ids: [],
    };
    steps.push(rec);
    const insStep = deps.db.prepare(
      `INSERT INTO run_steps(run_id, idx, flow_name, kind, name, status, reason, started_at, duration_ms, evidence_ids_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insStep.run(runId, rec.idx, rec.flow_name, rec.kind, rec.name, rec.status, rec.reason ?? null, Date.now(), 0, '[]');
  } finally {
    // 8. A: release ALWAYS (closes session incl. hold:false)
    if (sessionOpen) await alloy.dispatch('alloy_release', { udid: spec.udid }, dispatchDeps).catch(() => undefined);
    deps.db
      .prepare(`UPDATE runs SET status = ?, freshness = ?, finished_at = ? WHERE id = ?`)
      .run(runStatus, freshness, Date.now(), runId);
    try {
      for (const flowKey of applyAutoQuarantine(deps.db, runId)) {
        deps.bus.emit('flow.quarantined', { flowKey, reason: 'auto' });
      }
    } catch { /* analytics never fails the run */ }
    deps.bus.emit('run.finished', { runId, status: runStatus, udid: spec.udid });
  }
  return runId;
}
