/** Manual drive: QA takes control of a device through Alloy under a held lease.
 *  The session IS a runs row (kind=manual) so wall/history stay truthful; manual
 *  never rolls up (structural, status.ts). Idle auto-finish after 5min.
 *
 *  Recorder: while `recording` is on, every tap/scroll/type appends a step to
 *  recording_json together with a post-action screenshot — the live config
 *  preview reads the same array, and "save as template" copies it out. */
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type { TypedEventBus, AppEvents } from '../ws/bus.ts';
import { dispatchWithHeal } from '../alloy/heal.ts';
import { quietKeyboard } from './keyboard-quiet.ts';
import { captureSelectorAt, countMatches } from './selector.ts';
import type { StepSelector, SnapNode } from './selector.ts';
import { engineInput } from './engine-input.ts';

export interface ManualDeps {
  db: Database.Database;
  bus: TypedEventBus<AppEvents>;
  dispatchDeps: unknown;
}

export type RecordedStep =
  | { idx: number; action: 'tap'; x: number; y: number; ts: number; thumb: string | null; selector: StepSelector | null }
  | { idx: number; action: 'scroll'; direction: 'up' | 'down' | 'left' | 'right'; ts: number; thumb: string | null }
  | { idx: number; action: 'type'; x: number; y: number; text: string; ts: number; thumb: string | null; selector: StepSelector | null };

interface RecordingState { on: boolean; steps: RecordedStep[] }

function readRecording(deps: ManualDeps, sessionId: string): RecordingState {
  const row = deps.db.prepare('SELECT recording_json FROM manual_sessions WHERE id = ?').get(sessionId) as
    | { recording_json: string | null }
    | undefined;
  if (!row?.recording_json) return { on: false, steps: [] };
  try {
    return JSON.parse(row.recording_json) as RecordingState;
  } catch {
    return { on: false, steps: [] };
  }
}

function writeRecording(deps: ManualDeps, sessionId: string, state: RecordingState): void {
  deps.db.prepare('UPDATE manual_sessions SET recording_json = ? WHERE id = ?').run(JSON.stringify(state), sessionId);
}

/** Append a step if the recorder is on; captures a post-action screenshot as
 *  the step thumbnail (best-effort — a snapshot failure must not fail the action). */
export type StepInput =
  | { action: 'tap'; x: number; y: number; selector?: StepSelector | null }
  | { action: 'scroll'; direction: 'up' | 'down' | 'left' | 'right'; selector?: StepSelector | null }
  | { action: 'swipe'; startX: number; startY: number; endX: number; endY: number; selector?: StepSelector | null }
  | { action: 'type'; x: number; y: number; text: string; selector?: StepSelector | null };

async function recordStep(deps: ManualDeps, sessionId: string, step: StepInput): Promise<RecordedStep | null> {
  const state = readRecording(deps, sessionId);
  if (!state.on) return null;
  let thumb: string | null = null;
  try {
    const r = (await dispatchWithHeal('alloy_screenshot', { udid: sessionUdid(deps, sessionId) }, deps.dispatchDeps)) as
      | { ok: true; result: { path: string } }
      | { ok: false };
    if (r.ok) thumb = r.result.path;
  } catch { /* thumbnail is best-effort */ }
  const { selector, ...rest } = step;
  const full: RecordedStep = { ...rest, idx: state.steps.length, ts: Date.now(), thumb, ...(step.action !== 'scroll' ? { selector: selector ?? null } : {}) } as RecordedStep;
  state.steps.push(full);
  writeRecording(deps, sessionId, state);
  deps.bus.emit('manual.session.step', { sessionId, step: full });
  return full;
}

function sessionUdid(deps: ManualDeps, sessionId: string): string {
  const s = deps.db.prepare('SELECT udid FROM manual_sessions WHERE id = ?').get(sessionId) as { udid: string } | undefined;
  if (!s) throw new ManualSessionError('SESSION_NOT_FOUND', `no session ${sessionId}`);
  return s.udid;
}

