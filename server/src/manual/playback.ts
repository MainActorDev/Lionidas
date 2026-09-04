/** Template playback: replays recorded steps as an automated-ish manual run.
 *  Truth = "steps executed + evidence + traffic" (user decision, phase 2):
 *  - runs row kind='manual', run_steps row per replayed step (pass/fail/skip)
 *  - final screenshot ingested as evidence
 *  - forge activeRunId set for the duration → traffic rows attach to the run
 *  No image assertions — failure is an engine dispatch error or missing field. */
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
const execFileAsync = promisify(execFile);
import type { TypedEventBus, AppEvents } from '../ws/bus.ts';
import { crucibleAlloy } from '../alloy/client.ts';
import { dispatchWithHeal } from '../alloy/heal.ts';
import type { ForgeState } from '../forge/proxy.ts';
import { substituteStep } from './template-env.ts';
import { forgeStateService } from '../forge/state.ts';
import { classifyBlocked } from '../db/blocked.ts';
import { resolveSelector, countMatches, selectorLabel } from './selector.ts';
import type { SnapNode } from './selector.ts';
import { expandFlows } from './flows.ts';
import type { FlowStep } from './flows.ts';
import { listSimulatorApps } from './apps.ts';
import { lastArtifactFor } from './app-catalog-store.ts';

const defaultListApps = (udid: string): Promise<Array<{ bundleId: string }>> =>
  listSimulatorApps(udid).then((apps) => apps.map((a) => ({ bundleId: a.bundleId })));

export interface PlaybackDeps {
  db: Database.Database;
  bus: TypedEventBus<AppEvents>;
  dispatchDeps: unknown;
  artifactsDir: string;
  forgeState: ForgeState;
  /** readiness gate seam: proves the device stream is live before the app
   *  relaunch + steps. Default = the HTTP probe against the resolve route.
   *  Tests inject a stub; null skips the gate (legacy direct mode). */
  awaitStreamLive?: ((udid: string) => Promise<void>) | null;
  /** installed-apps seam for the APP_NOT_INSTALLED pre-check (tests stub;
   *  default = real listSimulatorApps). */
  listApps?: (udid: string) => Promise<Array<{ bundleId: string }>>;
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
  if (s.action === 'expect') return `expect ${selectorLabel(s.selector ?? {})}`;
  if (s.action === 'runFlow') return `run flow ${s.templateId ?? '?'}`;
  if (s.action === 'tap') return `tap ${s.x},${s.y}`;
  if (s.action === 'scroll') return `scroll ${s.direction}`;
  return `type "${(s.text ?? '').slice(0, 20)}"`;
}

