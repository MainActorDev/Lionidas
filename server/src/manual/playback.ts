/** Template playback: replays recorded steps as an automated-ish manual run.
 *  Truth = "steps executed + evidence + traffic" (user decision, phase 2):
 *  - runs row kind='manual', run_steps row per replayed step (pass/fail/skip)
 *  - final screenshot ingested as evidence
 *  - forge activeRunId set for the duration → traffic rows attach to the run
 *  No image assertions — failure is an engine dispatch error or missing field. */
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { TypedEventBus, AppEvents } from '../ws/bus.ts';
import { crucibleAlloy } from '../alloy/client.ts';
import type { ForgeState } from '../forge/proxy.ts';
import type { Preset } from '../forge/matcher.ts';
import { substituteStep } from './template-env.ts';

export interface PlaybackDeps {
  db: Database.Database;
  bus: TypedEventBus<AppEvents>;
  dispatchDeps: unknown;
  artifactsDir: string;
  forgeState: ForgeState;
}

export interface PlaybackStep {
  idx: number;
  action: 'tap' | 'scroll' | 'type';
  x?: number;
  y?: number;
  direction?: 'up' | 'down' | 'left' | 'right';
  text?: string;
  /** Maestro-style soft step: a dispatch miss records skip, run stays green
   *  (interstitial popups, "dismiss if shown"). Missing env still hard-fails. */
  optional?: boolean;
}

interface TemplateRow {
  id: string;
  name: string;
  ticket_key: string | null;
  udid: string;
  steps_json: string;
  app_bundle_id: string | null;
}

function stepName(s: PlaybackStep): string {
  if (s.action === 'tap') return `tap ${s.x},${s.y}`;
  if (s.action === 'scroll') return `scroll ${s.direction}`;
  return `type "${(s.text ?? '').slice(0, 20)}"`;
}