/** Alloy app sessions go stale under churn (device reboot, app relaunch, engine
 *  recycle): screenshot/snapshot then fail "No active session" while the
 *  OS-level stream still looks fine. Only alloy_apps open can bring the app
 *  session back — dispatchWithHeal's client reset cannot. Re-open using the
 *  bundle recorded at session start, once per call site. */
export async function ensureAppSession(deps: ManualDeps, sessionId: string): Promise<void> {
  const row = deps.db.prepare('SELECT udid, app_bundle_id FROM manual_sessions WHERE id = ? AND finished_at IS NULL').get(sessionId) as
    { udid: string; app_bundle_id: string | null } | undefined;
  if (!row) return; // dead session: the caller's own error path handles it
  const open = (await dispatchWithHeal('alloy_apps', { action: 'open', app: row.app_bundle_id ?? 'com.apple.Preferences', udid: row.udid, hold: false }, deps.dispatchDeps)) as
    | { ok: true }
    | { ok: false; error?: { message?: string } };
  if (!open.ok) console.warn(`[manual] app-session re-open failed for ${sessionId.slice(0, 12)}: ${open.error?.message ?? 'unknown'}`);
}

/** Run a dispatch, re-opening the app session once when the failure is the
 *  "No active session" staleness signature. */
export async function dispatchWithAppHeal(tool: string, input: { udid: string }, sessionId: string, deps: ManualDeps): Promise<unknown> {
  const first = (await dispatchWithHeal(tool, input, deps.dispatchDeps)) as { ok: boolean; error?: { message?: string } };
  if (first.ok || !/No active session|requires an active app session/i.test(first.error?.message ?? '')) return first;
  console.warn(`[manual] app session stale (${tool}) — re-opening and retrying once`);
  await ensureAppSession(deps, sessionId);
  return dispatchWithHeal(tool, input, deps.dispatchDeps);
}

/** Pre-action hierarchy hit-test (A6): best-effort — a snapshot failure must
 *  not fail the interaction; step just records selector: null. */
async function captureSelector(deps: ManualDeps, udid: string, x: number, y: number): Promise<StepSelector | null> {
  try {
    const snap = (await dispatchWithHeal('alloy_snapshot', { udid, interactiveOnly: false }, deps.dispatchDeps)) as
      | { ok: true; result: { nodes?: SnapNode[] } }
      | { ok: false };
    if (!snap.ok) return null;
    return captureSelectorAt(snap.result.nodes ?? [], x, y);
  } catch { return null; }
}

const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

export class ManualSessionError extends Error {
  constructor(public code: 'QUEUE_ACTIVE' | 'SESSION_NOT_FOUND' | 'SESSION_FINISHED' | 'LEASE_LOST' | 'BAD_RECT' | 'BAD_SAMPLE', message: string) {
    super(message);
  }
}