/** Panel-facing summary of an expanded step (run.plan / step events). */
function stepLabel(s: PlaybackStep): string {
  if (s.action === 'expect') return `expect ${s.selector?.label ?? s.selector?.identifier ?? '?'}`;
  if (s.action === 'runFlow') return `run flow ${s.templateId ?? '?'}`;
  if (s.action === 'tap') return s.selector ? `tap ${s.selector.label ?? s.selector.identifier ?? ''}`.trim() : `tap ${s.x},${s.y}`;
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
  constructor(
    public code: 'DEVICE_BUSY' | 'APP_NOT_INSTALLED' | 'DEVICE_AMBIGUOUS',
    message: string,
    public payload?: { appBundleId?: string; udid?: string; booted?: Array<{ udid: string; name: string | null }>; lastArtifact?: { path: string; version: string | null; recordedAt: number } | null },
  ) { super(message); }
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

/** Compact UI-state signature: label/type/identifier multiset. Rects are
 *  deliberately excluded — rounded-int jitter would never stabilize; content
 *  changes (nav, scroll bringing new labels into view) still flip the sig. */
function hierarchySig(nodes: SnapNode[]): string {
  return (nodes ?? [])
    .map((n) => `${n.type ?? ''}|${n.label ?? ''}|${n.identifier ?? ''}`)
    .sort()
    .join(';');
}

/** State-based settle: poll the hierarchy until two consecutive reads agree
 *  (animations/navigations done) or the budget expires. Replaces the engine's
 *  fixed ~2.4s post-action settle (measured live: settle:true dispatch ≈
 *  2846ms vs settle:false ≈ 470ms) with an adaptive wait that exits as soon
 *  as the UI is actually quiet — faster AND stronger: a fixed 2.4s can still
 *  catch mid-animation; this cannot exit before stability. */
async function awaitUiStable(
  dispatchSnap: () => Promise<SnapNode[] | null>,
  runId: string,
  budgetMs: number,
): Promise<boolean> {
  const t0 = Date.now();
  let prev: string | null = null;
  while (Date.now() - t0 < budgetMs && !isAborted(runId)) {
    const nodes = await dispatchSnap();
    if (nodes) {
      const sig = hierarchySig(nodes);
      if (sig === prev) return true; // two identical reads — UI quiet
      prev = sig;
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  return false;
}

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


export async function runTemplatePlayback(deps: PlaybackDeps, templateId: string, opts: { udid?: string; triggeredBy?: string; scenarioId?: string; bundleId?: string; env?: Record<string, string> }): Promise<{ runId: string; udid: string; done: Promise<void> }> {
  const t = deps.db.prepare('SELECT id, name, ticket_key, udid, steps_json, app_bundle_id, logical_w, logical_h FROM templates WHERE id = ?').get(templateId) as TemplateRow | undefined;
  if (!t) throw new Error(`template ${templateId} not found`);
  const tpl: TemplateRow = t;
  let steps: PlaybackStep[] = [];
  try { steps = JSON.parse(t.steps_json) as PlaybackStep[]; } catch { /* empty */ }
  if (steps.length === 0) throw new Error('template has no steps');

  // Device resolution (user contract: "run it on the sim I booted"):
  //   explicit udid > recorded device if still booted > the single booted
  //   device (user switched sims since recording) > recorded device.
  // Without this, replaying after booting a different sim targets the
  // recorded (now shutdown) device — stream gate 409, run aborts.
  function resolveUdid(): string {
    if (opts.udid) return opts.udid;
    const states = deps.db.prepare('SELECT udid, name, state FROM devices').all() as Array<{ udid: string; name: string | null; state: string | null }>;
    const booted = states.filter((d) => d.state === 'Booted');
    if (booted.some((d) => d.udid === tpl.udid)) return tpl.udid;
    if (booted.length === 1) return booted[0]!.udid;
    if (booted.length > 1) {
      // several sims booted, none chosen: guessing would silently run on the
      // wrong device (or a shutdown recorded one) — demand an explicit pick
      throw new PlaybackError(
        'DEVICE_AMBIGUOUS',
        `${booted.length} devices are booted — pick one (found: ${booted.map((d) => d.name ?? d.udid.slice(0, 8)).join(', ')})`,
        { booted: booted.map((d) => ({ udid: d.udid, name: d.name })) },
      );
    }
    return tpl.udid ?? '';
  }
  const udid = resolveUdid();
  // B5: no concurrency guard existed — two plays (or a play + manual session)
  // raced one device and clobbered each other's state. Guard BEFORE the run
  // row exists so no phantom run is recorded.
  const busy = deps.db
    .prepare(`SELECT 1 FROM runs WHERE device_udid = ? AND status IN ('queued','running') LIMIT 1`)
    .get(udid);
  if (busy) throw new PlaybackError('DEVICE_BUSY', 'a run or manual session is active on this device — wait or abort it');
  // app binding: playback launches the app the template was recorded in —
  // steps land on a known screen, not whatever happened to be foreground
  const appToLaunch = opts.bundleId ?? tpl.app_bundle_id ?? 'com.apple.Preferences';
  // app presence pre-check (user contract 2026-09-04): a run against a sim
  // missing the target app must fail FAST with an actionable error — not a
  // ~17s engine-note abort. Checked BEFORE the run row exists (no phantom run).
  // Skipped when: no app binding (Settings always present), or listapps fails
  // (shutdown sim → 405 — the engine stream gate reports that honestly).
  if (appToLaunch !== 'com.apple.Preferences') {
    let installed: Array<{ bundleId: string }> = [];
    try { installed = await (deps.listApps ?? defaultListApps)(udid); } catch { /* engine gate handles */ }
    if (installed.length > 0 && !installed.some((a) => a.bundleId === appToLaunch)) {
      const last = lastArtifactFor(deps.db, appToLaunch);
      throw new PlaybackError(
        'APP_NOT_INSTALLED',
        `app not installed on this device: ${appToLaunch}`,
        { appBundleId: appToLaunch, udid, lastArtifact: last ? { path: last.artifactPath, version: last.appVersion, recordedAt: last.recordedAt } : null },
      );
    }
  }
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
    try { forgeStateService(deps).setActiveRun(runId); } catch { /* attribution best-effort */ }
    // network choice (phase 4): scenario presets active ONLY during the run
    let restorePresets: Array<Record<string, unknown>> | null = null; // non-null ⇒ scenario activated (service owns restore)
    if (opts.scenarioId) {
      const presets = deps.db.prepare(
        `SELECT p.* FROM presets p JOIN scenario_overrides so ON so.preset_id = p.id WHERE so.scenario_id = ? AND so.enabled = 1`,
      ).all(opts.scenarioId) as Array<Record<string, unknown>>;
      restorePresets = deps.db.prepare('SELECT * FROM presets ORDER BY created_at DESC').all() as Array<Record<string, unknown>>;
      try {
        forgeStateService(deps).activateScenario(presets);
      } catch { /* network best-effort — run proceeds without scenario */ }
    }
    let runStatus: 'passed' | 'failed' | 'aborted' = 'passed';
    let runBlocked = 0;
    /** readiness gate (user contract): every run waits for (1) the device
     *  stream to be provably live, (2) the target app freshly reopened —
     *  only then steps. Stream-live proof: fetch the resolve route (self-
     *  heals the engine chain), then HTTP-probe the MJPEG upstream until a
     *  JPEG frame is seen or the budget expires. */
    async function defaultAwaitStreamLive(gateUdid: string): Promise<void> {
      const budgetMs = Number(process.env['CRUCIBLE_STREAM_GATE_MS'] ?? 30_000);
      const deadline = Date.now() + budgetMs;
      let lastErr = 'stream never became live';
      while (Date.now() < deadline) {
        if (isAborted(runId)) return;
        try {
          const resp = await fetch(`http://127.0.0.1:${Number(process.env['CRUCIBLE_PORT'] ?? 9230)}/api/devices/${gateUdid}/stream`, { method: 'POST' });
          if (resp.ok) {
            const { streamUrl } = await resp.json() as { streamUrl: string };
            // probe the upstream directly: a JPEG SOI in the first bytes
            // proves frames flow (emit-on-change MJPEG: even a static screen
            // emits the first full frame)
            const ctrl = new AbortController();
            const kill = setTimeout(() => ctrl.abort(), 4000);
            try {
              const body = await fetch(streamUrl, { signal: ctrl.signal });
              const reader = body.body!.getReader();
              // first chunk = multipart boundary text + headers + JPEG start.
              // scan for the SOI marker ANYWHERE in the chunk (also handles a
              // source that leads with raw JPEG bytes)
              const { value } = await reader.read();
              let soiAt = -1;
              if (value) {
                const scanEnd = Math.min(value.length, 4096);
                for (let i = 0; i + 3 <= scanEnd; i++) {
                  if (value[i] === 0xff && value[i + 1] === 0xd8 && value[i + 2] === 0xff) { soiAt = i; break; }
                }
              }
              if (value && soiAt !== -1 && value.length > 500) {
                try { await reader.cancel(); } catch { /* upstream gone */ }
                return; // stream is live
              }
              lastErr = value ? `stream source sent no JPEG frame (${value.length}B first chunk)` : 'stream source sent nothing';
            } finally { clearTimeout(kill); }
          } else { lastErr = `resolve route ${resp.status}`; }
        } catch (err) { lastErr = err instanceof Error ? err.message : String(err); }
        await new Promise((r) => setTimeout(r, 1500));
      }
      throw new Error(`stream gate failed: ${lastErr}`);
    }
    deps.bus.emit('run.phase', { runId, phase: 'stream' });
    const insStmt = deps.db.prepare(
      `INSERT INTO run_steps(run_id, idx, flow_name, kind, name, status, reason, started_at, duration_ms, evidence_ids_json, evaluated_json)
       VALUES (?, ?, ?, 'step', ?, ?, ?, ?, ?, ?, ?)`,
    );
    /** insert + emit step.finished — the write IS the finish. step.started
     *  fires at the top of the executing iteration (before dispatch), giving
     *  the run panel a real running window to highlight. */
    const insStep = {
      run(runId: string, idx: number, flow: string, name: string, status: string, reason: string | null, startedAt: number, durationMs: number, evidence: string, evaluated: string | null): void {
        insStmt.run(runId, idx, flow, name, status, reason, startedAt, durationMs, evidence, evaluated);
        deps.bus.emit('step.finished', { runId, idx, flow, name, status, durationMs });
      },
    };
    try {
      // ── readiness gate, phase 1: stream live ──
      // injectable seam (tests stub it); null skips (legacy direct mode)
      if (deps.awaitStreamLive !== null) {
        await (deps.awaitStreamLive ?? defaultAwaitStreamLive)(udid);
      }
      // self-heal: stale session binding / dead engine is the known class —
      // dispatchWithHeal reads the in-band envelope (dispatch never throws),
      // resets engine clients, retries once before failing the run
      // ── readiness gate, phase 2: fresh app ──
      // contract: ALWAYS reopen the target app before running — a stale
      // foreground app or leftover session state fails steps for the wrong
      // reason. simctl terminate is best-effort (not-running app → error we
      // ignore); then a fresh open with the watchdog.
      deps.bus.emit('run.phase', { runId, phase: 'app' });
      try {
        await execFileAsync('xcrun', ['simctl', 'terminate', udid, appToLaunch]);
      } catch { /* app not running — exactly what we want */ }
      const open = (await withWatchdog(runId, dispatchWithHeal('alloy_apps', { action: 'open', app: appToLaunch, udid, hold: false }, deps.dispatchDeps) as Promise<{ ok: boolean; error?: { message: string } }>, `open ${appToLaunch}`)) as { ok: boolean; error?: { message: string } };
      if (!open.ok) throw new Error(`open failed: ${open.error?.message ?? 'engine error'}`);

      // ── readiness gate, phase 2b: UI settle ──
      // 'open' resolves at PROCESS LAUNCH — the AX hierarchy is still empty
      // (measured live: Home labels appear at t+7.5s after a cold relaunch,
      // hierarchy=1 label until then). Steps dispatched into that window tap
      // a screen that does not exist yet — the recorded coordinate is right,
      // the moment is wrong. Poll until the app exposes a populated UI.
      deps.bus.emit('run.phase', { runId, phase: 'settle' });
      {
        const budgetMs = Number(process.env.CRUCIBLE_SETTLE_BUDGET_MS ?? 20_000);
        const pollMs = Number(process.env.CRUCIBLE_SETTLE_POLL_MS ?? 500);
        const minNodes = Number(process.env.CRUCIBLE_SETTLE_MIN_NODES ?? 2);
        const tStart = Date.now();
        // ⛔ abort-aware: an operator ■ stop during the settle gate must not
        // wait out the 20s budget (B2 promise: abort lands within one step).
        for (; !isAborted(runId);) {
          const snap = (await alloy.dispatch('alloy_snapshot', { udid, interactiveOnly: false }, deps.dispatchDeps)) as
            | { ok: true; result: { nodes?: SnapNode[] } } | { ok: false };
          const n = snap.ok ? (snap.result.nodes?.length ?? 0) : 0;
          // populated = the app root plus real UI content (minNodes=2;
          // test fixtures model root + UI nodes so static hierarchies
          // settle immediately).
          if (n >= minNodes) break;
          if (Date.now() - tStart > budgetMs) {
            // never wedged: proceed with whatever exists — the app may render
            // a splash with no AX content; steps' own settle-polls continue
            // waiting for their selectors
            break;
          }
          await new Promise((r) => setTimeout(r, pollMs));
        }
      }

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
      // run panel: announce the expanded plan — the panel cannot key step
      // events to template steps (expandFlows reindexes), so the truth ships.
      deps.bus.emit('run.plan', {
        runId, templateId, udid,
        steps: execSteps.map((s) => ({ idx: s.idx, action: s.action, name: stepLabel(s), flow: s.flow ?? null, optional: s.optional === true })),
      });
      deps.bus.emit('run.phase', { runId, phase: 'steps' });
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

      for (let si = 0; si < execSteps.length; si++) {
        const s = execSteps[si]!;
        const t0 = Date.now();
        // B2: operator abort — checked between steps; remaining steps skipped,
        // run aborted, device freed (B5 guard reads terminal status).
        if (isAborted(runId)) {
          insStep.run(runId, s.idx, s.flow ?? t.name, stepName(s), 'skip', 'aborted by operator', Date.now(), 0, '[]', null);
          continue;
        }
        // the panel's running highlight: this step is executing NOW (the
        // matching step.finished fires at the write, after dispatch settles)
        deps.bus.emit('step.started', { runId, idx: s.idx, flow: s.flow ?? t.name, name: stepName(s) });
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
              const human = selectorLabel(s.selector!);
              const reason = matched === 0 ? `not found: ${human} (${selJson})` : `ambiguous (${matched} matches): ${human} (${selJson})`;
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
          let resolvedBy: 'selector' | 'selector-recentred' | 'coordinate-fallback' | 'coordinate-fallback-scaled' | 'coordinate' | 'coordinate-scaled' | 'selector-point-scaled' = 'coordinate';
          if ((s.action === 'tap' || s.action === 'type') && s.selector && (s.selector.identifier || s.selector.label)) {
            // launch-settle poll (same class as expect A7): a fresh relaunch
            // takes ~2-3s to populate the AX hierarchy — resolving against
            // one immediate snapshot misses the selector and the coordinate
            // fallback taps BEFORE the UI exists. Poll until resolved or the
            // settle budget expires, THEN fall back.
            const settleBudgetMs = Number(process.env.CRUCIBLE_STEP_SETTLE_MS ?? 8000);
            const settlePollMs = Number(process.env.CRUCIBLE_STEP_SETTLE_POLL_MS ?? 60);
            let hit: { x: number; y: number; rect: { x: number; y: number; width: number; height: number } } | null = null;
            const settleStart = Date.now();
            // ⛔ keep the poll ABORT-AWARE: an operator ■ stop must not wait
            // out an 8s budget inside one step (B2's promise: abort ≤ one
            // step + watchdog). 250ms poll keeps the abort latent ≤250ms.
            while (Date.now() - settleStart < settleBudgetMs && !isAborted(runId)) {
              const snap = (await alloy.dispatch('alloy_snapshot', { udid, interactiveOnly: false }, deps.dispatchDeps)) as
                | { ok: true; result: { nodes?: SnapNode[] } } | { ok: false };
              hit = snap.ok ? resolveSelector(snap.result.nodes ?? [], s.selector) : null;
              if (hit) break;
              await new Promise((r) => setTimeout(r, settlePollMs));
            }
            if (hit) {
              // Recorded point is the ground truth of intent. The selector's
              // job is to CONFIRM the target is present, never to recentre:
              // ancestors/containers cover their children, so "point inside
              // matched rect" is common while the rect CENTER sits on a
              // DIFFERENT control (found live: tnc step 1's selector was the
              // footer page-dots container; its center is the ADJACENT
              // Privacy Policy link — the tap opened the wrong document).
              //   inside/near → tap the recorded point (scaled if the device
              //     differs; the settle-poll already proved the target live)
              //   far/absent  → the element genuinely moved (reflow, other
              //     device): selector center is the resilient choice
              const sx = (scaleX !== 1 || scaleY !== 1) && s.x !== undefined ? Math.round(s.x * scaleX) : s.x;
              const sy = (scaleX !== 1 || scaleY !== 1) && s.y !== undefined ? Math.round(s.y * scaleY) : s.y;
              const slack = 44; // pt — covers two-line link rects vs visible text run
              const near = sx !== undefined && sy !== undefined &&
                sx >= hit.rect.x - slack && sx <= hit.rect.x + hit.rect.width + slack &&
                sy >= hit.rect.y - slack && sy <= hit.rect.y + hit.rect.height + slack;
              if (near) {
                tx = sx as number; ty = sy as number;
                resolvedBy = (sx === s.x && sy === s.y) ? 'selector' : 'selector-point-scaled';
              } else {
                tx = hit.x; ty = hit.y; resolvedBy = 'selector-recentred';
              }
            } else {
              resolvedBy = 'coordinate-fallback';
              // fold-in fix (approved with YAML work): the selector missed —
              // on a DIFFERENT-SIZED device the raw recorded coordinates
              // would land off-target (the scaling branch above is skipped
              // when a selector exists). Scale the fallback coordinates too.
              if ((scaleX !== 1 || scaleY !== 1) && s.x !== undefined && s.y !== undefined) {
                tx = Math.round(s.x * scaleX);
                ty = Math.round(s.y * scaleY);
                resolvedBy = 'coordinate-fallback-scaled';
              }
            }
          } else if ((scaleX !== 1 || scaleY !== 1) && s.x !== undefined && s.y !== undefined) {
            // selector-less step on a different-size device — scale proportionally
            tx = Math.round(s.x * scaleX);
            ty = Math.round(s.y * scaleY);
            resolvedBy = 'coordinate-scaled';
          }
          let input: Record<string, unknown>;
          if (s.action === 'tap') {
            // settle:false — the engine's fixed ~2.4s settle is replaced by the
            // state-based wait below (next-step selector poll / UI-stability)
            input = { udid, action: 'press', target: { x: tx, y: ty }, settle: false };
            // run panel overlay: where this tap lands, in logical pts
            // (targetW/H — same dims the scaling math uses, null pre-snapshot)
            if (tx !== undefined && ty !== undefined) {
              deps.bus.emit('step.tap', { runId, idx: s.idx, x: tx, y: ty, logicalW: targetW ?? 0, logicalH: targetH ?? 0 });
            }
          }
          else if (s.action === 'scroll') input = { udid, action: 'scroll', direction: s.direction, settle: false };
          else input = { udid, action: 'fill', target: { x: tx, y: ty }, text: resolved.text ?? '', settle: false };
          const r = (await withWatchdog(runId, alloy.dispatch('alloy_act', input, deps.dispatchDeps) as Promise<{ ok: boolean; error?: { message: string } }>, stepName(s))) as { ok: boolean; error?: { message: string } };
          if (!r.ok) throw new Error(r.error?.message ?? 'engine error');
          // ── adaptive settle (replaces settle:true's fixed ~2.4s) ──
          // If the NEXT step resolves by selector, its settle-poll waits for
          // the exact target to exist — a stronger wait than any time-based
          // one, so no extra cost here. Only when the next step fires blind
          // (raw coordinates) or this is the last step (final evidence
          // screenshot must not catch mid-animation) do we wait for the UI
          // to actually go quiet.
          const nextStep = si + 1 < execSteps.length ? execSteps[si + 1]! : null;
          const nextPollsSelector = !!(nextStep && (nextStep.action === 'tap' || nextStep.action === 'type' || nextStep.action === 'expect')
            && nextStep.selector && (nextStep.selector.identifier || nextStep.selector.label));
          if (!nextPollsSelector) {
            const budgetMs = Number(process.env.CRUCIBLE_UI_STABLE_MS ?? 1500);
            await awaitUiStable(async () => {
              const snap = (await alloy.dispatch('alloy_snapshot', { udid, interactiveOnly: false }, deps.dispatchDeps)) as
                | { ok: true; result: { nodes?: SnapNode[] } } | { ok: false };
              return snap.ok ? (snap.result.nodes ?? []) : null;
            }, runId, budgetMs);
          }
          // 'selector-point-scaled' folds into 'selector' for the audit trail —
          // the scale factors already live in evaluated_json's scale context
          const resolvedByOut = resolvedBy === 'selector-point-scaled' ? 'selector' : resolvedBy;
          insStep.run(runId, s.idx, s.flow ?? t.name, stepName(s), 'pass', null, t0, Date.now() - t0, '[]', JSON.stringify({ ...resolved, resolvedBy: resolvedByOut, ...(s.flow ? { flow: s.flow } : {}) }));
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
      if (restorePresets) {
        try {
          forgeStateService(deps).clearScenario();
        } catch { /* restore best-effort */ }
      }
      deps.forgeState.activeRunId = null;
      // B1: clear the addon's attribution too — rows after this point belong
      // to no run. (If a scenario restored above, that write already reset
      // activeRunId implicitly via the null default — this one is explicit.)
      try { forgeStateService(deps).setActiveRun(null); } catch { /* clear best-effort */ }
      // B2: operator abort wins over the loop's natural verdict
      if (isAborted(runId)) runStatus = 'aborted';
      abortedRuns.delete(runId); // registry entry no longer needed once terminal
      deps.db.prepare(`UPDATE runs SET status = ?, finished_at = ?, blocked = ? WHERE id = ?`).run(runStatus, Date.now(), runBlocked, runId);
      deps.bus.emit('run.finished', { runId, status: runStatus });
    }
  })();

  return { runId, udid, done };
}