function ingestEvidence(deps: PlaybackDeps, runId: string, bundleId: string, type: string, srcPath: string | undefined): string | null {
  if (!srcPath || !existsSync(srcPath)) return null;
  mkdirSync(join(deps.artifactsDir, runId), { recursive: true });
  const dest = join(deps.artifactsDir, runId, `${type}-${createHash('sha256').update(srcPath).digest('hex').slice(0, 8)}-${srcPath.split('/').pop()}`);
  if (!existsSync(dest)) copyFileSync(srcPath, dest);
  const sha = createHash('sha256').update(dest).digest('hex');
  const id = `ev_${sha.slice(0, 12)}`;
  deps.db
    .prepare(`INSERT OR IGNORE INTO evidence(id, bundle_id, type, path, sha256, bytes, moov_ok, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, bundleId, type, dest, sha, statSync(dest).size, null, Date.now());
  return id;
}

/** preset DB row → addon state spec (single mapping, reused by restore). */
function rowToPresetSpec(p: Record<string, unknown>): Preset {
  return {
    id: p['id'] as string,
    method: p['method'] as string,
    pathPattern: p['path_pattern'] as string,
    match: p['match'] as 'exact' | 'glob' | 'regex',
    ...(p['headers_json'] ? { headers: JSON.parse(p['headers_json'] as string) as Record<string, string> } : {}),
    status: p['status'] as number,
    ...(p['body_path'] ? { bodyPath: p['body_path'] as string } : {}),
    ...(p['delay_ms'] ? { delayMs: p['delay_ms'] as number } : {}),
    ...(p['seq_json'] ? { seq: JSON.parse(p['seq_json'] as string) as Array<{ status: number }> } : {}),
    ...(p['failure'] ? { failure: p['failure'] as NonNullable<Preset['failure']> } : {}),
  };
}

/** Fire-and-forget playback: resolves to runId once the run row exists.
 *  Execution continues in background; run status/step rows are the live view.
 *  Phase 4: opts.scenarioId activates that scenario's presets (hybrid) for the
 *  run duration, restoring the previous forge state after — network choice is
 *  per-run, template stays network-agnostic (its defaultPresetId is a hint). */
export async function runTemplatePlayback(deps: PlaybackDeps, templateId: string, opts: { udid?: string; triggeredBy?: string; scenarioId?: string; bundleId?: string; env?: Record<string, string> }): Promise<string> {
  const t = deps.db.prepare('SELECT id, name, ticket_key, udid, steps_json, app_bundle_id FROM templates WHERE id = ?').get(templateId) as TemplateRow | undefined;
  if (!t) throw new Error(`template ${templateId} not found`);
  let steps: PlaybackStep[] = [];
  try { steps = JSON.parse(t.steps_json) as PlaybackStep[]; } catch { /* empty */ }
  if (steps.length === 0) throw new Error('template has no steps');

  const udid = opts.udid ?? t.udid;
  // app binding: playback launches the app the template was recorded in —
  // steps land on a known screen, not whatever happened to be foreground
  const appToLaunch = opts.bundleId ?? t.app_bundle_id ?? 'com.apple.Preferences';
  const runId = `run_${createHash('sha256').update(`playback${templateId}${Date.now()}`).digest('hex').slice(0, 8)}`;
  deps.db
    .prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at, note)
              VALUES (?, ?, 'manual', 'running', ?, ?, ?, ?)`)
    .run(runId, t.ticket_key ?? 'TEMPLATE', opts.triggeredBy ?? 'qa', udid, Date.now(), `template:${templateId} ${t.name}`);
  deps.bus.emit('run.started', { runId, ticketKey: t.ticket_key ?? 'TEMPLATE' });

  // background execution — route returns immediately with the runId
  void (async () => {
    const alloy = crucibleAlloy();
    // traffic attribution: everything the proxy sees while active belongs to this run
    deps.forgeState.activeRunId = runId;
    // network choice (phase 4): scenario presets active ONLY during the run
    let restorePresets: Array<Record<string, unknown>> | null = null;
    let restoreStateDir: string | null = null;
    if (opts.scenarioId) {
      const presets = deps.db.prepare(
        `SELECT p.* FROM presets p JOIN scenario_overrides so ON so.preset_id = p.id WHERE so.scenario_id = ? AND so.enabled = 1`,
      ).all(opts.scenarioId) as Array<Record<string, unknown>>;
      restorePresets = deps.db.prepare('SELECT * FROM presets ORDER BY created_at DESC').all() as Array<Record<string, unknown>>;
      restoreStateDir = process.env['CRUCIBLE_MITM_STATE_DIR'] ?? '/tmp/forge-mitm';
      try {
        const { writeStateFile } = await import('../forge/mitm/manager.ts');
        writeStateFile(restoreStateDir, 'hybrid', presets.map(rowToPresetSpec));
      } catch { /* network best-effort — run proceeds without scenario */ }
    }
    let runStatus: 'passed' | 'failed' | 'aborted' = 'passed';
    const insStep = deps.db.prepare(
      `INSERT INTO run_steps(run_id, idx, flow_name, kind, name, status, reason, started_at, duration_ms, evidence_ids_json, evaluated_json)
       VALUES (?, ?, ?, 'step', ?, ?, ?, ?, ?, ?, ?)`,
    );
    try {
      const open = (await alloy.dispatch('alloy_apps', { action: 'open', app: appToLaunch, udid, hold: false }, deps.dispatchDeps)) as { ok: boolean; error?: { message: string } };
      if (!open.ok) throw new Error(`open failed: ${open.error?.message ?? 'engine error'}`);

      for (const s of steps) {
        const t0 = Date.now();
        // env substitution (A1): resolve ${env.KEY} BEFORE dispatch — a missing
        // key fails the step deterministically; never type a half-resolved
        // string. Even optional steps hard-fail on missing env: a missing
        // credential is a config error, not a transient UI miss.
        const resolved = substituteStep(s, opts.env ?? {});
        if (resolved.error) {
          runStatus = 'failed';
          insStep.run(runId, s.idx, t.name, stepName(s), 'fail', resolved.error, t0, 0, '[]', JSON.stringify(resolved));
          for (const rest of steps.filter((x) => x.idx > s.idx)) {
            insStep.run(runId, rest.idx, t.name, stepName(rest), 'skip', 'not reached', Date.now(), 0, '[]', null);
          }
          break;
        }
        try {
          let input: Record<string, unknown>;
          if (s.action === 'tap') input = { udid, action: 'press', target: { x: s.x, y: s.y }, settle: true };
          else if (s.action === 'scroll') input = { udid, action: 'scroll', direction: s.direction, settle: true };
          else input = { udid, action: 'fill', target: { x: s.x, y: s.y }, text: resolved.text ?? '', settle: true };
          const r = (await alloy.dispatch('alloy_act', input, deps.dispatchDeps)) as { ok: boolean; error?: { message: string } };
          if (!r.ok) throw new Error(r.error?.message ?? 'engine error');
          insStep.run(runId, s.idx, t.name, stepName(s), 'pass', null, t0, Date.now() - t0, '[]', JSON.stringify(resolved));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (s.optional) {
            // optional miss: record and continue — the run stays green
            insStep.run(runId, s.idx, t.name, stepName(s), 'skip', `optional miss: ${msg}`, t0, Date.now() - t0, '[]', JSON.stringify(resolved));
            continue;
          }
          runStatus = 'failed';
          insStep.run(runId, s.idx, t.name, stepName(s), 'fail', msg, t0, Date.now() - t0, '[]', JSON.stringify(resolved));
          // remaining steps are skipped (deterministic replay stops at first failure)
          for (const rest of steps.filter((x) => x.idx > s.idx)) {
            insStep.run(runId, rest.idx, t.name, stepName(rest), 'skip', 'not reached', Date.now(), 0, '[]', null);
          }
          break;
        }
      }
    } catch (err) {
      runStatus = 'aborted';
      deps.db.prepare(`UPDATE runs SET note = ? WHERE id = ?`).run(`${err instanceof Error ? err.message : String(err)}`, runId);
    } finally {
      // final screenshot = run evidence (best-effort)
      try {
        const shot = (await alloy.dispatch('alloy_screenshot', { udid }, deps.dispatchDeps)) as { ok: boolean; result?: { path: string } };
        if (shot.ok && shot.result) {
          const evId = ingestEvidence(deps, runId, 'manual', 'screenshot', shot.result.path);
          if (evId) deps.db.prepare(`UPDATE runs SET artifact_path = ? WHERE id = ?`).run(shot.result.path, runId);
        }
      } catch { /* evidence best-effort */ }
      // restore prior forge state — scenario was run-scoped by contract
      if (restorePresets && restoreStateDir) {
        try {
          const { writeStateFile } = await import('../forge/mitm/manager.ts');
          writeStateFile(restoreStateDir, deps.forgeState.mode, restorePresets.map(rowToPresetSpec));
        } catch { /* restore best-effort */ }
      }
      deps.forgeState.activeRunId = null;
      deps.db.prepare(`UPDATE runs SET status = ?, finished_at = ? WHERE id = ?`).run(runStatus, Date.now(), runId);
      deps.bus.emit('run.finished', { runId, status: runStatus });
    }
  })();

  return runId;
}