export async function startManualSession(deps: ManualDeps, udid: string, operator: string, appBundleId?: string): Promise<{ sessionId: string; logicalW: number | null; logicalH: number | null }> {
  return (async () => {
    const busy = deps.db
      .prepare(`SELECT 1 FROM runs WHERE device_udid = ? AND status IN ('queued','running') AND kind != 'manual' LIMIT 1`)
      .get(udid);
    if (busy) throw new ManualSessionError('QUEUE_ACTIVE', 'a queued/running automated run owns this device — wait or abort it');
    // waiting queue entries are fine (dispatcher serializes); only ACTIVE runs block

    // QA keyboard quieting (simulator-only, best-effort): autocorrect/prediction
    // animations starve XCTest's idle-wait during rapid typing taps.
    await quietKeyboard(udid);

    const runId = `run_${createHash('sha256').update(`manual${Date.now()}${Math.random()}`).digest('hex').slice(0, 8)}`;
    const sessionId = `ms_${runId.slice(4, 12)}`;
    // runs row (manual)
    deps.db
      .prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at, note)
                VALUES (?, 'MANUAL', 'manual', 'running', ?, ?, ?, ?)`)
      .run(runId, operator, udid, Date.now(), `manual:${sessionId}`);
    // Establish an active app session (alloy snapshot/act require one — alloy's
    // open needs an explicit bundle id, so true foreground detection is
    // chicken-and-egg here). Explicit param wins; Settings is the fallback.
    // Save-time app binding uses the SNAPSHOT root instead — ground truth.
    const open = (await dispatchWithHeal('alloy_apps', { action: 'open', app: appBundleId ?? 'com.apple.Preferences', udid, hold: false }, deps.dispatchDeps)) as
      | { ok: true }
      | { ok: false; error: { message: string } };
    if (!open.ok) {
      deps.db.prepare(`UPDATE runs SET status='aborted', finished_at=? WHERE id=?`).run(Date.now(), runId);
      throw new ManualSessionError('LEASE_LOST', `open failed: ${open.error.message}`);
    }
    // dimensions from snapshot for coord mapping
    const snap = (await dispatchWithHeal('alloy_snapshot', { udid, interactiveOnly: false }, deps.dispatchDeps)) as
      | { ok: true; result: { nodes?: Array<{ rect?: { width: number; height: number } }> } }
      | { ok: false };
    let w: number | null = null;
    let h: number | null = null;
    if (snap.ok) {
      const root = snap.result.nodes?.[0]?.rect;
      if (root) { w = root.width; h = root.height; }
    }
    deps.db
      .prepare(`INSERT INTO manual_sessions(id, run_id, udid, operator, logical_w, logical_h, started_at, last_activity, app_bundle_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(sessionId, runId, udid, operator, w, h, Date.now(), Date.now(), appBundleId ?? 'com.apple.Preferences');
    deps.bus.emit('manual.session.open', { sessionId, udid, operator, runId });
    return { sessionId, logicalW: w, logicalH: h };
  })();
}

function liveSession(deps: ManualDeps, sessionId: string): { id: string; run_id: string; udid: string; logical_w: number | null; logical_h: number | null } {
  const s = deps.db.prepare('SELECT * FROM manual_sessions WHERE id = ? AND finished_at IS NULL').get(sessionId) as
    | { id: string; run_id: string; udid: string; logical_w: number | null; logical_h: number | null }
    | undefined;
  if (!s) throw new ManualSessionError('SESSION_NOT_FOUND', `no live session ${sessionId}`);
  return s;
}

export function touchSessionActivity(deps: ManualDeps, sessionId: string): void {
  deps.db.prepare('UPDATE manual_sessions SET last_activity = ? WHERE id = ? AND finished_at IS NULL').run(Date.now(), sessionId);
}

export async function manualTap(deps: ManualDeps, sessionId: string, x: number, y: number): Promise<void> {
  const s = liveSession(deps, sessionId);
  // A6: capture WHAT was tapped from the pre-action hierarchy (recording only)
  const recordingOn = readRecording(deps, sessionId).on;
  const selector = recordingOn && x != null && y != null ? await captureSelector(deps, s.udid, x, y) : null;
  // fast path: engine-direct dispatch; alloy fallback on ack-timeout only
  // (selector capture above stays alloy regardless — recording's job)
  const sent = await engineInputWithFallback(deps, s.udid, { kind: 'tap', x, y }, async () => {
    const r = (await dispatchWithHeal('alloy_act', { udid: s.udid, action: 'press', target: { x, y }, settle: false }, deps.dispatchDeps)) as
      | { ok: true }
      | { ok: false; error: { code: string; message: string } };
    return r.ok;
  }, 'tap', { logicalW: s.logical_w ?? 0, logicalH: s.logical_h ?? 0 });
  if (!sent) throw new ManualSessionError('LEASE_LOST', 'tap failed (engine + alloy both refused)');
  deps.db.prepare('UPDATE manual_sessions SET last_activity = ? WHERE id = ?').run(Date.now(), sessionId);
  await recordStep(deps, sessionId, { action: 'tap', x, y, selector });
  deps.bus.emit('manual.session.tap', { sessionId, x, y });
}

/** Engine-direct input with alloy escape hatch: one gesture, logged
 *  fallback on ack-timeout/connect failure. Input is the engine's job;
 *  alloy stays for selector capture (see manualTap). */
