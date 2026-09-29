/** Template playback: replays recorded steps as an automated-ish manual run.
 *  Truth = "steps executed + evidence + traffic" (user decision, phase 2):
 *  - runs row kind='manual', run_steps row per replayed step (pass/fail/skip)
 *  - final screenshot ingested as evidence
 *  - forge activeRunId set for the duration → traffic rows attach to the run
 *  No image assertions — failure is an engine dispatch error or missing field. */
import { prunePreviousRunArtifacts } from '../evidence/retention.ts';
import { RunDialogPolicy, AlertStormError, parseAlertPolicyColumn, ALERT_CAP } from './dialog-policy.ts';
import { EvidenceRecorder } from './evidence-recorder.ts';
function crucibleAlloySafe(): { resetEngineBCache?: () => void } | null {
  // synchronous respawn via the cached engine exports (safe in prod path;
  // tests inject fakes and simply skip respawn)
  try {
    return crucibleAlloy() as unknown as { resetEngineBCache?: () => void };
  } catch {
    return null;
  }
}
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
import type { TypedEventBus, AppEvents } from '../ws/bus.ts';
import { crucibleAlloy } from '../alloy/client.ts';
import { dispatchWithHeal } from '../alloy/heal.ts';
import type { ForgeState } from '../forge/proxy.ts';
import { substituteStep, expandEnvText } from './template-env.ts';
import { resolveEnv } from './env-store.ts';
import { forgeStateService } from '../forge/state.ts';
import { classifyBlocked } from '../db/blocked.ts';
import { resolveSelector, countMatches, selectorLabel, matchesSelector, captureSelectorAt, type StepSelector } from './selector.ts';
import { recordTap } from '../evidence/taps-store.ts';
import type { SnapNode } from './selector.ts';
import { sweepTriggered, blindContainerAt, probePoints, sweepFind } from './sweep.ts';
import { makeProbe, type SnapNodeLike } from '../alloy/probe.ts';
import { fetchEngineTree } from '../alloy/engine-tree.ts';
import { expandFlows } from './flows.ts';
import type { FlowStep } from './flows.ts';
import { listSimulatorApps } from './apps.ts';
import { lastArtifactFor } from './app-catalog-store.ts';
import { setLocation, clearLocation, prodExecute } from './location.ts';
import { ensureLocationGrant } from './location-tcc.ts';
import { internalAuthHeaders } from '../auth/roles.ts';
import { snapshotCaseVersion } from './case-versions.ts';
import { mergeVariantEnv, variantScenarioNames, type YamlVariant } from '@crucible/shared/yaml-variants';

const defaultListApps = (udid: string): Promise<Array<{ bundleId: string }>> =>
  listSimulatorApps(udid).then((apps) => apps.map((a) => ({ bundleId: a.bundleId })));

/** Tier 2.3 — location ops. Default: TCC row write + locationd kickstart
 *  (grant), simctl shells (set/clear). Injected as a seam for tests. */
const defaultLocationControl = {
  grant: (udid: string, bundleId: string) => ensureLocationGrant(udid, bundleId),
  set: (udid: string, lat: number, lon: number) => setLocation(prodExecute, udid, lat, lon),
  clear: (udid: string) => clearLocation(prodExecute, udid),
};

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
  /** network conditioner seam (plan 20260928T153608Z): default = the
   *  Baguette CLI shim. Tests inject fakes; null disables conditioning. */
  networkCondition?: ((udid: string, op: { kind: 'set'; profile: string } | { kind: 'clear' }) => Promise<{ ok: boolean; reason?: string; detail?: string }>) | null;
  /** location ops seam (Tier 2.3): grant/set/clear. Default = TCC write +
   *  simctl shells. Tests inject fakes. */
  locationControl?: {
    grant: (udid: string, bundleId: string) => Promise<{ granted: true; inserted: boolean }>;
    set: (udid: string, lat: number, lon: number) => Promise<{ set: true; coordinate: string }>;
    clear: (udid: string) => Promise<{ cleared: true }>;
  };
}

export interface PlaybackStep {
  idx: number;
  action: 'tap' | 'scroll' | 'type' | 'runFlow' | 'expect' | 'alert' | 'location' | 'arrive' | 'refresh' | 'swap' | 'expectScreen' | 'ensureLogout' | 'ensureLogin';
  x?: number;
  y?: number;
  direction?: 'up' | 'down' | 'left' | 'right';
  text?: string;
  /** Maestro-style soft step: a dispatch miss records skip, run stays green
   *  (interstitial popups, "dismiss if shown"). Missing env still hard-fails. */
  optional?: boolean;
  /** optional per-step Gherkin AC line (plan 20260929T030722Z) — display-only */
  narrate?: string;
  /** A6 element selector — resolved against the live hierarchy at playback */
  selector?: { identifier?: string; label?: string; type?: string };
  /** A5 subflow reference — expanded to child steps before execution */
  templateId?: string;
  /** set by expandFlows: child flow name for run_steps provenance */
  flow?: string;
  /** setup-only guard: snapshot existence check (labelContains, ignoreCase)
   *  BEFORE dispatch — absent element = no-op skip (dismiss-if-shown). */
  when?: string;
  /** expect-only cardinality (A9): exactly N (count) or ≥ N (atLeast).
   *  Absent both → the default exactly-1 contract. */
  count?: number;
  atLeast?: number;
  /** alert action target — accept or dismiss the frontmost system dialog */
  alertAction?: 'accept' | 'dismiss';
  /** location action target — simulated GPS point (simctl location set) */
  location?: { latitude: number; longitude: number };
  /** ensure logout: coordinate-free session preflight (identifier-first) */
  ensureLogout?: { button: string; stay: string; confirm: string; via?: string };
  /** ensure login: coordinate-free login preflight; phone/password are
   *  ${env.X} refs resolved at playback — never literal secrets */
  ensureLogin?: { entry: string; phoneField: string; passwordField: string; submit: string; session: string; phone: string; password: string; screen?: string };
  /** R2 verbs (S5): arrive/refresh target screen; swap target id; expect screen parts */
  screen?: string;
  swap?: string;
  expectScreen?: { screen: string; state: string; negate?: boolean };
}

interface TemplateRow {
  id: string;
  name: string;
  ticket_key: string | null;
  udid: string;
  steps_json: string;
  setup_json: string | null;
  alerts_policy: string | null;
  app_bundle_id: string | null;
  logical_w: number | null;
  logical_h: number | null;
}

function stepName(s: PlaybackStep): string {
  if (s.action === 'expect') return `expect ${selectorLabel(s.selector ?? {})}`;
  if (s.action === 'runFlow') return `run flow ${s.templateId ?? '?'}`;
  if (s.action === 'tap') return s.x !== undefined ? `tap ${s.x},${s.y}` : `tap ${s.selector ? (s.selector.label ?? s.selector.identifier ?? 'selector') : '?'}`;
  if (s.action === 'scroll') return `scroll ${s.direction}`;
  if (s.action === 'ensureLogout') return `ensure logout (${s.ensureLogout?.button ?? '?'})`;
  if (s.action === 'ensureLogin') return `ensure login (${s.ensureLogin?.screen ? `screen ${s.ensureLogin.screen}` : s.ensureLogin?.entry ?? '?'})`;
  if (s.action === 'alert') return `alert ${s.alertAction ?? 'dismiss'}`;
  if (s.action === 'location') return `location ${s.location?.latitude ?? '?'}${s.location?.longitude !== undefined ? ',' : ''}${s.location?.longitude ?? ''}`;
  if (s.action === 'arrive') return `arrive ${s.screen ?? '?'}`;
  if (s.action === 'refresh') return `refresh ${s.screen ?? '?'}`;
  if (s.action === 'swap') return `swap ${s.swap ?? '?'}`;
  if (s.action === 'expectScreen') return `expect screen ${s.expectScreen?.screen ?? '?'}.${s.expectScreen?.state ?? '?'}${s.expectScreen?.negate ? ' (absent)' : ''}`;
  return `type "${(s.text ?? '').slice(0, 20)}"`;
}

