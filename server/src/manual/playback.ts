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
import { withEngineHeal } from '../alloy/heal.ts';
import type { ForgeState } from '../forge/proxy.ts';
import { presetRowToSpec, type Preset } from '../forge/matcher.ts';
import { substituteStep } from './template-env.ts';
import { classifyBlocked } from '../db/blocked.ts';
import { resolveSelector, countMatches } from './selector.ts';
import type { SnapNode } from './selector.ts';
import { expandFlows } from './flows.ts';
import type { FlowStep } from './flows.ts';

export interface PlaybackDeps {
  db: Database.Database;
  bus: TypedEventBus<AppEvents>;
  dispatchDeps: unknown;
  artifactsDir: string;
  forgeState: ForgeState;
}

export interface PlaybackStep {
  idx: number;
  action: 'tap' | 'scroll' | 'type' | 'runFlow' | 'expect';
  x?: number;
  y?: number;
  direction?: 'up' | 'down' | 'left' | 'right';
  text?: string;
  /** Maestro-style soft step: a dispatch miss records skip, run stays green
   *  (interstitial popups, "dismiss if shown"). Missing env still hard-fails. */
  optional?: boolean;
  /** A6 element selector — resolved against the live hierarchy at playback */
  selector?: { identifier?: string; label?: string; type?: string };
  /** A5 subflow reference — expanded to child steps before execution */
  templateId?: string;
  /** set by expandFlows: child flow name for run_steps provenance */
  flow?: string;
}

interface TemplateRow {
  id: string;
  name: string;
  ticket_key: string | null;
  udid: string;
  steps_json: string;
  app_bundle_id: string | null;
  logical_w: number | null;
  logical_h: number | null;
}