async function engineInputWithFallback(
  deps: ManualDeps, udid: string, gesture: Record<string, unknown>,
  fallback: () => Promise<boolean>, logTag: string,
  dims?: { logicalW: number; logicalH: number },
): Promise<boolean> {
  try {
    await engineInput(udid, gesture, dims);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.warn(`[engine-input] ${logTag} fell back to alloy (${msg})`);
    return fallback();
  }
}

/** Generic engine gesture — no alloy fallback exists for new kinds
 *  (swipe/key/button/deltas): the failure surfaces honestly. */
export async function manualGesture(deps: ManualDeps, sessionId: string, gesture: Record<string, unknown>): Promise<void> {
  const s = liveSession(deps, sessionId);
  await engineInput(s.udid, gesture, { logicalW: s.logical_w ?? 0, logicalH: s.logical_h ?? 0 });
  deps.db.prepare('UPDATE manual_sessions SET last_activity = ? WHERE id = ?').run(Date.now(), sessionId);
  const kind = String(gesture['kind'] ?? 'gesture');
  if (kind === 'tap') {
    await recordStep(deps, sessionId, { action: 'tap', x: Number(gesture['x'] ?? 0), y: Number(gesture['y'] ?? 0) });
    deps.bus.emit('manual.session.tap', { sessionId, x: Number(gesture['x'] ?? 0), y: Number(gesture['y'] ?? 0) });
  } else if (kind === 'swipe') {
    await recordStep(deps, sessionId, { action: 'swipe', startX: Number(gesture['startX'] ?? 0), startY: Number(gesture['startY'] ?? 0), endX: Number(gesture['endX'] ?? 0), endY: Number(gesture['endY'] ?? 0) });
    deps.bus.emit('manual.session.swipe', { sessionId, gesture });
  }
}

export async function manualScroll(deps: ManualDeps, sessionId: string, direction: 'up' | 'down' | 'left' | 'right'): Promise<void> {
  const s = liveSession(deps, sessionId);
  // engine deltas: fixed 240pt per direction tick keeps the old route's
  // semantics on the new fast path
  const delta = 240;
  const deltas: Record<string, [number, number]> = { up: [0, delta], down: [0, -delta], left: [delta, 0], right: [-delta, 0] };
  const [dx, dy] = deltas[direction] ?? [0, 0];
  const sent = await engineInputWithFallback(deps, s.udid, { kind: 'scroll', deltaX: dx, deltaY: dy }, async () => {
    const r = (await dispatchWithHeal('alloy_act', { udid: s.udid, action: 'scroll', direction, settle: false }, deps.dispatchDeps)) as
      | { ok: true }
      | { ok: false };
    return r.ok;
  }, 'scroll', { logicalW: s.logical_w ?? 0, logicalH: s.logical_h ?? 0 });
  if (!sent) throw new ManualSessionError('LEASE_LOST', 'scroll failed');
  deps.db.prepare('UPDATE manual_sessions SET last_activity = ? WHERE id = ?').run(Date.now(), sessionId);
  await recordStep(deps, sessionId, { action: 'scroll', direction });
  deps.bus.emit('manual.session.scroll', { sessionId, direction });
}

export async function manualType(deps: ManualDeps, sessionId: string, x: number | null, y: number | null, text: string): Promise<void> {
  const s = liveSession(deps, sessionId);
  // A6: capture the field identity pre-action (recording only)
  const recordingOn = readRecording(deps, sessionId).on;
  const selector = recordingOn && x != null && y != null ? await captureSelector(deps, s.udid, x, y) : null;
  // engine fast path: keystrokes into the device's FOCUSED field (real
  // typing — no coordinates). alloy fill-by-coordinates is the fallback
  // for the nothing-focused case.
  const sent = await engineInputWithFallback(deps, s.udid, { kind: 'type', text }, async () => {
    // settle:false — a fill into a focused field needs no app-idle settle; a
    // settle:true fill starves when the screen never idles (search spinner,
    // blinking caret) and hangs the route (found live: 40s+ on the food
    // picker). manualScroll's fallback already follows this contract.
    const r = (await dispatchWithHeal('alloy_act', { udid: s.udid, action: 'fill', target: { x: x ?? 0, y: y ?? 0 }, text, settle: false }, deps.dispatchDeps)) as
      | { ok: true }
      | { ok: false; error: { code: string; message: string } };
    return r.ok;
  }, 'type', { logicalW: s.logical_w ?? 0, logicalH: s.logical_h ?? 0 });
  if (!sent) throw new ManualSessionError('LEASE_LOST', 'type failed: engine + alloy both refused');
  deps.db.prepare('UPDATE manual_sessions SET last_activity = ? WHERE id = ?').run(Date.now(), sessionId);
  await recordStep(deps, sessionId, { action: 'type', x: x ?? 0, y: y ?? 0, text, selector });
  deps.bus.emit('manual.session.type', { sessionId, x: x ?? 0, y: y ?? 0, len: text.length });
}