/** Panel-facing summary of an expanded step (run.plan / step events). */
function stepLabel(s: PlaybackStep): string {
  if (s.action === 'expect') return `expect ${s.selector?.label ?? s.selector?.identifier ?? '?'}`;
  if (s.action === 'runFlow') return `run flow ${s.templateId ?? '?'}`;
  if (s.action === 'tap') return s.selector ? `tap ${s.selector.label ?? s.selector.identifier ?? ''}`.trim() : `tap ${s.x},${s.y}`;
  if (s.action === 'scroll') return `scroll ${s.direction}`;
  if (s.action === 'arrive') return `arrive ${s.screen ?? '?'}`;
  if (s.action === 'refresh') return `refresh ${s.screen ?? '?'}`;
  if (s.action === 'swap') return `swap ${s.swap ?? '?'}`;
  if (s.action === 'expectScreen') return `screen ${s.expectScreen?.screen ?? '?'}.${s.expectScreen?.state ?? '?'}`;
  if (s.action === 'alert') return `alert ${s.alertAction ?? 'dismiss'}`;
  if (s.action === 'location') return `location ${s.location?.latitude ?? '?'}${s.location?.longitude !== undefined ? ',' : ''}${s.location?.longitude ?? ''}`;
  return `type "${(s.text ?? '').slice(0, 20)}"`;
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
    public code: 'DEVICE_BUSY' | 'APP_NOT_INSTALLED' | 'DEVICE_AMBIGUOUS' | 'LOCATION_GRANT_FAILED' | 'VERSION_SNAPSHOT_FAILED' | 'SCENARIO_INACTIVE',
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

/** Mark a run aborted. Terminal runs are a no-op ({already}) — idempotent.
 * The RECORD flip stays the run's own finally (B2: abort lands between
 * steps, never kills a dispatched promise) — but the ack is immediate:
 * with a bus, run.aborted fires here so live trackers clear at click
 * time instead of waiting out the current step. */
export function abortRun(db: Database.Database, runId: string, bus?: { emit: (type: 'run.aborted', payload: { queueId: string; runId?: string; templateId?: string }) => void }): { ok: true } | { already: 'finished' } {
  const run = db.prepare(`SELECT status, template_id FROM runs WHERE id = ?`).get(runId) as { status: string; template_id: string | null } | undefined;
  if (!run) throw new Error(`run ${runId} not found`);
  if (run.status !== 'queued' && run.status !== 'running') return { already: 'finished' };
  abortedRuns.add(runId);
  bus?.emit('run.aborted', { queueId: runId, runId, ...(run.template_id ? { templateId: run.template_id } : {}) });
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

/** Structure-only signature: node TYPE+IDENTIFIER shape, label text excluded.
 *  Some production screens animate a label's TEXT continuously (live: Home's
 *  search-bar placeholder re-types itself ~10×/s — 31 sig changes in 12s),
 *  which makes hierarchySig never repeat and holds every settle gate open for
 *  its full budget (drill 2026-09-25: tap settle paid 8s/step for that alone).
 *  Layout/structure churn (navigation, content streaming, node add/remove)
 *  still changes this signature — only same-shape text mutation passes. */
function structureSig(nodes: SnapNode[]): string {
  return (nodes ?? [])
    .map((n) => `${n.type ?? ''}|${n.identifier ?? ''}`)
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
      const sig = structureSig(nodes);
      if (sig === prev) return true; // two structurally identical reads — UI quiet (label churn ignored)
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


export async function runTemplatePlayback(deps: PlaybackDeps, templateId: string, opts: { udid?: string; triggeredBy?: string; scenarioId?: string; bundleId?: string; env?: Record<string, string>; forgeAttribution?: boolean; variant?: YamlVariant | null; suiteId?: string | null; batchId?: string | null; planId?: string | null }): Promise<{ runId: string; udid: string; done: Promise<void> }> {
  const t = deps.db.prepare('SELECT id, name, ticket_key, udid, steps_json, setup_json, alerts_policy, app_bundle_id, logical_w, logical_h FROM templates WHERE id = ?').get(templateId) as TemplateRow | undefined;
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
  // ── Tier 2.3: CoreLocation grant, route-level fail-fast ──
  // The TCC row only takes effect on app relaunch — granting BEFORE the
  // run row + open means the fresh launch picks it up in ONE relaunch and
  // a grant failure surfaces as a named route error with NO phantom run
  // (same contract as APP_NOT_INSTALLED). Granting at the first location
  // STEP would force a disruptive mid-run restart.
  const locationOps = deps.locationControl ?? defaultLocationControl;
  // network conditioner default: the Baguette CLI shim (lazy import keeps
  // test startup free of binary resolution)
  const defaultNetworkCondition: NonNullable<PlaybackDeps['networkCondition']> = async (udid, op) => {
    const { baguetteNetwork } = await import('../forge/baguette-network.ts');
    return baguetteNetwork(udid, op);
  };
  if (steps.some((st) => st.action === 'location')) {
    try {
      await locationOps.grant(udid, appToLaunch);
    } catch (err) {
      throw new PlaybackError('LOCATION_GRANT_FAILED', `CoreLocation grant failed: ${err instanceof Error ? err.message : String(err)}`, { appBundleId: appToLaunch, udid });
    }
  }
  const runId = `run_${createHash('sha256').update(`playback${templateId}${Date.now()}`).digest('hex').slice(0, 8)}`;
  // build anchoring: stamp the installed app's version at run creation
  // (best-effort — non-bundle fallbacks render 'unknown')
  let appVersion: string | null = null;
  let appBuild: string | null = null;
  try {
    const { listSimulatorApps } = await import('./apps.ts');
    const installed = (await listSimulatorApps(udid)).find((a) => a.bundleId === appToLaunch);
    appVersion = installed?.version ?? null;
    appBuild = installed?.build ?? null;
  } catch { /* version best-effort */ }
  // Phase A — provenance snapshot BEFORE any step executes (and before the
  // self-hardening sweep can rewrite steps_json mid-run: that rewrite bumps
  // the NEXT run's revision, never this one's). A run that cannot name its
  // version is not evidence — snapshot failure aborts honestly.
  let version: ReturnType<typeof snapshotCaseVersion>;
  // D3: variant scenario overrides the invocation's (narrowest scope);
  // variant without scenario INHERITS the invocation's.
  // S2: variants may carry a scenario SET (plural) — resolve every name to
  // its id; activation applies the union (dedupe by preset id below).
  // Variants carry scenario NAMES (phase B vocabulary validates names);
  // snapshot + activation key on ids — resolve, and keep the raw CHOICE for
  // run provenance (a deleted scenario still records what was requested).
  const scenarioNames = variantScenarioNames(opts.variant ?? null);
  const scenarioChoice = scenarioNames.length > 0 ? scenarioNames.join('+') : opts.scenarioId ?? null;
  const scenarioIds: string[] = [];
  for (const name of scenarioNames.length > 0 ? scenarioNames : (opts.scenarioId ? [opts.scenarioId] : [])) {
    const id = (deps.db.prepare('SELECT id FROM scenarios WHERE id = ? OR name = ? LIMIT 1').get(name, name) as { id: string } | undefined)?.id;
    if (id) scenarioIds.push(id);
  }
  const scenarioId = scenarioIds[0] ?? null; // primary (snapshot provenance + pre-flight gate)
  // T7 — forge pre-flight: a scenario run needs the proxy + routing ALIVE.
  // The chain dies silently on restarts; without this gate the run plays the
  // full case against the real network and fails `not found: <text>` —
  // minutes of wasted playback pointing at the wrong layer. Fail BEFORE the
  // run row exists (no run, no artifacts, honest 409 with the fix).
  if (scenarioId) {
    const { forgePreflight } = await import('../forge/health.ts');
    const pf = forgePreflight(scenarioChoice!);
    if (pf) throw new PlaybackError('SCENARIO_INACTIVE' as PlaybackError['code'], pf.message, { appBundleId: appToLaunch, udid });
  }
  try {
    version = snapshotCaseVersion(deps.db, { templateId, scenarioId, variant: opts.variant ?? null, triggeredBy: opts.triggeredBy ?? null });
  } catch (err) {
    throw new PlaybackError('VERSION_SNAPSHOT_FAILED', `case-version snapshot failed: ${err instanceof Error ? err.message : String(err)}`, { appBundleId: appToLaunch, udid });
  }
  deps.db
    .prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at, note, template_id, app_version, app_build, case_version_id, scenario_id, scenario_sha, variant_id, suite_id, batch_id)
              VALUES (?, ?, 'manual', 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(runId, t.ticket_key ?? '-', opts.triggeredBy ?? 'qa', udid, Date.now(), `template:${templateId} ${t.name}${opts.variant ? ` / ${opts.variant.id}` : ''}${opts.variant?.network ? ` · net:${opts.variant.network}` : ''}`, templateId, appVersion, appBuild, version.id, scenarioChoice, version.scenarioSha, opts.variant?.id ?? null, opts.suiteId ?? null, opts.batchId ?? null);
  // the runner just observed this bundle's INSTALLED version — write it
  // through so the cases list always shows the last runner context, not a
  // value frozen at record/create time
  if (appVersion != null) {
    deps.db
      .prepare('UPDATE templates SET app_version = ? WHERE id = ? AND (app_version IS NULL OR app_version != ?)')
      .run(appVersion, templateId, appVersion);
  }
  deps.bus.emit('run.started', { runId, ticketKey: t.ticket_key ?? '-', udid, templateId });
  // latest-only evidence: this run replaces the previous run's artifacts —
  // UNLESS a sibling run of the same template is still RUNNING (parallel
  // batches on two devices): the prune would delete the sibling's evidence
  // mid-flight. Belt to the planner's dedupe; finished runs still prune.
  const runningSibling = deps.db
    .prepare(`SELECT 1 FROM runs WHERE template_id = ? AND status IN ('queued','running') AND id != ? LIMIT 1`)
    .get(templateId, runId);
  if (!runningSibling) prunePreviousRunArtifacts({ db: deps.db, artifactsDir: deps.artifactsDir }, { templateId, variantId: opts.variant?.id ?? null }, runId);

  // managed env (plan rev 2 S2): resolved ONCE before the run starts — the
  // done closure's activeEnv seeds from it AND the finally-block audit line
  // reads its source counts. Scope chain: global < app < plan < request body
  // (< variant, merged later by mergeVariantEnv — narrowest wins).
  const resolvedBase = resolveEnv(deps.db, { appBundleId: tpl.app_bundle_id, planId: opts.planId ?? null, requestEnv: opts.env ?? {} });

  // background execution — route returns immediately; done settles at finish
  const done = (async () => {
    const alloy = crucibleAlloy();
    // traffic attribution: everything the proxy sees while active belongs to
    // this run — UNLESS parallel attribution is off (multi-lane batches:
    // the proxy can't tell sims apart; a stray set/clear would corrupt a
    // sibling's attribution, so BOTH writes are skipped).
    const attribute = opts.forgeAttribution !== false;
    if (attribute) deps.forgeState.activeRunId = runId;
    // B1: mirror to the addon state file so the mitm addon stamps rows with
    // this run id (in-process proxy reads forgeState directly; the addon tails
    // the file). Best-effort: attribution fails soft if the dir is missing.
    if (attribute) { try { forgeStateService(deps).setActiveRun(runId); } catch { /* attribution best-effort */ } }
    // network choice (phase 4): scenario presets active ONLY during the run.
    // S2: a variant's scenario SET activates the UNION of member presets
    // (dedupe by preset id — a preset shared by two scenarios fires once).
    let restorePresets: Array<Record<string, unknown>> | null = null; // non-null ⇒ scenario activated (service owns restore)
    if (scenarioIds.length > 0) {
      const ph = scenarioIds.map(() => '?').join(',');
      const presets = deps.db.prepare(
        `SELECT DISTINCT p.* FROM presets p JOIN scenario_overrides so ON so.preset_id = p.id WHERE so.scenario_id IN (${ph}) AND so.enabled = 1`,
      ).all(...scenarioIds) as Array<Record<string, unknown>>;
      restorePresets = deps.db.prepare('SELECT * FROM presets ORDER BY created_at DESC').all() as Array<Record<string, unknown>>;
      try {
        forgeStateService(deps).activateScenario(presets);
      } catch { /* network best-effort — run proceeds without scenario */ }
    }
    let runStatus: 'passed' | 'failed' | 'aborted' = 'passed';
    let skipAllSteps = false; // dialog interceptor: steps already skip-written
    // Tier 2.3 — location plumbing (run-scoped): locationOps is the ops
    // seam declared at route level; the flag below arms the finally-clear.
    let locationSet = false;
    let conditionSet = false; // network conditioner hygiene flag (same lifecycle as locationSet)
    const recorder = new EvidenceRecorder(
      { db: deps.db, artifactsDir: deps.artifactsDir, dispatchDeps: deps.dispatchDeps,
        dispatch: (tool, input, dd) => alloy.dispatch(tool, input, dd) as never,
        respawnToolServer: () => { crucibleAlloySafe()?.resetEngineBCache?.(); } },
      runId, udid,
    );
    // whole-run video: started FIRST (before open) — see EvidenceRecorder.
    await recorder.startVideo();
    // alert policy (run-level): null = every dialog fails named (default).
    const dialogs = new RunDialogPolicy(parseAlertPolicyColumn(tpl.alerts_policy), {
      dispatch: (tool, input) => alloy.dispatch(tool, input, deps.dispatchDeps) as never,
    });
    const alertPolicy = dialogs.isNull ? null : 'policy';
    const noteLines = dialogs.noteLines;
    const drainDialogs = (site: string): Promise<number> => dialogs.drain(udid, site);
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
          const resp = await fetch(`http://127.0.0.1:${Number(process.env['CRUCIBLE_PORT'] ?? 9230)}/api/devices/${gateUdid}/stream`, { method: 'POST', headers: internalAuthHeaders() });
          if (resp.ok) {
            const body = await resp.json() as { streamUrl?: string; simdeckUrl?: string };
            // Wrapped device surface (current engine): the resolve route only
            // answers 200 after its own child health probe (ensureSimdeck),
            // so a simdeckUrl in the body IS the stream-live proof. The legacy
            // field (streamUrl, MJPEG multipart) keeps the JPEG-SOI probe.
            if (typeof body.simdeckUrl === 'string' && body.simdeckUrl.length > 0) return;
            const streamUrl = body.streamUrl;
            if (!streamUrl) {
              lastErr = 'resolve route returned neither simdeckUrl nor streamUrl';
            } else {
            // probe the upstream directly: a JPEG SOI in the first bytes
            // proves frames flow (emit-on-change MJPEG: even a static screen
            // emits the first full frame)
            const ctrl = new AbortController();
            const kill = setTimeout(() => ctrl.abort(), 4000);
            try {
              const up = await fetch(streamUrl, { signal: ctrl.signal });
              const reader = up.body!.getReader();
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
            }
          } else { lastErr = `resolve route ${resp.status}`; }
        } catch (err) { lastErr = err instanceof Error ? err.message : String(err); }
        await new Promise((r) => setTimeout(r, 1500));
      }
      throw new Error(`stream gate failed: ${lastErr}`);
    }
    deps.bus.emit('run.phase', { runId, phase: 'stream' });
    const insStmt = deps.db.prepare(
      `INSERT INTO run_steps(run_id, idx, flow_name, kind, name, status, reason, started_at, duration_ms, evidence_ids_json, evaluated_json, narrate)
       VALUES (?, ?, ?, 'step', ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    /** insert + emit step.finished — the write IS the finish. step.started
     *  fires at the top of the executing iteration (before dispatch), giving
     *  the run panel a real running window to highlight. */
    const insStep = {
      run(runId: string, idx: number, flow: string, name: string, status: string, reason: string | null, startedAt: number, durationMs: number, evidence: string, evaluated: string | null, narrate: string | null): void {
        insStmt.run(runId, idx, flow, name, status, reason, startedAt, durationMs, evidence, evaluated, narrate);
        deps.bus.emit('step.finished', { runId, idx, flow, name, status, durationMs, narrate });
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
      // ── network conditioner (plan 20260928T153608Z rev 2) ──
      // The variant pin degrades the SIMULATOR's link BEFORE any app process
      // exists: Baguette injects VirtualNetwork.dylib at exec time, so the
      // condition must be set before the terminate/sweep/open dance (the
      // sweep probe itself relaunches the app via reverifyEnv). Unpinned
      // runs touch NOTHING — a manual condition set from the UI survives.
      const networkPin = opts.variant?.network ?? null;
      if (networkPin) {
        const cond = deps.networkCondition === undefined ? defaultNetworkCondition : deps.networkCondition;
        if (cond) {
          const r = await cond(udid, { kind: 'set', profile: networkPin });
          if (!r.ok) {
            throw new PlaybackError('NETWORK_CONDITION_FAILED' as PlaybackError['code'], `network conditioner unavailable for profile "${networkPin}" — ${r.detail ?? r.reason ?? 'failed'}`, { appBundleId: appToLaunch, udid });
          }
          conditionSet = true;
        }
      }
      try {
        await execFileAsync('xcrun', ['simctl', 'terminate', udid, appToLaunch]);
      } catch { /* app not running — exactly what we want */ }
      // Sweep warm-up (Task 2b, REVISED 2026-09-05): the app is now DEAD —
        // a throwaway probe hits requiresAppRestart → reverifyEnv(), which
        // applies the DYLD env the single open then relaunches under. Zero
        // extra launches (the old restart→probe→restart carousel ran TWO
        // relaunches after the settle gate and wasted it). On a warm sim the
        // env is already set and the probe is a cheap no-op. Eligible only
        // when a step can use the sweep; CRUCIBLE_SWEEP=off kills it.
        const sweepEnabled = process.env['CRUCIBLE_SWEEP'] !== 'off';
        let probeFn: ((x: number, y: number) => Promise<SnapNodeLike[]>) | null = null;
        const sweepEligible = sweepEnabled && steps.some((st) =>
          ((st.action === 'tap' || st.action === 'type') && st.selector && (st.selector.identifier || st.selector.label)) ||
          (st.action === 'expect' && st.selector));
        if (sweepEligible) {
          try {
            const rawProbe = makeProbe((tool, input, d) => alloy.dispatch(tool, input, d) as never, deps.dispatchDeps, udid, appToLaunch);
            await rawProbe(1, 1); // app dead → requiresAppRestart → env applied
            probeFn = rawProbe;
          } catch { /* warm-up failure never blocks the run — sweep degrades to off */ }
        }
        // ── Tier 2.3: CoreLocation grant already happened route-level
        // (before the run row) — nothing to do here; the open below is the
        // single relaunch that picks the TCC row up. ──
      const open = (await withWatchdog(runId, // -uitest-live-refresh: the app's test seam — appear-triggered fetches
      // keep refiring under Crucible (world swaps need the re-fetch; guard 1
      // verifies it). Inert on builds that don't read the arg.
      dispatchWithHeal('alloy_apps', { action: 'open', app: appToLaunch, udid, hold: false, launchArgs: ['-uitest-live-refresh'] }, deps.dispatchDeps) as Promise<{ ok: boolean; error?: { message: string } }>, `open ${appToLaunch}`)) as { ok: boolean; error?: { message: string } };
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

      // Declared preconditions (setup): parsed steps run through the same
      // engine, flow-tagged 'setup'. when-guards evaluate BEFORE dispatch —
      // absent guard element = no-op skip (dismiss-if-shown semantics).
      let setupSteps: PlaybackStep[] = [];
      if (tpl.setup_json) {
        try { setupSteps = JSON.parse(tpl.setup_json) as PlaybackStep[]; } catch { setupSteps = []; }
      }

      // A5: expand subflows flat — child steps carry flow + inherited optional
      let execSteps: PlaybackStep[];
      // R2 S5: the case's v2 facets (worlds/entry/variants) for verb steps —
      // variants_json holds both vocabularies (worlds persist via S4).
      const r2case: { swaps?: Array<{ id: string; networkScenario?: string; scenarios?: string[]; env?: Record<string, string> }>; worlds?: Array<{ id: string; networkScenario?: string; scenarios?: string[]; env?: Record<string, string> }>; variants?: Array<{ id: string; networkScenario?: string; scenarios?: string[]; env?: Record<string, string> }>; entry?: { screen: string; mode?: 'tab' | 'deepLink' | 'navigate' } } | null = (() => {
        try {
          const vj = deps.db.prepare('SELECT variants_json FROM templates WHERE id = ?').get(templateId) as { variants_json: string | null } | undefined;
          if (!vj?.variants_json) return null;
          const parsed: unknown = JSON.parse(vj.variants_json);
          // variants_json is a PLAIN ARRAY (house format since phase B) —
          // worlds and variants share it; the pool lookup treats the array
          // as both vocabularies. Object form (worlds/variants keys) is
          // accepted too for forward compatibility.
          if (Array.isArray(parsed)) return { swaps: parsed as Array<{ id: string; networkScenario?: string; scenarios?: string[]; env?: Record<string, string> }>, variants: parsed as Array<{ id: string; networkScenario?: string; scenarios?: string[]; env?: Record<string, string> }> };
          if (parsed && typeof parsed === 'object') return parsed as { swaps?: Array<{ id: string; networkScenario?: string; scenarios?: string[]; env?: Record<string, string> }>; worlds?: Array<{ id: string; networkScenario?: string; scenarios?: string[]; env?: Record<string, string> }>; variants?: Array<{ id: string; networkScenario?: string; scenarios?: string[]; env?: Record<string, string> }>; entry?: { screen: string; mode?: 'tab' | 'deepLink' | 'navigate' } };
          return null;
        } catch { return null; }
      })();
      // R2 S5: lazy screen-state runner (verbs construct it on first use)
      let screenRunner: InstanceType<typeof import('./screen-runner.ts').ScreenRunner> | null = null;
      // R2 S6 + managed env (plan rev 2 S2): activeEnv = variant over
      // resolvedBase (managed scopes global < app < plan under the request
      // body; variants stay narrowest — pinned contract). resolvedBase is
      // declared ABOVE the done closure so the finally-block audit line can
      // read it; a world: step re-merges its variant over the SAME base —
      // never over bare opts.env (review F1: that would drop every managed
      // value mid-run).
      let activeEnv = mergeVariantEnv(opts.variant ?? null, resolvedBase.env);
      // R2 evidence attribution: which swap target the run is currently IN
      // (starts as the entry lane's variant; each swap: step updates it) —
      // the evidence sheet groups world screenshots by this, not by the lane
      let activeSwap: string | null = opts.variant?.id ?? null;
      try {
        execSteps = expandFlows(steps as unknown as FlowStep[], (id) => {
          const row = deps.db.prepare('SELECT name, steps_json FROM templates WHERE id = ?').get(id) as { name: string; steps_json: string } | undefined;
          return row ? { name: row.name, steps: JSON.parse(row.steps_json) as FlowStep[] } : null;
        }) as unknown as PlaybackStep[];
      } catch (err) {
        throw new Error(`subflow expansion failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (setupSteps.length > 0) {
        execSteps = [
          ...setupSteps.map((ss) => ({ ...ss, flow: 'setup' })),
          ...execSteps,
        ].map((es, i) => ({ ...es, idx: i }));
      }
      // run panel: announce the expanded plan — the panel cannot key step
      // events to template steps (expandFlows reindexes), so the truth ships.
      deps.bus.emit('run.plan', {
        runId, templateId, udid,
        steps: execSteps.map((s) => ({ idx: s.idx, action: s.action, name: stepLabel(s), flow: s.flow ?? null, optional: s.optional === true, narrate: s.narrate ?? null })),
      });
      // Task 3 — system-dialog interceptor (run-start site): permission dialogs
      // render in SpringBoard, so the app AX tree stays populated behind them
      // (drill run_852f6fbc). One alert-inspect after the settle gate; a dialog
      // present BEFORE step 1 means the case's preconditions are unmet — name
      // it and fail. Fail-open: inspect errors never block the run.
      {
        // engine contract (probed live): dialog present → ok:true with a
        // message; none → ok:false "alert not found". ok:true IS presence.
        const insp = (await alloy.dispatch('alloy_alert', { udid, action: 'inspect' }, deps.dispatchDeps)) as
          | { ok: true; result: { message?: string } } | { ok: false };
        const firstIsAlert = execSteps[0]?.action === 'alert';
        if (insp.ok && insp.result?.message && !firstIsAlert && alertPolicy === null) {
          // case-level failure (not infra): a dialog blocking before step 1
          // means declared preconditions are unmet — fail the run with the
          // dialog NAMED; steps never execute (skip rows, finally still owns
          // terminal bookkeeping — no early return past the claims).
          const what = insp.result?.message ?? 'unknown system dialog';
          runStatus = 'failed';
          deps.db.prepare(`UPDATE runs SET note = ? WHERE id = ?`).run(`blocked by system dialog: ${what}`, runId);
          for (const st of execSteps) {
            insStep.run(runId, st.idx, st.flow ?? t.name, stepName(st), 'skip', 'blocked by system dialog (not reached)', Date.now(), 0, '[]', null, st.narrate ?? null);
          }
          skipAllSteps = true;
        } else if (insp.ok && insp.result?.message && !firstIsAlert && alertPolicy !== null) {
          // policy path: drain per policy before step 1 — guards then read the
          // true screen. Storm/cap/accept-failures land as named case-failures.
          try {
            await drainDialogs('start');
          } catch (err) {
            const what = err instanceof AlertStormError ? err.dialogText : err instanceof Error ? err.message : String(err);
            const kind = err instanceof AlertStormError ? (dialogs.handlings >= dialogs.cap ? `alert storm: >${ALERT_CAP} dialogs auto-handled — last "${what}"` : `blocked by system dialog: ${what}`) : `alert drain failed: ${what}`;
            runStatus = 'failed';
            deps.db.prepare(`UPDATE runs SET note = ? WHERE id = ?`).run(kind, runId);
            for (const st of execSteps) {
              insStep.run(runId, st.idx, st.flow ?? t.name, stepName(st), 'skip', `${kind} (not reached)`, Date.now(), 0, '[]', null, st.narrate ?? null);
            }
            skipAllSteps = true;
          }
        }
      }
      // (Sweep warm-up moved 2026-09-05: it now runs pre-open — see the
      // "Task 2b, REVISED" block above the open dispatch. probeFn is set.)

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

      // run-scoped dead-reckoning memory (plan A): selector → last resolved rect.
      // `valid` flips false on ANY scroll (delta unknowable) or navigation
      // action; expect steps keep entries (they don't move UI).
      const lastRectBySelector = new Map<string, { x: number; y: number; w: number; h: number; valid: boolean }>();
      for (let si = 0; !skipAllSteps && si < execSteps.length; si++) {
        const s = execSteps[si]!;
        const t0 = Date.now();
        // invalidation: scrolls and UI-moving actions retire remembered rects
        if (si > 0) {
          const prev = execSteps[si - 1]!;
          if (prev.action === 'scroll' || prev.action === 'tap' || prev.action === 'type' || prev.action === 'arrive' || prev.action === 'refresh' || prev.action === 'swap' || prev.action === 'expectScreen' || prev.action === 'alert') {
            for (const v of lastRectBySelector.values()) v.valid = false;
          }
        }
        // B2: operator abort — checked between steps; remaining steps skipped,
        // run aborted, device freed (B5 guard reads terminal status).
        if (isAborted(runId)) {
          insStep.run(runId, s.idx, s.flow ?? t.name, stepName(s), 'skip', 'aborted by operator', Date.now(), 0, '[]', null, s.narrate ?? null);
          continue;
        }
        // the panel's running highlight: this step is executing NOW (the
        // matching step.finished fires at the write, after dispatch settles)
        deps.bus.emit('step.started', { runId, idx: s.idx, flow: s.flow ?? t.name, name: stepName(s), narrate: s.narrate ?? null });
        // setup when-guard: one snapshot, existence check (not uniqueness).
        // Absent element = no-op skip. Guard runs BEFORE any dispatch — fast.
        if (s.when !== undefined) {
          const guard = (await alloy.dispatch('alloy_snapshot', { udid, interactiveOnly: false }, deps.dispatchDeps)) as
            | { ok: true; result: { nodes?: SnapNode[] } } | { ok: false };
          const guardNodes = guard.ok ? (guard.result.nodes ?? []) : [];
          const shown = countMatches(guardNodes, { labelContains: s.when, ignoreCase: true }) > 0;
          if (!shown) {
            insStep.run(runId, s.idx, s.flow ?? t.name, stepName(s), 'skip', `when not shown: ${s.when}`, t0, Date.now() - t0, '[]', null, s.narrate ?? null);
            continue;
          }
        }
        // env substitution (A1): resolve ${env.KEY} BEFORE dispatch — a missing
        // key fails the step deterministically; never type a half-resolved
        // string. Even optional steps hard-fail on missing env: a missing
        // credential is a config error, not a transient UI miss.
        // Phase C: variant env merges at the ONE resolution seam —
        // variant > invocation (narrowest scope wins; mergeVariantEnv tested in phase B T1)
        const resolved = substituteStep(s, activeEnv);
        if (resolved.error) {
          runStatus = 'failed';
          insStep.run(runId, s.idx, s.flow ?? t.name, stepName(s), 'fail', resolved.error, t0, 0, '[]', JSON.stringify(resolved), s.narrate ?? null);
          for (const rest of execSteps.filter((x) => x.idx > s.idx)) {
            insStep.run(runId, rest.idx, rest.flow ?? t.name, stepName(rest), 'skip', 'not reached', Date.now(), 0, '[]', null, rest.narrate ?? null);
          }
          break;
        }
        // selector env seam: the substituted selector becomes the step's
        // truth for EVERY downstream consumer (expect countMatches, tap/
        // type resolveSelector, probes) — merge over the raw selector so
        // fields substitution doesn't know (ignoreCase) survive.
        if (resolved.selector !== undefined && s.selector) s.selector = { ...s.selector, ...resolved.selector };
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
            const settlePollMs = Number(process.env.CRUCIBLE_EXPECT_POLL_MS ?? 250);
            const readCount = async (): Promise<{ n: number; nodesL: SnapNode[] } | null> => {
              const snap = (await alloy.dispatch('alloy_snapshot', { udid, interactiveOnly: false }, deps.dispatchDeps)) as
                | { ok: true; result: { nodes?: SnapNode[] } } | { ok: false };
              if (!snap.ok) return null;
              const nodesL = snap.result.nodes ?? [];
              return { n: countMatches(nodesL, s.selector!), nodesL };
            };
            let read = await readCount();
            // bound satisfied? — exactly-N (count), ≥N (atLeast), or the
            // exactly-1 default ONLY when neither bound is set (a bare
            // `?? 1` would let atLeast:2 pass on a single match).
            // The settle loops keep polling ONLY while unsatisfied.
            const satisfied = (n: number): boolean => s.count !== undefined ? n === s.count : s.atLeast !== undefined ? n >= s.atLeast : n === 1;
            const settleStart = Date.now();
            while (read && !satisfied(read.n) && Date.now() - settleStart < settleBudgetMs) {
              await new Promise((r) => setTimeout(r, settlePollMs));
              read = await readCount();
            }
            // mutation-aware patience (2026-09-07): remote webviews render
            // visually first and surface AX content later — a fixed budget
            // fails them honestly-but-wrongly. Past the base budget keep
            // polling ONLY while the hierarchy signature still changes
            // (content streaming in), up to a ceiling. A quiet tree fails
            // at the base budget exactly as before.
            if (read && read.n !== 1) {
              const maxMs = Number(process.env.CRUCIBLE_EXPECT_MAX_MS ?? 30_000);
              let prevSig: string | null = null;
              let quietReads = 0;
              while (Date.now() - settleStart < maxMs && !isAborted(runId)) {
                await new Promise((r) => setTimeout(r, settlePollMs));
                read = await readCount();
                if (!read) break;
                if (read.n === 1) break;
                const sig = structureSig(read.nodesL);
                if (sig === prevSig) {
                  quietReads += 1;
                  if (quietReads >= 2) break; // settled and still no match — done waiting
                } else {
                  quietReads = 0;
                }
                prevSig = sig;
              }
            }
            const matched = read?.n ?? 0;
            const ev = { ...resolved, expect: s.selector, matched };
            // per-expect evidence: the screen that PROVED (or broke) the
            // assertion — captured after resolution, before the row is born.
            const sevId = await recorder.captureExpectEvidence();
            const expectEvidence = sevId ? JSON.stringify([sevId]) : '[]';
            // bound-aware verdict (A9): default exactly-1; count = exactly N;
            // atLeast = ≥ N. reason names the numbers so the row explains itself.
            const boundLabel = s.count !== undefined ? `exactly ${s.count}` : s.atLeast !== undefined ? `at least ${s.atLeast}` : 'exactly 1';
            const boundMet = s.count !== undefined ? matched === s.count : s.atLeast !== undefined ? matched >= s.atLeast : matched === 1;
            if (boundMet) {
              insStep.run(runId, s.idx, s.flow ?? t.name, stepName(s), 'pass', s.count !== undefined || s.atLeast !== undefined ? `matched ${matched} (bound: ${boundLabel})` : null, t0, Date.now() - t0, expectEvidence, JSON.stringify(ev), s.narrate ?? null);
            } else if (matched === 0 && probeFn && s.x !== undefined && s.y !== undefined && read?.nodesL) {
              // Tier 1 Task 4: walk missed — single-point probe at the recorded
              // coordinate (devtools sees what the walk cannot). A hit upgrades
              // the expect to pass with reason; a miss falls through to the
              // honest failure path. Probe in LIVE device coords (scale first).
              const probeViews = await probeFn(s.x * scaleX, s.y * scaleY);
              const probeHit = probeViews.some((v) => matchesSelector(v as never, s.selector!));
              if (probeHit) {
                deps.bus.emit('sweep.stats', { runId, probes: 1, hits: 1, latencyMs: 0, step: s.idx });
                insStep.run(runId, s.idx, s.flow ?? t.name, stepName(s), 'pass', 'expect via point-probe (walk-blind)', t0, Date.now() - t0, expectEvidence, JSON.stringify(ev), s.narrate ?? null);
                continue;
              }
            } else {
              const selJson = JSON.stringify(s.selector);
              const human = selectorLabel(s.selector!);
              const reason = matched === 0
                ? `not found: ${human} (${selJson})`
                : `bound not met — found ${matched}, ${boundLabel}: ${human} (${selJson})`;
              if (s.optional) {
                insStep.run(runId, s.idx, s.flow ?? t.name, stepName(s), 'skip', `optional expect miss: ${reason}`, t0, Date.now() - t0, '[]', JSON.stringify(ev), s.narrate ?? null);
                continue;
              }
              runStatus = 'failed';
              insStep.run(runId, s.idx, s.flow ?? t.name, stepName(s), 'fail', reason, t0, Date.now() - t0, expectEvidence, JSON.stringify(ev), s.narrate ?? null);
              for (const rest of execSteps.filter((x) => x.idx > s.idx)) {
                insStep.run(runId, rest.idx, rest.flow ?? t.name, stepName(rest), 'skip', 'not reached', Date.now(), 0, '[]', null, rest.narrate ?? null);
              }
              break;
            }
            continue;
          }
          // A6b: selector-first resolution against the LIVE hierarchy —
          // coordinates are the fallback, not the plan.
          let tx = s.x;
          let ty = s.y;
          let resolvedBy: 'selector' | 'selector-recentred' | 'coordinate-fallback' | 'coordinate-fallback-scaled' | 'coordinate' | 'coordinate-scaled' | 'selector-point-scaled' | 'selector-sweep' | 'selector-engine' | 'projected-point' | 'projected-rect' = 'coordinate';
          let recentredAudit: { recentred: true; distance: number } | null = null;
          let sweepAudit: { swept: boolean; probes: number; hits: number; latencyMs: number; container?: { x: number; y: number; width: number; height: number }; found?: SnapNodeLike } | null = null;
          let lastSettleNodes: SnapNode[] | null = null; // settle poll's last read — sig-before reuse (Task 2)
          // A (sub-second taps plan 20260926T062210Z rev 2): dead-reckoning.
          // projected-point: recorded point + selector → dispatch immediately at
          //   the (scaled) point; selector demoted to post-hoc audit. Fixes
          //   first-exposure targets (17PM text-kit AX lateness).
          // projected-rect: selector seen earlier THIS run with no scroll or
          //   navigation since → dispatch at the remembered rect center.
          //   Scroll invalidates (delta unknowable — momentum-dependent).
          // No in-step retry in either path: a miss is caught by the NEXT
          // verifying step (operator decision 2026-09-26).
          let projected: { x: number; y: number; by: 'projected-point' | 'projected-rect' } | null = null;
          if ((s.action === 'tap' || s.action === 'type') && s.selector && (s.selector.identifier || s.selector.label)) {
            const selKey = JSON.stringify(Object.keys(s.selector).sort().reduce<Record<string, unknown>>((acc, k) => { acc[k] = (s.selector as Record<string, unknown>)[k]; return acc; }, {}));
            const prevStep = si > 0 ? execSteps[si - 1]! : null;
            const afterScroll = prevStep?.action === 'scroll';
            if (s.action === 'tap' && s.x !== undefined && s.y !== undefined && !afterScroll) {
              // recorded-point projection is only safe when no scroll intervened:
              // a scroll moves targets by an unknowable delta and the recorded
              // point then points at EMPTY SPACE (live miss 2026-09-26: tap at
              // (93,644) while the link sat at (243,764) — run_d5b21193).
              projected = { x: (scaleX !== 1 ? Math.round(s.x * scaleX) : s.x), y: (scaleY !== 1 ? Math.round(s.y * scaleY) : s.y), by: 'projected-point' };
            } else {
              const mem = lastRectBySelector.get(selKey);
              if (mem && mem.valid) {
                projected = { x: Math.round(mem.x + mem.w / 2), y: Math.round(mem.y + mem.h / 2), by: 'projected-rect' };
              }
            }
            let hit: { x: number; y: number; rect: { x: number; y: number; width: number; height: number } } | null = null;
            if (projected) {
              // dead-reckoning fast path: dispatch NOW at the projected point;
              // the selector is a post-hoc audit trail (resolution attempted
              // opportunistically after dispatch for the record — never gates).
              tx = projected.x; ty = projected.y;
              resolvedBy = projected.by;
            } else {
            // launch-settle poll (same class as expect A7): a fresh relaunch
            // takes ~2-3s to populate the AX hierarchy — resolving against
            // one immediate snapshot misses the selector and the coordinate
            // fallback taps BEFORE the UI exists. Poll until resolved or the
            // settle budget expires, THEN fall back.
            const settleBudgetMs = Number(process.env.CRUCIBLE_STEP_SETTLE_MS ?? 8000);
            const settlePollMs = Number(process.env.CRUCIBLE_STEP_SETTLE_POLL_MS ?? 60);
            const settleStart = Date.now();
            // ⛔ keep the poll ABORT-AWARE: an operator ■ stop must not wait
            // out an 8s budget inside one step (B2's promise: abort ≤ one
            // step + watchdog). 250ms poll keeps the abort latent ≤250ms.
            lastSettleNodes = null; // reset per step
            // stability gate: hit alone is NOT dispatch-readiness — the label
            // can exist mid-animation, and acting into a churning hierarchy
            // wedges the runner's accessibility capture (live: Sign-Up screen,
            // run_f306cd7c step 2). Require TWO consecutive identical reads.
            let prevSig: string | null = null;
            let prevCount: number | null = null;
            while (Date.now() - settleStart < settleBudgetMs && !isAborted(runId)) {
              const snap = (await alloy.dispatch('alloy_snapshot', { udid, interactiveOnly: false }, deps.dispatchDeps)) as
                | { ok: true; result: { nodes?: SnapNode[] } } | { ok: false };
              lastSettleNodes = snap.ok ? (snap.result.nodes ?? []) : null;
              hit = snap.ok ? resolveSelector(snap.result.nodes ?? [], s.selector) : null;
              if (hit) {
                // remember the resolved rect for later dead-reckoning (plan A)
                const k = JSON.stringify(Object.keys(s.selector!).sort().reduce<Record<string, unknown>>((acc, kk) => { acc[kk] = (s.selector as Record<string, unknown>)[kk]; return acc; }, {}));
                const prevRect = lastRectBySelector.get(k);
                lastRectBySelector.set(k, { x: hit.rect.x, y: hit.rect.y, w: hit.rect.width, h: hit.rect.height, valid: true });
                // target-scoped quiet: the TARGET's own rect repeated across two
                // reads — enough to act. Global structure still churns on big
                // sims long after the target is stable (measured 2026-09-26).
                if (prevRect && Math.abs(prevRect.x - hit.rect.x) <= 2 && Math.abs(prevRect.y - hit.rect.y) <= 2) break;
                // legacy global gates (kept for the first resolving read):
                // quiet = full structure-sig repeat OR node-count stability
                // (±2 for two consecutive reads). The sig alone over-waits on
                // big sims where decorative structure (banners, page dots)
                // reorders continuously while the target sits still and
                // resolvable (measured 2026-09-26: 3.9-4.4s settle on a
                // resolved target, runs c01c0f7a/49d0e794).
                const nodes = lastSettleNodes ?? [];
                const sig = structureSig(nodes);
                const countStable = prevCount !== null && Math.abs(nodes.length - prevCount) <= 2;
                if (sig === prevSig || countStable) break;
                prevSig = sig;
                prevCount = nodes.length;
              } else if (lastSettleNodes && countMatches(lastSettleNodes, s.selector) > 0) {
                // Present but NOT resolvable — the matched node is a container
                // (resolveSelector nulls by design: its center may sit on a
                // different control). The dispatch will use the recorded point
                // anyway, so gate on presence + coarse stability: node count
                // within ±2 for two consecutive reads. Full structure-sig
                // equality over-waits on big sims where decorative structure
                // settles slowly (measured 2026-09-26 run_c01c0f7a: 3.9s of
                // settle on a resolved target, whole-sig never repeated).
                if (prevCount !== null && Math.abs(lastSettleNodes.length - prevCount) <= 2) break;
                prevCount = lastSettleNodes.length;
              } else {
                prevSig = null; // target absent: keep polling, no stability memory
                prevCount = null;
              }
              await new Promise((r) => setTimeout(r, settlePollMs));
            }
            }
            if (projected && hit === null) {
              // projection already set tx/ty/resolvedBy; skip the ladder
            } else if (hit) {
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
              //     device): selector center is the resilient choice — BUT
              //     only for recentre-SAFE nodes (wrappers whose center is
              //     another control are rejected in 'recentre' mode → null
              //     → coordinate fallback with scaling)
              const sx = (scaleX !== 1 || scaleY !== 1) && s.x !== undefined ? Math.round(s.x * scaleX) : s.x;
              const sy = (scaleX !== 1 || scaleY !== 1) && s.y !== undefined ? Math.round(s.y * scaleY) : s.y;
              // scaled points carry KNOWN error — "near" must mean NEAR (Task 4)
              const slack = (scaleX !== 1 || scaleY !== 1) ? 24 : 44; // pt — covers two-line link rects vs visible text run
              // selector-only steps (no recorded point — identifier/label
              // overloads): the resolved hit center IS the aim, full stop.
              // No recorded point exists to confirm, recentre, or fall back
              // to — skip the near/recentre ladder entirely (the old
              // fall-through mislabeled these 'selector-recentred' with a
              // distance measured against the ORIGIN).
              if (s.x === undefined || s.y === undefined) {
                tx = hit.x; ty = hit.y; resolvedBy = 'selector';
              } else {
                const near = sx !== undefined && sy !== undefined &&
                  sx >= hit.rect.x - slack && sx <= hit.rect.x + hit.rect.width + slack &&
                  sy >= hit.rect.y - slack && sy <= hit.rect.y + hit.rect.height + slack;
                if (near) {
                  tx = sx as number; ty = sy as number;
                  resolvedBy = (sx === s.x && sy === s.y) ? 'selector' : 'selector-point-scaled';
                } else {
                  const safe = resolveSelector(lastSettleNodes ?? [], s.selector, 'recentre');
                  if (safe) {
                    tx = safe.x; ty = safe.y; resolvedBy = 'selector-recentred';
                    recentredAudit = { recentred: true, distance: Math.round(Math.hypot((tx ?? 0) - (sx ?? 0), (ty ?? 0) - (sy ?? 0))) };
                  } else {
                    // wrapper unsafe to recentre onto → scaled coordinate fallback
                    if (scaleX !== 1 || scaleY !== 1) {
                      tx = Math.round(s.x * scaleX); ty = Math.round(s.y * scaleY);
                    } else { tx = s.x; ty = s.y; }
                    resolvedBy = 'coordinate-fallback';
                  }
                }
              }
            } else {
              // AX-depth adoption (T4): the alloy tree missed — before the
              // stencil sweep, ONE engine-tree rescue. Fixes the
              // label-propagation class (MINGGU: alloy 4 hittable matches →
              // resolve null; engine 1 match → resolve works) at ~0.5–1s,
              // inside the step budget. Sim-only, best-effort: any engine
              // failure falls through to the sweep untouched.
              let engineHit: { x: number; y: number } | null = null;
              try {
                const dev = deps.db.prepare('SELECT platform, kind FROM devices WHERE udid = ?').get(udid) as { platform: string | null; kind: string | null } | undefined;
                if (dev?.platform === 'ios' && dev?.kind === 'simulator') {
                  const engineNodes = await fetchEngineTree(udid);
                  const r = resolveSelector(engineNodes, s.selector, 'recentre');
                  if (r) { engineHit = { x: r.x, y: r.y }; }
                }
              } catch { /* engine unavailable → sweep path, unchanged */ }
              if (engineHit) {
                tx = engineHit.x; ty = engineHit.y;
                resolvedBy = 'selector-engine';
                lastSettleNodes = null; // sig-before-reuse invariant: these nodes are NOT the alloy tree
                sweepAudit = { swept: false, probes: 0, hits: 1, latencyMs: 0 };
                deps.bus.emit('sweep.stats', { runId, swept: false, probes: 0, hits: 1, latencyMs: 0, step: s.idx });
              }
              // two-source truth (steal-list 1.1/1.2): the walk missed — was it
              // walk-blindness (childless container at the recorded point)?
              // Probe the 5-point stencil; a selector hit is a verified,
              // recentre-safe resolution the coordinate fallback never is.
              let swept = engineHit !== null;
              const sweepT0 = Date.now();
              // containment checks run in LIVE device coords — scale the
              // recorded point first (tree rects are live, s.x/s.y are recorded)
              const px = scaleX !== 1 && s.x !== undefined ? s.x * scaleX : s.x;
              const py = scaleY !== 1 && s.y !== undefined ? s.y * scaleY : s.y;
              if (probeFn && px !== undefined && py !== undefined && sweepTriggered(lastSettleNodes ?? [], px, py)) {
                const container = blindContainerAt(lastSettleNodes ?? [], px, py);
                if (container?.rect) {
                  const probes = probePoints(container.rect).length;
                  const hit = await sweepFind(probeFn, s.selector, probePoints(container.rect));
                  if (hit?.rect) {
                    const cx = hit.rect.x + hit.rect.width / 2;
                    const cy = hit.rect.y + hit.rect.height / 2;
                    tx = cx; ty = cy; resolvedBy = 'selector-sweep'; swept = true;
                    sweepAudit = { swept: true, probes, hits: 1, latencyMs: Date.now() - sweepT0, container: container.rect, found: hit as SnapNodeLike };
                    deps.bus.emit('sweep.stats', { runId, ...sweepAudit, step: s.idx });
                  } else {
                    // probed-and-missed is still worth the audit row: it
                    // proves the sweep RAN (vs never triggered) when reading
                    // the run back.
                    sweepAudit = { swept: false, probes, hits: 0, latencyMs: Date.now() - sweepT0, container: container.rect };
                    deps.bus.emit('sweep.stats', { runId, probes, hits: 0, latencyMs: Date.now() - sweepT0, step: s.idx });
                  }
                }
              }
              if (!swept) {
                resolvedBy = 'coordinate-fallback';
                // fold-in fix (approved with YAML work): the selector missed —
                // on a DIFFERENT-SIZED device the raw recorded coordinates
                // would land off-target (the scaling branch above is skipped
                // when a selector exists). Scale the fallback coordinates too.
                if (s.x === undefined || s.y === undefined) {
                  // selector-only step whose selector never resolved — no
                  // recorded point exists to fall back to. Fail honestly.
                  throw new Error(`selector tap never resolved on: ${JSON.stringify(s.selector)} — no recorded point as fallback`);
                }
                if ((scaleX !== 1 || scaleY !== 1) && s.x !== undefined && s.y !== undefined) {
                  tx = Math.round(s.x * scaleX);
                  ty = Math.round(s.y * scaleY);
                  resolvedBy = 'coordinate-fallback-scaled';
                }
              }
            }
          } else if ((scaleX !== 1 || scaleY !== 1) && s.x !== undefined && s.y !== undefined) {
            // selector-less step on a different-size device: proportional
            // scaling is a GUEGE wearing a pass badge (live: 428×926 → 393×852
            // drifted a row-tap 52pt and four taps "passed" while the target
            // page never opened — run_f5bdb387). Fail honestly; the reason
            // names the two fixes. optional:true skips (the author's toggle).
            const why = 'cross-device coordinate tap without a selector — record a selector or mark the step optional';
            if (s.optional) {
              insStep.run(runId, s.idx, s.flow ?? t.name, stepName(s), 'skip', `optional miss: ${why}`, t0, Date.now() - t0, '[]', JSON.stringify(resolved), s.narrate ?? null);
              continue;
            }
            throw new Error(why);
          }
          // R2 verbs (S5): screen-state runner steps. Write-only branch like
          // location — outcome rows carry the verdict; failures fail the run
          // and skip the rest (same shape as location/alert handling).
          if (s.action === 'arrive' || s.action === 'refresh' || s.action === 'swap' || s.action === 'expectScreen') {
            // lazy runner: constructed once, registry loaded on first use
            if (!screenRunner) {
              const { ScreenRunner } = await import('./screen-runner.ts');
              const svc = forgeStateService(deps);
              screenRunner = new ScreenRunner({
                db: deps.db,
                appBundleId: appToLaunch,
                runId,
                udid,
                dispatch: (tool, input) => alloy.dispatch(tool, input, deps.dispatchDeps) as never,
                forgeActivate: (rows) => svc.activateScenario(rows),
                // push-based GUARD 1: the typed bus emits forge.traffic.hit at
                // traffic-insert time (manager.ts file ingest + proxy.ts live)
                onTrafficHit: (cb) => deps.bus.on('forge.traffic.hit', cb),
              });
            }
            let outcome: { ok: boolean; code?: string; note: string; waitMs?: number };
            if (s.action === 'arrive') outcome = await screenRunner.arrive(s.screen!, r2case?.entry?.mode);
            else if (s.action === 'refresh') outcome = await screenRunner.refresh(s.screen!);
            else if (s.action === 'swap') {
              // resolve the swap target id → its scenario ids (swaps ∪ variants)
              const pool = [...(r2case?.swaps ?? r2case?.worlds ?? []), ...(r2case?.variants ?? [])];
              const w = pool.find((x) => x.id === s.swap) ?? null;
              if (w) activeEnv = mergeVariantEnv(w, resolvedBase.env); // ${env.X} follows the active swap target, managed scopes preserved (F1)
              const names = w ? variantScenarioNames(w) : [];
              const ids: string[] = [];
              for (const n of names) {
                const sid = (deps.db.prepare('SELECT id FROM scenarios WHERE id = ? OR name = ? LIMIT 1').get(n, n) as { id: string } | undefined)?.id;
                if (sid) ids.push(sid);
              }
              outcome = await screenRunner.swap(s.swap!, ids);
              activeSwap = s.swap!; // evidence attribution: the world this run is IN from here on
            } else outcome = await screenRunner.expectScreen(s.expectScreen!.screen, s.expectScreen!.state, s.expectScreen!.negate === true);
            // per-state evidence: a PASSING expect screen captures the frame
            // that proved the state — swap cases get one screenshot per
            // world, attachable to the step row like classic expects.
            const passEv = outcome.ok && s.action === 'expectScreen' ? await recorder.captureStateEvidence() : null;
            const passEvidence = passEv ? JSON.stringify([passEv]) : '[]';
            if (outcome.ok) {
              insStep.run(runId, s.idx, s.flow ?? t.name, stepName(s), 'pass', null, t0, Date.now() - t0, passEvidence, JSON.stringify({ action: s.action, note: outcome.note, ...(activeSwap ? { swapTarget: activeSwap } : {}), ...(outcome.waitMs !== undefined ? { waitMs: outcome.waitMs, workMs: Math.max(0, (Date.now() - t0) - outcome.waitMs) } : {}) }), s.narrate ?? null);
            } else {
              runStatus = 'failed';
              insStep.run(runId, s.idx, s.flow ?? t.name, stepName(s), 'fail', `${outcome.code}: ${outcome.note}`, t0, Date.now() - t0, passEvidence, JSON.stringify({ action: s.action, code: outcome.code }), s.narrate ?? null);
              for (const rest of execSteps.filter((x) => x.idx > s.idx)) {
                insStep.run(runId, rest.idx, rest.flow ?? t.name, stepName(rest), 'skip', 'not reached', Date.now(), 0, '[]', null, rest.narrate ?? null);
              }
              break;
            }
            continue;
          }
          // location step (Tier 2.3): host-level device fact — no snapshot,
          // no settle/sig logic (the app UI does not change). Write-only
          // verb: the step row's evaluated_json IS the audit trail.
          if (s.action === 'location') {
            const loc = s.location ?? { latitude: 0, longitude: 0 };
            try {
              const r = await locationOps.set(udid, loc.latitude, loc.longitude);
              locationSet = true;
              insStep.run(runId, s.idx, s.flow ?? t.name, stepName(s), 'pass', null, t0, Date.now() - t0, '[]', JSON.stringify({ action: 'location', ...r, ...(s.flow && { flow: s.flow }) }), s.narrate ?? null);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              runStatus = 'failed';
              insStep.run(runId, s.idx, s.flow ?? t.name, stepName(s), 'fail', msg, t0, Date.now() - t0, '[]', JSON.stringify({ action: 'location', latitude: loc.latitude, longitude: loc.longitude }), s.narrate ?? null);
              for (const rest of execSteps.filter((x) => x.idx > s.idx)) {
                insStep.run(runId, rest.idx, rest.flow ?? t.name, stepName(rest), 'skip', 'not reached', Date.now(), 0, '[]', null, rest.narrate ?? null);
              }
              break;
            }
            continue;
          }
          // alert step: clear (or accept) the frontmost system dialog.
          // ok:true = a dialog was up and handled → pass. ok:false
          // "alert not found" = nothing up → no-op skip (inherently
          // conditional). Any other ok:false = real engine error → fail.
          if (s.action === 'ensureLogin') {
            // coordinate-free login preflight: no-op when a session indicator
            // is already visible; else entry → type credentials (env-resolved)
            // → submit → verify the session indicator appears. Login returns
            // to the origin tab (popToRoot semantics), so verification runs
            // against the entry screen's tree.
            const cfgRaw = s.ensureLogin!;
            // screen-form (plan rev 2 S4.2): selectors resolve from the
            // screens registry login_json. Unknown screen / missing recipe /
            // partial recipe → explicit step failure, never silent skip.
            // login resolution (login-as-app-procedure plan): the APP's
            // procedure wins (app_login row); a legacy screen-level block is
            // the read-only fallback; inline selectors remain for old cases.
            // The procedure carries a REAL entry object (tab/deepLink/
            // navigate) — multi-step entries play per-step (review F1 — the
            // join('>') hack is gone), verify references (screen, state).
            type SelSource = { entry: string; phoneField: string; passwordField: string; submit: string; session: string };
            let selSource: SelSource | null = null;
            let sessionStateName: string | null = null;
            let sessionVia: string | null = null; // verify.via — tap this control before polling the state (state lives elsewhere) // poll this STATE instead of a raw identifier
            let sessionStateScreen: string | null = null; // …on THIS screen
            let procedureEntry: { tab?: { identifier?: string; label?: string }; deepLink?: string; navigate?: Array<Record<string, unknown>> } | null = null; // app procedure: play via the entry player
            const screenRef = (cfgRaw as { screen?: string }).screen;
            const appLoginRow = (tpl.app_bundle_id
              ? deps.db.prepare('SELECT login_json FROM app_login WHERE bundle_id = ?').get(tpl.app_bundle_id) as { login_json: string } | undefined
              : undefined);
            if (appLoginRow) {
              type ProcShape = { entry?: { tab?: { identifier?: string; label?: string }; deepLink?: string; navigate?: Array<Record<string, unknown>> }; phone?: string; password?: string; submit?: string; verify?: { screen?: string; state?: string } };
              let proc: ProcShape | null = null;
              try { proc = JSON.parse(appLoginRow.login_json) as ProcShape; } catch { proc = null; }
              if (!proc || !proc.entry || !proc.phone || !proc.password || !proc.submit || !proc.verify?.screen || !proc.verify?.state) {
                runStatus = 'failed';
                insStep.run(runId, s.idx, s.flow ?? t.name, 'ensure login', 'fail', `ensure login: the app's login flow is incomplete — edit it on the screens page`, t0, Date.now() - t0, '[]', JSON.stringify({ action: s.action }), s.narrate ?? null);
                break;
              }
              procedureEntry = proc.entry;
              selSource = { entry: '', phoneField: proc.phone, passwordField: proc.password, submit: proc.submit, session: proc.verify.state };
              sessionStateName = proc.verify.state;
              sessionVia = (proc.verify as { via?: string }).via ?? null; // optional: a control to tap before polling (state lives on another screen)
              sessionStateScreen = proc.verify.screen;
            }
            if (screenRef) {
              const row = deps.db.prepare('SELECT entry_json, states_json, login_json FROM app_screens WHERE app_bundle_id = ? AND screen_id = ?').get(tpl.app_bundle_id, screenRef) as { entry_json: string; states_json: string; login_json: string | null } | undefined;
              const failRecipe = (why: string): void => {
                runStatus = 'failed';
                insStep.run(runId, s.idx, s.flow ?? t.name, 'ensure login', 'fail', `ensure login: screen "${screenRef}" ${why}`, t0, Date.now() - t0, '[]', JSON.stringify({ action: s.action }), s.narrate ?? null);
              };
              if (!row) { failRecipe('is not in the screens registry for this app'); break; }
              let recipe: Record<string, string> | null = null;
              try { recipe = row.login_json ? (JSON.parse(row.login_json) as Record<string, string>) : null; } catch { recipe = null; }
              if (!recipe) { failRecipe('has no login capability'); break; }
              if ('phone' in recipe) {
                // v2: controls from the block; entry + session from the screen's own facts
                const gaps = (['phone', 'password', 'submit', 'session'] as const).filter((k) => typeof recipe[k] !== 'string' || !recipe[k]!.trim());
                if (gaps.length > 0) { failRecipe(`login capability is missing ${gaps.join(', ')}`); break; }
                type ScreenEntryShape = { tab?: { identifier?: string; label?: string }; deepLink?: string; navigate?: Array<Record<string, unknown>> };
                let screenEntry: ScreenEntryShape | null = null;
                let screenStates: Record<string, unknown> | null = null;
                try { screenEntry = JSON.parse(row.entry_json) as ScreenEntryShape; } catch { screenEntry = null; }
                try { screenStates = JSON.parse(row.states_json) as Record<string, unknown>; } catch { screenStates = null; }
                if (!screenEntry || !screenStates) { failRecipe('has malformed entry/states — cannot derive the login flow'); break; }
                if (!(recipe['session']! in screenStates)) { failRecipe(`login.session "${recipe['session']}" is not one of its states (has: ${Object.keys(screenStates).join(', ')})`); break; }
                // legacy v2 fallback routes through the SAME entry player as
                // the app procedure (per-step navigate playback — the join
                // hack is dead everywhere, review F1)
                const hasUsableEntry = !!screenEntry.tab || !!screenEntry.deepLink || (Array.isArray(screenEntry.navigate) && screenEntry.navigate.length > 0);
                if (!hasUsableEntry) { failRecipe('declares no usable entry for the login flow'); break; }
                procedureEntry = screenEntry;
                selSource = { entry: '', phoneField: recipe['phone']!, passwordField: recipe['password']!, submit: recipe['submit']!, session: recipe['session']! };
                sessionStateName = recipe['session']!;
                sessionStateScreen = screenRef;
              } else {
                // legacy 5-field: literal values as stored
                const gaps = (['entry', 'phoneField', 'passwordField', 'submit', 'session'] as const).filter((k) => typeof recipe[k] !== 'string' || !recipe[k]!.trim());
                if (gaps.length > 0) { failRecipe(`login recipe is missing ${gaps.join(', ')}`); break; }
                selSource = { entry: recipe['entry']!, phoneField: recipe['phoneField']!, passwordField: recipe['passwordField']!, submit: recipe['submit']!, session: recipe['session']! };
              }
            }
            const cfg: Record<string, string | null> = {
              entry: selSource ? selSource.entry : cfgRaw.entry || null,
              phoneField: selSource ? selSource.phoneField : cfgRaw.phoneField || null,
              passwordField: selSource ? selSource.passwordField : cfgRaw.passwordField || null,
              submit: selSource ? selSource.submit : cfgRaw.submit || null,
              session: selSource ? selSource.session : cfgRaw.session || null,
              phone: cfgRaw.phone !== undefined ? expandEnvText(cfgRaw.phone, activeEnv) : null,
              password: cfgRaw.password !== undefined ? expandEnvText(cfgRaw.password, activeEnv) : null,
            };
            const missing = Object.entries(cfg).filter(([, v]) => v === null || v === undefined).map(([k]) => k);
            if (missing.length > 0) {
              runStatus = 'failed';
              insStep.run(runId, s.idx, s.flow ?? t.name, 'ensure login', 'fail', `missing env: ${missing.join(', ')}`, t0, Date.now() - t0, '[]', JSON.stringify({ action: s.action }), s.narrate ?? null);
              break;
            }
            const cfgResolved = cfg as unknown as { entry: string; phoneField: string; passwordField: string; submit: string; session: string; phone: string; password: string };
            const snapNow = async () => {
              const sn = (await alloy.dispatch('alloy_snapshot', { udid, interactiveOnly: false }, deps.dispatchDeps)) as
                | { ok: true; result: { nodes?: SnapNode[] } } | { ok: false };
              return sn.ok ? (sn.result.nodes ?? []) : null;
            };
            const findOne = (nodes: SnapNode[], key: string): { x: number; y: number } | null => {
              const byId = resolveSelector(nodes, { identifier: key });
              if (byId) return byId;
              const byLabel = resolveSelector(nodes, { label: key });
              if (byLabel) return byLabel;
              return resolveSelector(nodes, { labelContains: key });
            };
            const settleFind = async (key: string, budgetMs = 10_000): Promise<{ x: number; y: number } | null> => {
              const t1 = Date.now();
              while (Date.now() - t1 < budgetMs && !isAborted(runId)) {
                const nodes = await snapNow();
                const hit = nodes ? findOne(nodes, key) : null;
                if (hit) return hit;
                await new Promise((res2) => setTimeout(res2, 150));
              }
              return null;
            };
            // session test (D4): v2 = the screen's named STATE holds;
            // legacy/inline = the raw identifier is present
            const sessionHolds = async (currentNodes: SnapNode[] | null): Promise<boolean> => {
              if (!currentNodes) return false;
              if (!sessionStateName) return findOne(currentNodes, cfgResolved.session) !== null;
              const stateScreen = sessionStateScreen ?? screenRef;
              if (!stateScreen) return false;
              const stateRow = deps.db.prepare('SELECT states_json FROM app_screens WHERE app_bundle_id = ? AND screen_id = ?').get(tpl.app_bundle_id, stateScreen) as { states_json: string } | undefined;
              if (!stateRow) return false;
              try {
                const states = JSON.parse(stateRow.states_json) as Record<string, { all?: Array<Record<string, string>>; any?: Array<Record<string, string>> }>;
                const def = states[sessionStateName];
                if (!def) return false;
                if (def.all && !def.all.every((sel) => findOne(currentNodes, sel.identifier ?? sel.label ?? '') !== null)) return false;
                if (def.any && !def.any.some((sel) => findOne(currentNodes, sel.identifier ?? sel.label ?? '') !== null)) return false;
                return true;
              } catch { return false; }
            };
            let nodes = await snapNow();
            let alreadyIn = await sessionHolds(nodes);
            // the state may live behind verify.via even when ALREADY logged
            // in (home → account tab): probe once through via before deciding
            if (!alreadyIn && sessionVia) {
              const viaPt0 = await settleFind(sessionVia);
              if (viaPt0) {
                await alloy.dispatch('alloy_act', { udid, action: 'press', target: { x: viaPt0.x, y: viaPt0.y }, settle: false }, deps.dispatchDeps).catch(() => undefined);
                await new Promise((res2) => setTimeout(res2, 600));
                nodes = await snapNow();
                alreadyIn = await sessionHolds(nodes);
                if (alreadyIn) {
                  insStep.run(runId, s.idx, s.flow ?? t.name, 'ensure login', 'pass', 'session already held (via verify.via probe)', t0, Date.now() - t0, '[]', JSON.stringify({ action: s.action }), s.narrate ?? null);
                  continue;
                }
              }
            }
            if (alreadyIn) {
              insStep.run(runId, s.idx, s.flow ?? t.name, 'ensure login', 'pass', sessionStateName ? `already logged in (state "${sessionStateName}" holds)` : 'already logged in (session visible)', t0, Date.now() - t0, '[]', JSON.stringify({ action: s.action, checked: cfgResolved.session }), s.narrate ?? null);
            } else {
              // state restoration can land the app DIRECTLY on the login
              // form (iOS scene restore after terminate). If the form is
              // already up, the entry tap is unnecessary — skip it.
              const formAlreadyUp = await settleFind(cfgResolved.phoneField, 1500);
              if (!formAlreadyUp) {
                if (procedureEntry) {
                  // the entry PLAYER (review F1): navigate lists play
                  // PER-STEP (resolve on:/x-y, tap, settle); tab is one
                  // selector tap; deepLink opens are not tap-playable here.
                  const playEntryStep = async (onRef: string | undefined, x?: number, y?: number): Promise<void> => {
                    let tx: number | null = typeof x === 'number' ? x : null;
                    let ty: number | null = typeof y === 'number' ? y : null;
                    if (onRef) {
                      let hit: { x: number; y: number } | null = null;
                      for (let attempt = 0; attempt < 10 && !hit; attempt++) {
                        const ns = await snapNow();
                        hit = ns ? findOne(ns, onRef) : null;
                        if (!hit) await new Promise((res2) => setTimeout(res2, 500));
                      }
                      if (!hit) throw new Error(`ensure login: entry step ${JSON.stringify(onRef)} never appeared`);
                      tx = hit.x; ty = hit.y;
                    }
                    if (tx == null || ty == null) throw new Error('ensure login: entry step has neither on: nor x/y');
                    const rStep = (await withWatchdog(runId, alloy.dispatch('alloy_act', { udid, action: 'press', target: { x: tx, y: ty }, settle: false }, deps.dispatchDeps) as Promise<{ ok: boolean; error?: { message?: string } }>, 'ensure login: entry step')) as { ok: boolean; error?: { message?: string } };
                    if (!rStep.ok) throw new Error(rStep.error?.message ?? 'ensure login: entry step tap failed');
                    await new Promise((res2) => setTimeout(res2, 400)); // settle between taps
                  };
                  const pe = procedureEntry;
                  if (Array.isArray(pe.navigate) && pe.navigate.length > 0) {
                    for (const st of pe.navigate) {
                      const rec = st as Record<string, unknown>;
                      if (typeof rec['on'] === 'string') await playEntryStep(rec['on']);
                      else if (typeof rec['x'] === 'number' && typeof rec['y'] === 'number') await playEntryStep(undefined, rec['x'], rec['y']);
                      else throw new Error('ensure login: entry navigate step has neither on: nor x/y');
                    }
                  } else if (pe.tab) {
                    const tRef = pe.tab.identifier ?? pe.tab.label ?? '';
                    if (!tRef) throw new Error('ensure login: entry tab has no identifier/label');
                    await playEntryStep(tRef);
                  } else {
                    throw new Error('ensure login: the login flow declares no usable entry');
                  }
                } else {
                  const entryPt = await settleFind(cfgResolved.entry);
                  if (!entryPt) throw new Error(`ensure login: entry ${JSON.stringify(cfgResolved.entry)} never appeared`);
                  const r1 = (await withWatchdog(runId, alloy.dispatch('alloy_act', { udid, action: 'press', target: { x: entryPt.x, y: entryPt.y }, settle: false }, deps.dispatchDeps) as Promise<{ ok: boolean; error?: { message?: string } }>, 'ensure login: open form')) as { ok: boolean; error?: { message?: string } };
                  if (!r1.ok) throw new Error(r1.error?.message ?? 'ensure login: entry tap failed');
                }
              }
              // resilient fill: custom text fields can fail the runner's
              // typed-text CONFIRMATION even when the text landed (live
              // 2026-09-26: phone visibly contained the digits, the error
              // claimed otherwise). The verb's real gate is downstream —
              // submit + session-indicator verification — so a fill that
              // only fails confirmation is retried once (keyboard-state
              // reset) and then tolerated.
              const resilientFill = async (x: number, y: number, text: string, what: string): Promise<void> => {
                for (let attempt = 0; attempt < 2; attempt++) {
                  const r = (await withWatchdog(runId, alloy.dispatch('alloy_act', { udid, action: 'fill', target: { x, y }, text, settle: false }, deps.dispatchDeps) as Promise<{ ok: boolean; error?: { message?: string } }>, `ensure login: ${what}`)) as { ok: boolean; error?: { message?: string } };
                  if (r.ok) return;
                  const msg = r.error?.message ?? '';
                  // secure fields mask their display: the runner reads back
                  // "⬤ ⬤ ⬤…" and compares against PLAINTEXT — always a
                  // mismatch. Tolerate when the masked glyph COUNT equals the
                  // typed length (10 dots for a 10-char password = the fill
                  // landed); a count mismatch is a wrong fill and fails
                  // honestly.
                  const vm = /text entry verification failed: expected .+?, observed ["']([^"']*)["']/i.exec(msg);
                  if (vm) {
                    const glyphs = (vm[1] ?? '').replace(/[^⬤•*●]/g, '').length;
                    if (glyphs === text.length) {
                      // mask-parity proves the fill LANDED (10 dots for 10
                      // chars). The fill is done — RETYPING appends into the
                      // already-filled field and corrupts the value (live
                      // catch: password typed twice → submitted garbage →
                      // session never held). Return; the session check gates.
                      return;
                    }
                    throw new Error(`ensure login: ${what} — typed ${text.length} chars but field shows ${glyphs} mask glyphs`);
                  }
                  if (!/could not confirm the typed text/i.test(msg)) throw new Error(msg || `ensure login: ${what} failed`);
                  // retry must NEVER append into a partially-filled field
                  // (live catch on iPhone 14 Plus: second fill appended →
                  // '11121314159' / 'quality123my'). Clear first: fill '',
                  // then the loop's next attempt types into an empty field.
                  if (attempt > 0) throw new Error(`ensure login: ${what} — fill unconfirmed after clear+retry`);
                  await alloy.dispatch('alloy_act', { udid, action: 'fill', target: { x, y }, text: '', settle: false }, deps.dispatchDeps).catch(() => undefined);
                  await new Promise((res2) => setTimeout(res2, 350));
                }
              };
              const dismissKeyboard = async (): Promise<void> => {
                // engine-backed dismissal (operator rule, default-on): the
                // keyboard hides via the runner's own keyboardDismiss — no
                // coordinates, works on every logical size. The old hardcoded
                // Done-bar tap misfired on other devices (14 Plus live catch).
                await alloy.dispatch('alloy_act', { udid, action: 'keyboardDismiss' }, deps.dispatchDeps).catch(() => undefined);
                await new Promise((res2) => setTimeout(res2, 350));
              };
              const phone = formAlreadyUp ?? await settleFind(cfgResolved.phoneField);
              if (!phone) throw new Error(`ensure login: phone field ${JSON.stringify(cfgResolved.phoneField)} never appeared`);
              await resilientFill(phone.x, phone.y, cfgResolved.phone, 'type phone');
              await dismissKeyboard();
              const pw = await settleFind(cfgResolved.passwordField);
              if (!pw) throw new Error(`ensure login: password field ${JSON.stringify(cfgResolved.passwordField)} never appeared`);
              await resilientFill(pw.x, pw.y, cfgResolved.password, 'type password');
              await dismissKeyboard();
              const submit = await settleFind(cfgResolved.submit);
              if (!submit) throw new Error(`ensure login: submit ${JSON.stringify(cfgResolved.submit)} never appeared`);
              const r4 = (await withWatchdog(runId, alloy.dispatch('alloy_act', { udid, action: 'press', target: { x: submit.x, y: submit.y }, settle: false }, deps.dispatchDeps) as Promise<{ ok: boolean; error?: { message: string } }>, 'ensure login: submit')) as { ok: boolean; error?: { message: string } };
              if (!r4.ok) throw new Error(r4.error?.message ?? 'ensure login: submit failed');
              // verify the session: sessionHolds (hoisted) — v2 polls the
              // screen's named state; legacy/inline the raw identifier
              // verify.via (app-procedure): some session states live on
              // another screen (auth.session_on = the account tab's logout
              // button) — tap the control once, then poll where it lives
              if (sessionVia) {
                const viaPt = await settleFind(sessionVia);
                if (viaPt) {
                  await alloy.dispatch('alloy_act', { udid, action: 'press', target: { x: viaPt.x, y: viaPt.y }, settle: false }, deps.dispatchDeps).catch(() => undefined);
                  await new Promise((res2) => setTimeout(res2, 600));
                }
              }
              let seen = false;
              for (let k = 0; k < 60 && !seen && !isAborted(runId); k++) {
                await new Promise((res2) => setTimeout(res2, 250));
                nodes = await snapNow();
                seen = await sessionHolds(nodes);
              }
              if (!seen) throw new Error(sessionStateName ? `ensure login: submitted but the screen state "${sessionStateName}" never held` : 'ensure login: submitted but the session indicator never appeared');
              insStep.run(runId, s.idx, s.flow ?? t.name, 'ensure login', 'pass', 'logged in (entry → type → submit → verified)', t0, Date.now() - t0, '[]', JSON.stringify({ action: s.action, entry: cfgResolved.entry }), s.narrate ?? null);
            }
            continue;
          }
          if (s.action === 'ensureLogout') {
            // coordinate-free session preflight: pass-through when logged
            // out; when a session exists, tap the logout control (identifier
            // preferred, label fallback), confirm the sheet, verify the
            // session indicator is GONE. All resolution is live — no
            // recorded points, cross-device safe by construction.
            const cfg = s.ensureLogout!;
            const snapNow = async () => {
              const sn = (await alloy.dispatch('alloy_snapshot', { udid, interactiveOnly: false }, deps.dispatchDeps)) as
                | { ok: true; result: { nodes?: SnapNode[] } } | { ok: false };
              return sn.ok ? (sn.result.nodes ?? []) : null;
            };
            const findOne = (nodes: SnapNode[], key: string): { x: number; y: number } | null => {
              // identifier exact, else label exact, else labelContains —
              // exactly-one rule preserved (duplicate labels do NOT resolve)
              const byId = resolveSelector(nodes, { identifier: key });
              if (byId) return byId;
              const byLabel = resolveSelector(nodes, { label: key });
              if (byLabel) return byLabel;
              const byContains = resolveSelector(nodes, { labelContains: key });
              return byContains;
            };
            // via (mirror of login's verify.via): the session control may live
            // on another screen (logout button = account tab) — tap through
            // before the preflight, both for the check and the real logout
            let nodes = await snapNow();
            const viaSel = (s.ensureLogout as { via?: string }).via;
            if (viaSel) {
              const viaPt = nodes ? findOne(nodes, viaSel) : null;
              if (viaPt) {
                await alloy.dispatch('alloy_act', { udid, action: 'press', target: { x: viaPt.x, y: viaPt.y }, settle: false }, deps.dispatchDeps).catch(() => undefined);
                // poll for the session control — the destination screen's AX
                // tree is not ready at any fixed sleep (live catch: 600ms after
                // the tab tap the account page hadn't exposed the button yet)
                for (let k = 0; k < 15 && !isAborted(runId); k++) {
                  await new Promise((res2) => setTimeout(res2, 200));
                  nodes = await snapNow();
                  if (nodes && findOne(nodes, cfg.button)) break;
                }
                if (!nodes) nodes = await snapNow();
              }
            }
            const sessionVisible = nodes ? findOne(nodes, cfg.button) !== null : false;
            if (!sessionVisible) {
              insStep.run(runId, s.idx, s.flow ?? t.name, 'ensure logout', 'pass', 'already logged out (no session)', t0, Date.now() - t0, '[]', JSON.stringify({ action: s.action, checked: cfg.button }), s.narrate ?? null);
            } else {
              const btn = nodes ? findOne(nodes, cfg.button) : null;
              if (!btn) throw new Error(`ensure logout: session indicator ${JSON.stringify(cfg.button)} vanished between reads`);
              const r1 = (await withWatchdog(runId, alloy.dispatch('alloy_act', { udid, action: 'press', target: { x: btn.x, y: btn.y }, settle: false }, deps.dispatchDeps) as Promise<{ ok: boolean; error?: { message: string } }>, 'ensure logout: open sheet')) as { ok: boolean; error?: { message: string } };
              if (!r1.ok) throw new Error(r1.error?.message ?? 'ensure logout: sheet tap failed');
              // wait for the confirm control (poll, bounded by the step watchdog)
              let confirm: { x: number; y: number } | null = null;
              for (let k = 0; k < 50 && !confirm && !isAborted(runId); k++) {
                await new Promise((res2) => setTimeout(res2, 100));
                nodes = await snapNow();
                confirm = nodes ? findOne(nodes, cfg.confirm) : null;
              }
              if (!confirm) throw new Error(`ensure logout: confirm control ${JSON.stringify(cfg.confirm)} never appeared`);
              const r2 = (await withWatchdog(runId, alloy.dispatch('alloy_act', { udid, action: 'press', target: { x: confirm.x, y: confirm.y }, settle: false }, deps.dispatchDeps) as Promise<{ ok: boolean; error?: { message: string } }>, 'ensure logout: confirm')) as { ok: boolean; error?: { message: string } };
              if (!r2.ok) throw new Error(r2.error?.message ?? 'ensure logout: confirm tap failed');
              // verify: session indicator gone (allow settle time)
              let gone = false;
              for (let k = 0; k < 30 && !gone && !isAborted(runId); k++) {
                await new Promise((res2) => setTimeout(res2, 200));
                nodes = await snapNow();
                gone = nodes ? findOne(nodes, cfg.button) === null : false;
              }
              if (!gone) throw new Error('ensure logout: confirm tapped but the session indicator is still visible');
              insStep.run(runId, s.idx, s.flow ?? t.name, 'ensure logout', 'pass', 'session logged out (button → confirm → verified gone)', t0, Date.now() - t0, '[]', JSON.stringify({ action: s.action, button: cfg.button, confirm: cfg.confirm }), s.narrate ?? null);
            }
            continue;
          }
                    if (s.action === 'alert') {
            const act = s.alertAction ?? 'dismiss';
            const alr = (await alloy.dispatch('alloy_alert', { udid, action: act }, deps.dispatchDeps)) as
              | { ok: true; result: { message?: string } }
              | { ok: false; error?: { message?: string } };
            if (alr.ok) {
              insStep.run(runId, s.idx, s.flow ?? t.name, stepName(s), 'pass', null, t0, Date.now() - t0, '[]', JSON.stringify({ action: 'alert', alertAction: act, result: alr.result?.message ?? 'cleared' }), s.narrate ?? null);
              continue;
            }
            const msg = alr.error?.message ?? 'engine error';
            if (msg.includes('alert not found')) {
              insStep.run(runId, s.idx, s.flow ?? t.name, stepName(s), 'skip', 'no alert up', t0, Date.now() - t0, '[]', JSON.stringify({ action: 'alert', alertAction: act }), s.narrate ?? null);
              continue;
            }
            throw new Error(msg);
          }
          // Task 2 — sig-before: reuse the settle poll's last read (selector
          // steps pay ZERO extra snapshots); coordinate steps take one read.
          // NOTE: screenChanged deliberately uses hierarchySig (label text
          // included) — a tap that only changes text IS a change worth
          // surfacing; only the WAIT gates use the churn-immune structureSig.
          let sigBefore: string | null = null;
          if (s.action === 'tap' || s.action === 'type') {
            if (lastSettleNodes) {
              sigBefore = hierarchySig(lastSettleNodes);
            } else {
              const pre = (await alloy.dispatch('alloy_snapshot', { udid, interactiveOnly: false }, deps.dispatchDeps)) as
                | { ok: true; result: { nodes?: SnapNode[] } } | { ok: false };
              if (pre.ok) sigBefore = hierarchySig(pre.result.nodes ?? []);
            }
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
              // Tier 2.2 — persist for the evidence-player overlay (guards
              // inside recordTap reject zero-dims pre-snapshot rows)
              recordTap(deps.db, { runId, idx: s.idx, x: tx, y: ty, logicalW: targetW ?? 0, logicalH: targetH ?? 0 }, Date.now());
            }
          }
          else if (s.action === 'scroll') input = { udid, action: 'scroll', direction: s.direction, settle: false };
          else input = { udid, action: 'fill', target: { x: tx, y: ty }, text: resolved.text ?? '', settle: false };
          // Tier 2.2 — fills are tap-positioned acts: record them too
          // (typing lands at a spot; the overlay shows where)
          if (s.action === 'type' && tx !== undefined && ty !== undefined) {
            recordTap(deps.db, { runId, idx: s.idx, x: tx, y: ty, logicalW: targetW ?? 0, logicalH: targetH ?? 0 }, Date.now());
          }
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
          // D elision is narrower than nextPollsSelector: ONLY an expect next
          // step purely verifies. tap/type next steps still need this step's
          // sig-after (the dialog interceptor keys on screenChanged===false —
          // eliding it broke mid-run dialog correlation; test Task 3b).
          const nextVerifiesByExpect = !!(nextStep && nextStep.action === 'expect' && nextStep.selector && (nextStep.selector.identifier || nextStep.selector.label));
          if (!nextPollsSelector) {
            const budgetMs = Number(process.env.CRUCIBLE_UI_STABLE_MS ?? 1500);
            await awaitUiStable(async () => {
              const snap = (await alloy.dispatch('alloy_snapshot', { udid, interactiveOnly: false }, deps.dispatchDeps)) as
                | { ok: true; result: { nodes?: SnapNode[] } } | { ok: false };
              return snap.ok ? (snap.result.nodes ?? []) : null;
            }, runId, budgetMs);
          }
          // Task 2 — sig-after: did the tap/type actually change the screen?
          // Best-effort: snapshot failure skips verification (never blocks).
          // v1 DECISION: no-change = WARN-pass (toggles/checkboxes legitimately
          // don't change the AX hierarchy); the reason surfaces the lie in the
          // run detail. Upgrade to hard-fail when usage shows warn-noise is low.
          // D (sub-second taps plan 20260926T062210Z): when the NEXT step
          // resolves by selector, its settle-poll IS the stronger check —
          // the sig-after snapshot here is duplicate work and is elided.
          let screenChanged: boolean | undefined;
          if (sigBefore !== null && !nextVerifiesByExpect && (s.action === 'tap' || s.action === 'type')) {
            try {
              const post = (await alloy.dispatch('alloy_snapshot', { udid, interactiveOnly: false }, deps.dispatchDeps)) as
                | { ok: true; result: { nodes?: SnapNode[] } } | { ok: false };
              if (post.ok) screenChanged = hierarchySig(post.result.nodes ?? []) !== sigBefore;
            } catch { /* best-effort */ }
          }
          let warnReason = screenChanged === false ? 'tap produced no screen change (wrong target or non-navigational tap?)' : null;
          // Interceptor trigger #2 (async dialogs): a no-change tap while a
          // system dialog is up means the tap went into the void behind it.
          // No policy → named fail (original interceptor). With a policy →
          // drain per policy, retry the tap, re-verify — bounded by the cap.
          if (screenChanged === false) {
            try {
              const dlg = (await alloy.dispatch('alloy_alert', { udid, action: 'inspect' }, deps.dispatchDeps)) as
                | { ok: true; result: { message?: string } } | { ok: false };
              if (dlg.ok && dlg.result?.message && alertPolicy === null) {
                const what = dlg.result?.message ?? 'unknown system dialog';
                runStatus = 'failed';
                deps.db.prepare(`UPDATE runs SET note = ? WHERE id = ?`).run(`blocked by system dialog: ${what}`, runId);
                insStep.run(runId, s.idx, s.flow ?? t.name, stepName(s), 'fail', `blocked by system dialog: ${what}`, t0, Date.now() - t0, '[]', JSON.stringify(resolved), s.narrate ?? null);
                for (const rest of execSteps.filter((x) => x.idx > s.idx)) {
                  insStep.run(runId, rest.idx, rest.flow ?? t.name, stepName(rest), 'skip', 'not reached', Date.now(), 0, '[]', null, rest.narrate ?? null);
                }
                break;
              }
              if (dlg.ok && dlg.result?.message && alertPolicy !== null) {
                // policy path: drain + retry the ORIGINAL tap (its touch never
                // reached the app), then re-verify screen change.
                await drainDialogs(`step ${s.idx + 1}`);
                const r2 = (await withWatchdog(runId, alloy.dispatch('alloy_act', input, deps.dispatchDeps) as Promise<{ ok: boolean; error?: { message: string } }>, stepName(s))) as { ok: boolean; error?: { message: string } };
                if (!r2.ok) throw new Error(r2.error?.message ?? 'engine error');
                const post2 = (await alloy.dispatch('alloy_snapshot', { udid, interactiveOnly: false }, deps.dispatchDeps)) as
                  | { ok: true; result: { nodes?: SnapNode[] } } | { ok: false };
                if (post2.ok) screenChanged = hierarchySig(post2.result.nodes ?? []) !== sigBefore;
                warnReason = screenChanged === false ? 'tap produced no screen change (wrong target or non-navigational tap?)' : null;
              }
            } catch (err) {
              if (err instanceof AlertStormError) {
                const kind = dialogs.handlings >= dialogs.cap ? `alert storm: >${ALERT_CAP} dialogs auto-handled — last "${err.dialogText}"` : `blocked by system dialog: ${err.dialogText}`;
                runStatus = 'failed';
                deps.db.prepare(`UPDATE runs SET note = ? WHERE id = ?`).run(kind, runId);
                insStep.run(runId, s.idx, s.flow ?? t.name, stepName(s), 'fail', kind, t0, Date.now() - t0, '[]', JSON.stringify(resolved), s.narrate ?? null);
                for (const rest of execSteps.filter((x) => x.idx > s.idx)) {
                  insStep.run(runId, rest.idx, rest.flow ?? t.name, stepName(rest), 'skip', 'not reached', Date.now(), 0, '[]', null, rest.narrate ?? null);
                }
                break;
              }
              throw err;
            }
          }
          // 'selector-point-scaled' folds into 'selector' for the audit trail —
          // the scale factors already live in evaluated_json's scale context
          // ── self-hardening (2026-09-07): a PASSING bare-coordinate tap
          // captures what it actually hit (the record-time hit-test, same
          // container guard) and writes the selector back into the case.
          // One green run replaces fragile coordinates with the live AX
          // identity — cases harden themselves by running. Needs the PRE-tap
          // nodes: reuse the settle read or the sigBefore snapshot.
          let hardened: boolean | undefined;
          let hardenedSel: StepSelector | undefined;
          if ((s.action === 'tap' || s.action === 'type') && !s.selector && tx !== undefined && ty !== undefined) {
            try {
              const preNodes = lastSettleNodes ?? (sigBefore !== null
                ? ((await alloy.dispatch('alloy_snapshot', { udid, interactiveOnly: false }, deps.dispatchDeps) as
                    | { ok: true; result: { nodes?: SnapNode[] } } | { ok: false }))
                : null);
              const nodes = preNodes && 'ok' in preNodes && preNodes.ok ? (preNodes.result.nodes ?? []) : (preNodes as SnapNode[] | null);
              if (nodes && nodes.length > 0) {
                const hit = captureSelectorAt(nodes, tx, ty);
                if (hit) {
                  hardened = true;
                  hardenedSel = hit;
                  // persist: only when the step still has no selector (a
                  // concurrent edit may have added one) — same-connection
                  // transaction, template row rewritten atomically
                  const cur = deps.db.prepare('SELECT steps_json FROM templates WHERE id = ?').get(templateId) as { steps_json: string } | undefined;
                  if (cur) {
                    const steps = JSON.parse(cur.steps_json) as Array<Record<string, unknown>>;
                    // match by ACTION + COORDINATES, not idx: the executed list
                    // is the EXPANDED plan (subflows re-index), so s.idx is not
                    // the stored step's idx. Coordinates are the stable identity
                    // of a bare-coordinate step (that's the whole premise).
                    const target = steps.find((st) => st['action'] === s.action
                      && st['x'] === (s as { x?: number }).x && st['y'] === (s as { y?: number }).y
                      && !st['selector']);
                    if (target) {
                      target['selector'] = hit;
                      deps.db.prepare('UPDATE templates SET steps_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(steps), Date.now(), templateId);
                    }
                  }
                }
              }
            } catch { /* hardening is best-effort — never fails the run */ }
          }
          const resolvedByOut = resolvedBy === 'selector-point-scaled' ? 'selector' : resolvedBy;
          insStep.run(runId, s.idx, s.flow ?? t.name, stepName(s), 'pass', warnReason, t0, Date.now() - t0, '[]', JSON.stringify({ ...resolved, resolvedBy: resolvedByOut, ...(recentredAudit && { ...recentredAudit }), ...(sweepAudit && { sweep: sweepAudit }), ...(screenChanged !== undefined ? { screenChanged } : {}), ...(hardened && { hardened: true, selector: hardenedSel }), ...(s.flow && { flow: s.flow }) }), s.narrate ?? null);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (s.optional) {
            // optional miss: record and continue — the run stays green
            insStep.run(runId, s.idx, s.flow ?? t.name, stepName(s), 'skip', `optional miss: ${msg}`, t0, Date.now() - t0, '[]', JSON.stringify(resolved), s.narrate ?? null);
            continue;
          }
          runStatus = 'failed';
          // blocked = infrastructure failure (open/session/lease/timeout) —
          // renders amber ◆, distinct from an app-failure red.
          if (classifyBlocked(msg)) runBlocked = 1;
          insStep.run(runId, s.idx, s.flow ?? t.name, stepName(s), 'fail', msg, t0, Date.now() - t0, '[]', JSON.stringify(resolved), s.narrate ?? null);
          // remaining steps are skipped (deterministic replay stops at first failure)
          for (const rest of execSteps.filter((x) => x.idx > s.idx)) {
            insStep.run(runId, rest.idx, rest.flow ?? t.name, stepName(rest), 'skip', 'not reached', Date.now(), 0, '[]', null, rest.narrate ?? null);
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
            await recorder.finish();
      // Tier 2.3 — location hygiene: clear ONLY when this run set a
      // location (a pure-tap template never spawns a pointless clear);
      // best-effort by contract — a wedged clear never fails the run.
      if (locationSet) {
        try { await locationOps.clear(udid); } catch { /* hygiene best-effort */ }
      }
      // network conditioner hygiene (plan 20260928T153608Z): clear ONLY when
      // this run set a condition — an unpinned run must never wipe a manual
      // one (review F2). Best-effort; fires on abort too (this finally runs
      // for every settled run).
      if (conditionSet) {
        const cond = deps.networkCondition === undefined ? defaultNetworkCondition : deps.networkCondition;
        if (cond) { try { await cond(udid, { kind: 'clear' }); } catch { /* hygiene best-effort */ } }
      }
      // restore prior forge state — scenario was run-scoped by contract
      if (restorePresets) {
        try {
          forgeStateService(deps).clearScenario();
        } catch { /* restore best-effort */ }
      }
      // parallel-attribution-off: a stray CLEAR would null a sibling lane's
      // attribution — skip both writes symmetrically with the set above.
      if (attribute) {
        deps.forgeState.activeRunId = null;
        // B1: clear the addon's attribution too — rows after this point belong
        // to no run. (If a scenario restored above, that write already reset
        // activeRunId implicitly via the null default — this one is explicit.)
        try { forgeStateService(deps).setActiveRun(null); } catch { /* clear best-effort */ }
      }
      // managed-env audit (plan rev 2 S2.3): source COUNTS only, never values
      try {
        const s = resolvedBase.sources;
        const parts = [`global(${s.global})`, `app(${s.app})`, `plan(${s.plan})`, `request(${s.request})`];
        const cur0 = (deps.db.prepare('SELECT note FROM runs WHERE id = ?').get(runId) as { note: string | null } | undefined)?.note ?? '';
        deps.db.prepare(`UPDATE runs SET note = ? WHERE id = ?`).run((cur0 ? `${cur0}\n` : '') + `env sources: ${parts.join(' ')}`, runId);
      } catch { /* audit line best-effort */ }
      // policy audit lines — appended to whatever note exists
      if (noteLines.length > 0) {
        try {
          const cur = (deps.db.prepare('SELECT note FROM runs WHERE id = ?').get(runId) as { note: string | null } | undefined)?.note ?? '';
          deps.db.prepare(`UPDATE runs SET note = ? WHERE id = ?`).run((cur ? `${cur}\n` : '') + noteLines.join('\n'), runId);
        } catch { /* audit lines best-effort */ }
      }
      // B2: operator abort wins over the loop's natural verdict
      if (isAborted(runId)) runStatus = 'aborted';
      abortedRuns.delete(runId); // registry entry no longer needed once terminal
      deps.db.prepare(`UPDATE runs SET status = ?, finished_at = ?, blocked = ? WHERE id = ?`).run(runStatus, Date.now(), runBlocked, runId);
      deps.bus.emit('run.finished', { runId, status: runStatus, udid });
    }
  })();

  return { runId, udid, done };
}