function stepName(s: PlaybackStep): string {
  if (s.action === 'expect') return `expect ${s.selector?.label ?? s.selector?.identifier ?? '?'}`;
  if (s.action === 'runFlow') return `run flow ${s.templateId ?? '?'}`;
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
/** Fire-and-forget playback: resolves to { runId, done } once the run row
 *  exists. `done` settles when the run finishes (any status) — single plays
 *  ignore it; play-all awaits it (with a cap) to serialize the batch.
 *  Execution continues in background; run status/step rows are the live view.
 *  Phase 4: opts.scenarioId activates that scenario's presets (hybrid) for the
 *  run duration, restoring the previous forge state after — network choice is
 *  per-run, template stays network-agnostic (its defaultPresetId is a hint). */
export class PlaybackError extends Error {
  constructor(public code: 'DEVICE_BUSY', message: string) { super(message); }
}

// ── B2: abort registry + step watchdog ─────────────────────────────────────
// Manual/template runs hold a device for their whole life; a wedged dispatch
// used to leave the run `running` forever (B2). Abort is checked at every
// loop seam; the watchdog races each dispatch with a timeout so the RUN
// record + device always unblock. (The dispatch promise itself is NOT
// cancellable — alloy has no abort; the guarantee is bookkeeping + lease
// release, not zombie reaping. Documented honesty.)
const abortedRuns = new Set<string>();

/** Test hook: clear the registry between tests. */
export function __setAbortRegistryForTest(): void { abortedRuns.clear(); }

/** Mark a run aborted. Terminal runs are a no-op ({already}) — idempotent. */
export function abortRun(db: Database.Database, runId: string): { ok: true } | { already: 'finished' } {
  const run = db.prepare(`SELECT status FROM runs WHERE id = ?`).get(runId) as { status: string } | undefined;
  if (!run) throw new Error(`run ${runId} not found`);
  if (run.status !== 'queued' && run.status !== 'running') return { already: 'finished' };
  abortedRuns.add(runId);
  return { ok: true };
}

function isAborted(runId: string): boolean { return abortedRuns.has(runId); }

/** Race a dispatch with the step timeout. On timeout the step fails with a
 *  parseable reason and the run is marked blocked (infrastructure). */
async function withWatchdog<T>(runId: string, dispatch: Promise<T>, stepNameForError: string): Promise<T> {
  const ms = Number(process.env.CRUCIBLE_STEP_TIMEOUT_MS ?? 90_000);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      dispatch,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`step timeout after ${Math.round(ms / 1000)}s: ${stepNameForError}`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}


export async function runTemplatePlayback(deps: PlaybackDeps, templateId: string, opts: { udid?: string; triggeredBy?: string; scenarioId?: string; bundleId?: string; env?: Record<string, string> }): Promise<{ runId: string; done: Promise<void> }> {
  const t = deps.db.prepare('SELECT id, name, ticket_key, udid, steps_json, app_bundle_id, logical_w, logical_h FROM templates WHERE id = ?').get(templateId) as TemplateRow | undefined;
  if (!t) throw new Error(`template ${templateId} not found`);
  let steps: PlaybackStep[] = [];
  try { steps = JSON.parse(t.steps_json) as PlaybackStep[]; } catch { /* empty */ }
  if (steps.length === 0) throw new Error('template has no steps');

  const udid = opts.udid ?? t.udid;
  // B5: no concurrency guard existed — two plays (or a play + manual session)
  // raced one device and clobbered each other's state. Guard BEFORE the run
  // row exists so no phantom run is recorded.
  const busy = deps.db
    .prepare(`SELECT 1 FROM runs WHERE device_udid = ? AND status IN ('queued','running') LIMIT 1`)
    .get(udid);
  if (busy) throw new PlaybackError('DEVICE_BUSY', 'a run or manual session is active on this device — wait or abort it');
  // app binding: playback launches the app the template was recorded in —
  // steps land on a known screen, not whatever happened to be foreground
  const appToLaunch = opts.bundleId ?? t.app_bundle_id ?? 'com.apple.Preferences';
  const runId = `run_${createHash('sha256').update(`playback${templateId}${Date.now()}`).digest('hex').slice(0, 8)}`;
  // build anchoring: stamp the installed app's version at run creation
  // (best-effort — non-bundle fallbacks render 'unknown')
  let appVersion: string | null = null;
  try {
    const { listSimulatorApps } = await import('./apps.ts');
    appVersion = (await listSimulatorApps(udid)).find((a) => a.bundleId === appToLaunch)?.version ?? null;
  } catch { /* version best-effort */ }
  deps.db
    .prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at, note, template_id, app_version)
              VALUES (?, ?, 'manual', 'running', ?, ?, ?, ?, ?, ?)`)
    .run(runId, t.ticket_key ?? 'TEMPLATE', opts.triggeredBy ?? 'qa', udid, Date.now(), `template:${templateId} ${t.name}`, templateId, appVersion);
  deps.bus.emit('run.started', { runId, ticketKey: t.ticket_key ?? 'TEMPLATE' });

  // background execution — route returns immediately; done settles at finish
  const done = (async () => {
    const alloy = crucibleAlloy();
    // traffic attribution: everything the proxy sees while active belongs to this run
    deps.forgeState.activeRunId = runId;
    // B1: mirror to the addon state file so the mitm addon stamps rows with
    // this run id (in-process proxy reads forgeState directly; the addon tails
    // the file). Best-effort: attribution fails soft if the dir is missing.
    try {
      const { writeStateFile } = await import('../forge/mitm/manager.ts');
      const stateDir = process.env['CRUCIBLE_MITM_STATE_DIR'] ?? '/tmp/forge-mitm';
      const currentPresets = deps.db.prepare('SELECT * FROM presets ORDER BY created_at DESC').all() as Array<Record<string, unknown>>;
      writeStateFile(stateDir, deps.forgeState.mode, currentPresets.map(presetRowToSpec), runId);
    } catch { /* attribution best-effort */ }
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
        writeStateFile(restoreStateDir, 'hybrid', presets.map(presetRowToSpec));
      } catch { /* network best-effort — run proceeds without scenario */ }
    }
    let runStatus: 'passed' | 'failed' | 'aborted' = 'passed';
    let runBlocked = 0;
    const insStep = deps.db.prepare(
      `INSERT INTO run_steps(run_id, idx, flow_name, kind, name, status, reason, started_at, duration_ms, evidence_ids_json, evaluated_json)
       VALUES (?, ?, ?, 'step', ?, ?, ?, ?, ?, ?, ?)`,
    );
    try {
      // self-heal: stale session binding / dead engine is the known class —
      // reset + one retry before failing the run
      const open = (await withEngineHeal(async () =>
        crucibleAlloy().dispatch('alloy_apps', { action: 'open', app: appToLaunch, udid, hold: false }, deps.dispatchDeps))) as { ok: boolean; error?: { message: string } };
      if (!open.ok) throw new Error(`open failed: ${open.error?.message ?? 'engine error'}`);

      // A5: expand subflows flat — child steps carry flow + inherited optional
      let execSteps: PlaybackStep[];
      try {
        execSteps = expandFlows(steps as unknown as FlowStep[], (id) => {
          const row = deps.db.prepare('SELECT name, steps_json FROM templates WHERE id = ?').get(id) as { name: string; steps_json: string } | undefined;
          return row ? { name: row.name, steps: JSON.parse(row.steps_json) as FlowStep[] } : null;
        }) as unknown as PlaybackStep[];
      } catch (err) {
        throw new Error(`subflow expansion failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      // cross-device scaling (flaw #6): scale recorded coords by target/recorded
      // logical dims — applied only to steps WITHOUT a usable selector.
      let targetW: number | null = null; let targetH: number | null = null;
      try {
        const snap = (await alloy.dispatch('alloy_snapshot', { udid, interactiveOnly: false }, deps.dispatchDeps)) as
          | { ok: true; result: { nodes?: Array<{ rect?: { width: number; height: number } }> } } | { ok: false };
        if (snap.ok) { const r = snap.result.nodes?.[0]?.rect; if (r) { targetW = r.width; targetH = r.height; } }
      } catch { /* dims best-effort */ }
      const scaleX = targetW && t.logical_w && t.logical_w > 0 ? targetW / t.logical_w : 1;
      const scaleY = targetH && t.logical_h && t.logical_h > 0 ? targetH / t.logical_h : 1;

      for (const s of execSteps) {
        const t0 = Date.now();
        // B2: operator abort — checked between steps; remaining steps skipped,
        // run aborted, device freed (B5 guard reads terminal status).
        if (isAborted(runId)) {
          insStep.run(runId, s.idx, s.flow ?? t.name, stepName(s), 'skip', 'aborted by operator', Date.now(), 0, '[]', null);
          continue;
        }
        // env substitution (A1): resolve ${env.KEY} BEFORE dispatch — a missing
        // key fails the step deterministically; never type a half-resolved
        // string. Even optional steps hard-fail on missing env: a missing
        // credential is a config error, not a transient UI miss.
        const resolved = substituteStep(s, opts.env ?? {});
        if (resolved.error) {
          runStatus = 'failed';
          insStep.run(runId, s.idx, s.flow ?? t.name, stepName(s), 'fail', resolved.error, t0, 0, '[]', JSON.stringify(resolved));
          for (const rest of execSteps.filter((x) => x.idx > s.idx)) {
            insStep.run(runId, rest.idx, rest.flow ?? t.name, stepName(rest), 'skip', 'not reached', Date.now(), 0, '[]', null);
          }
          break;
        }
        try {
          // A7 expect: existence assertion — resolution IS the check. Never
          //  dispatches. Launch-settle window: a cold app takes ~2-3s to
          //  populate its AX hierarchy (verified live: label present at t+3s,
          //  absent at t+1s after open), so poll with backoff up to ~8s
          //  BEFORE declaring not-found. Bounded budget, not a wait framework.
          if (s.action === 'expect' && s.selector) {
            // settle budget injectable for tests (fake hierarchies are static;
            // 8s of real polling would blow vitest's 5s timeout)
            const settleBudgetMs = Number(process.env.CRUCIBLE_EXPECT_SETTLE_MS ?? 8000);
            const settlePollMs = Number(process.env.CRUCIBLE_EXPECT_POLL_MS ?? 2000);
            const readCount = async (): Promise<{ n: number; nodesL: SnapNode[] } | null> => {
              const snap = (await alloy.dispatch('alloy_snapshot', { udid, interactiveOnly: false }, deps.dispatchDeps)) as
                | { ok: true; result: { nodes?: SnapNode[] } } | { ok: false };
              if (!snap.ok) return null;
              const nodesL = snap.result.nodes ?? [];
              return { n: countMatches(nodesL, s.selector!), nodesL };
            };
            let read = await readCount();
            const settleStart = Date.now();
            while (read && read.n !== 1 && Date.now() - settleStart < settleBudgetMs) {
              await new Promise((r) => setTimeout(r, settlePollMs));
              read = await readCount();
            }
            const matched = read?.n ?? 0;
            const ev = { ...resolved, expect: s.selector, matched };
            if (matched === 1) {
              insStep.run(runId, s.idx, s.flow ?? t.name, stepName(s), 'pass', null, t0, Date.now() - t0, '[]', JSON.stringify(ev));
            } else {
              const selJson = JSON.stringify(s.selector);
              const reason = matched === 0 ? `not found: ${selJson}` : `ambiguous (${matched} matches): ${selJson}`;
              if (s.optional) {
                insStep.run(runId, s.idx, s.flow ?? t.name, stepName(s), 'skip', `optional expect miss: ${reason}`, t0, Date.now() - t0, '[]', JSON.stringify(ev));
                continue;
              }
              runStatus = 'failed';
              insStep.run(runId, s.idx, s.flow ?? t.name, stepName(s), 'fail', reason, t0, Date.now() - t0, '[]', JSON.stringify(ev));
              for (const rest of execSteps.filter((x) => x.idx > s.idx)) {
                insStep.run(runId, rest.idx, rest.flow ?? t.name, stepName(rest), 'skip', 'not reached', Date.now(), 0, '[]', null);
              }
              break;
            }
            continue;
          }
          // A6b: selector-first resolution against the LIVE hierarchy —
          // coordinates are the fallback, not the plan.
          let tx = s.x;
          let ty = s.y;
          let resolvedBy: 'selector' | 'coordinate-fallback' | 'coordinate' | 'coordinate-scaled' = 'coordinate';
          if ((s.action === 'tap' || s.action === 'type') && s.selector && (s.selector.identifier || s.selector.label)) {
            const snap = (await alloy.dispatch('alloy_snapshot', { udid, interactiveOnly: false }, deps.dispatchDeps)) as
              | { ok: true; result: { nodes?: SnapNode[] } } | { ok: false };
            const hit = snap.ok ? resolveSelector(snap.result.nodes ?? [], s.selector) : null;
            if (hit) { tx = hit.x; ty = hit.y; resolvedBy = 'selector'; }
            else resolvedBy = 'coordinate-fallback';
          } else if ((scaleX !== 1 || scaleY !== 1) && s.x !== undefined && s.y !== undefined) {
            // selector-less step on a different-size device — scale proportionally
            tx = Math.round(s.x * scaleX);
            ty = Math.round(s.y * scaleY);
            resolvedBy = 'coordinate-scaled';
          }
          let input: Record<string, unknown>;
          if (s.action === 'tap') input = { udid, action: 'press', target: { x: tx, y: ty }, settle: true };
          else if (s.action === 'scroll') input = { udid, action: 'scroll', direction: s.direction, settle: true };
          else input = { udid, action: 'fill', target: { x: tx, y: ty }, text: resolved.text ?? '', settle: true };
          const r = (await withWatchdog(runId, alloy.dispatch('alloy_act', input, deps.dispatchDeps) as Promise<{ ok: boolean; error?: { message: string } }>, stepName(s))) as { ok: boolean; error?: { message: string } };
          if (!r.ok) throw new Error(r.error?.message ?? 'engine error');
          insStep.run(runId, s.idx, s.flow ?? t.name, stepName(s), 'pass', null, t0, Date.now() - t0, '[]', JSON.stringify({ ...resolved, resolvedBy, ...(s.flow ? { flow: s.flow } : {}) }));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (s.optional) {
            // optional miss: record and continue — the run stays green
            insStep.run(runId, s.idx, s.flow ?? t.name, stepName(s), 'skip', `optional miss: ${msg}`, t0, Date.now() - t0, '[]', JSON.stringify(resolved));
            continue;
          }
          runStatus = 'failed';
          // blocked = infrastructure failure (open/session/lease/timeout) —
          // renders amber ◆, distinct from an app-failure red.
          if (classifyBlocked(msg)) runBlocked = 1;
          insStep.run(runId, s.idx, s.flow ?? t.name, stepName(s), 'fail', msg, t0, Date.now() - t0, '[]', JSON.stringify(resolved));
          // remaining steps are skipped (deterministic replay stops at first failure)
          for (const rest of execSteps.filter((x) => x.idx > s.idx)) {
            insStep.run(runId, rest.idx, rest.flow ?? t.name, stepName(rest), 'skip', 'not reached', Date.now(), 0, '[]', null);
          }
          break;
        }
      }
    } catch (err) {
      runStatus = 'aborted';
      // outer failures (open failed, engine dead, session binding) are ALL
      // infrastructure — the app never got a chance to be tested
      runBlocked = 1;
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
          writeStateFile(restoreStateDir, deps.forgeState.mode, restorePresets.map(presetRowToSpec));
        } catch { /* restore best-effort */ }
      }
      deps.forgeState.activeRunId = null;
      // B1: clear the addon's attribution too — rows after this point belong
      // to no run. (If a scenario restored above, that write already reset
      // activeRunId implicitly via the null default — this one is explicit.)
      try {
        const { writeStateFile } = await import('../forge/mitm/manager.ts');
        const stateDir = process.env['CRUCIBLE_MITM_STATE_DIR'] ?? '/tmp/forge-mitm';
        const currentPresets = deps.db.prepare('SELECT * FROM presets ORDER BY created_at DESC').all() as Array<Record<string, unknown>>;
        writeStateFile(stateDir, deps.forgeState.mode, currentPresets.map(presetRowToSpec), null);
      } catch { /* clear best-effort */ }
      // B2: operator abort wins over the loop's natural verdict
      if (isAborted(runId)) runStatus = 'aborted';
      abortedRuns.delete(runId); // registry entry no longer needed once terminal
      deps.db.prepare(`UPDATE runs SET status = ?, finished_at = ?, blocked = ? WHERE id = ?`).run(runStatus, Date.now(), runBlocked, runId);
      deps.bus.emit('run.finished', { runId, status: runStatus });
    }
  })();

  return { runId, done };
}