// ── recorder controls ────────────────────────────────────────────────────────

export function setRecording(deps: ManualDeps, sessionId: string, on: boolean): { on: boolean; steps: RecordedStep[] } {
  liveSession(deps, sessionId); // throws if not live
  const state = readRecording(deps, sessionId);
  state.on = on;
  writeRecording(deps, sessionId, state);
  deps.bus.emit('manual.session.recording', { sessionId, on });
  return state;
}

export function getRecording(deps: ManualDeps, sessionId: string): { on: boolean; steps: RecordedStep[] } {
  liveSession(deps, sessionId);
  return readRecording(deps, sessionId);
}

/** Remove a step by idx and renumber (live config preview edit). */
export function deleteRecordedStep(deps: ManualDeps, sessionId: string, idx: number): { on: boolean; steps: RecordedStep[] } {
  liveSession(deps, sessionId);
  const state = readRecording(deps, sessionId);
  state.steps = state.steps.filter((s) => s.idx !== idx).map((s, i) => ({ ...s, idx: i }));
  writeRecording(deps, sessionId, state);
  return state;
}

export async function manualSnapshot(deps: ManualDeps, sessionId: string): Promise<{ path: string }> {
  const s = liveSession(deps, sessionId);
  const r = (await dispatchWithHeal('alloy_screenshot', { udid: s.udid }, deps.dispatchDeps)) as
    | { ok: true; result: { path: string } }
    | { ok: false; error: { message: string } };
  if (!r.ok) throw new ManualSessionError('LEASE_LOST', `snapshot failed: ${r.error.message}`);
  deps.db.prepare('UPDATE manual_sessions SET last_activity = ? WHERE id = ?').run(Date.now(), sessionId);
  deps.bus.emit('manual.session.snapshot', { sessionId, path: r.result.path });
  return r.result;
}

/** A7 authoring aid: count live matches for a selector BEFORE QA commits an
 *  assertion — "1 match · will assert" vs "0 · nothing to assert". Also
 *  returns the screen's addressable labels so the UI can offer a picker. */
export async function manualProbeSelector(deps: ManualDeps, sessionId: string, sel: { identifier?: string; label?: string; type?: string }): Promise<{ matched: number; labels: string[] }> {
  const s = liveSession(deps, sessionId);
  const snap = (await dispatchWithHeal('alloy_snapshot', { udid: s.udid, interactiveOnly: false }, deps.dispatchDeps)) as
    | { ok: true; result: { nodes?: SnapNode[] } }
    | { ok: false };
  const nodesL = snap.ok ? snap.result.nodes ?? [] : [];
  const matched = countMatches(nodesL, sel);
  const labels = [...new Set(nodesL.filter((n) => n.label).map((n) => n.label as string))].sort().slice(0, 200);
  deps.db.prepare('UPDATE manual_sessions SET last_activity = ? WHERE id = ?').run(Date.now(), sessionId);
  return { matched, labels };
}

/** Inspect mode: the full AX tree for the overlay — boxes, hover hit-testing
 *  and the element drawer all live client-side off this one payload. Server
 *  stays a dumb pipe: nodes pass through VERBATIM (interpretation belongs to
 *  @crucible/shared/ax-tree, one predicate for engine and overlay). */
export async function manualTree(deps: ManualDeps, sessionId: string): Promise<{ nodes: SnapNode[]; logicalW: number | null; logicalH: number | null; capturedAt: number }> {
  const s = liveSession(deps, sessionId);
  const snap = (await dispatchWithHeal('alloy_snapshot', { udid: s.udid, interactiveOnly: false }, deps.dispatchDeps)) as
    | { ok: true; result: { nodes?: SnapNode[] } }
    | { ok: false; error?: { message?: string } };
  if (!snap.ok) throw new ManualSessionError('LEASE_LOST', `tree failed: ${snap.error?.message ?? 'snapshot dispatch failed'}`);
  const nodes = snap.result.nodes ?? [];
  const root = nodes.find((n) => n.type === 'Application')?.rect;
  const w = root?.width ?? s.logical_w ?? null;
  const h = root?.height ?? s.logical_h ?? null;
  deps.db.prepare('UPDATE manual_sessions SET last_activity = ? WHERE id = ?').run(Date.now(), sessionId);
  deps.bus.emit('manual.session.tree', { sessionId, nodes: nodes.length });
  return { nodes, logicalW: w, logicalH: h, capturedAt: Date.now() };
}

/** A7: append an expect step to the recording REGARDLESS of record toggle —
 *  assertions are added deliberately (typed/probed), not incidentally, and
 *  QA typically adds them mid-session with recording off. Thumbnail shows
 *  the screen being asserted. Returns the updated steps. */
export function recordExpectStep(deps: ManualDeps, sessionId: string, selector: StepSelector, point?: { x: number; y: number }): { on: boolean; steps: RecordedStep[] } {
  const state = readRecording(deps, sessionId);
  let thumb: string | null = null;
  try {
    const r = (() => dispatchWithHeal('alloy_screenshot', { udid: sessionUdid(deps, sessionId) }, deps.dispatchDeps)) as unknown as Promise<{ ok: true; result: { path: string } } | { ok: false }>;
    void r.then((res) => {
      if (res.ok) {
        const st = readRecording(deps, sessionId);
        const step = st.steps.find((x) => x.idx === state.steps.length);
        if (step) { step.thumb = res.result.path; writeRecording(deps, sessionId, st); }
      }
    }).catch(() => undefined);
  } catch { /* thumb best-effort */ }
  const full: RecordedStep = { idx: state.steps.length, action: 'expect', ts: Date.now(), thumb, selector, ...(point ? { x: point.x, y: point.y } : {}) } as unknown as RecordedStep;
  state.steps.push(full);
  writeRecording(deps, sessionId, state);
  deps.bus.emit('manual.session.step', { sessionId, step: full });
  return { on: state.on, steps: state.steps };
}

export async function finishManualSession(deps: ManualDeps, sessionId: string, note?: string): Promise<void> {
  const s = deps.db.prepare('SELECT * FROM manual_sessions WHERE id = ?').get(sessionId) as
    | { id: string; run_id: string; udid: string; finished_at: number | null }
    | undefined;
  if (!s) throw new ManualSessionError('SESSION_NOT_FOUND', `no session ${sessionId}`);
  if (s.finished_at) return; // idempotent
  await dispatchWithHeal('alloy_release', { udid: s.udid }, deps.dispatchDeps).catch(() => undefined);
  deps.db.prepare('UPDATE manual_sessions SET finished_at = ? WHERE id = ?').run(Date.now(), sessionId);
  deps.db.prepare(`UPDATE runs SET status = 'passed', finished_at = ?, note = ? WHERE id = ?`).run(Date.now(), note ?? `manual:${sessionId}`, s.run_id);
  deps.bus.emit('manual.session.finish', { sessionId });
  // revoke engine-side input — the device is free again
}

/** Boot + interval: finish sessions idle > 5min (crash safety). */
export function startIdleWatchdog(deps: ManualDeps, intervalMs = 30_000): () => void {
  const tick = (): void => {
    const stale = deps.db
      .prepare('SELECT id FROM manual_sessions WHERE finished_at IS NULL AND last_activity < ?')
      .all(Date.now() - IDLE_TIMEOUT_MS) as Array<{ id: string }>;
    for (const { id } of stale) {
      void finishManualSession(deps, id, 'manual:auto-finished(idle)').catch(() => undefined);
    }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}
