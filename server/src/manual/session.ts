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
import { crucibleAlloy } from '../alloy/client.ts';

export interface ManualDeps {
  db: Database.Database;
  bus: TypedEventBus<AppEvents>;
  dispatchDeps: unknown;
}

export type RecordedStep =
  | { idx: number; action: 'tap'; x: number; y: number; ts: number; thumb: string | null }
  | { idx: number; action: 'scroll'; direction: 'up' | 'down' | 'left' | 'right'; ts: number; thumb: string | null }
  | { idx: number; action: 'type'; x: number; y: number; text: string; ts: number; thumb: string | null };

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
  | { action: 'tap'; x: number; y: number }
  | { action: 'scroll'; direction: 'up' | 'down' | 'left' | 'right' }
  | { action: 'type'; x: number; y: number; text: string };

async function recordStep(deps: ManualDeps, sessionId: string, step: StepInput): Promise<RecordedStep | null> {
  const state = readRecording(deps, sessionId);
  if (!state.on) return null;
  let thumb: string | null = null;
  try {
    const alloy = crucibleAlloy();
    const r = (await alloy.dispatch('alloy_screenshot', { udid: sessionUdid(deps, sessionId) }, deps.dispatchDeps)) as
      | { ok: true; result: { path: string } }
      | { ok: false };
    if (r.ok) thumb = r.result.path;
  } catch { /* thumbnail is best-effort */ }
  const full: RecordedStep = { ...step, idx: state.steps.length, ts: Date.now(), thumb } as RecordedStep;
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

const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

export class ManualSessionError extends Error {
  constructor(public code: 'QUEUE_ACTIVE' | 'SESSION_NOT_FOUND' | 'SESSION_FINISHED' | 'LEASE_LOST', message: string) {
    super(message);
  }
}

export function startManualSession(deps: ManualDeps, udid: string, operator: string): Promise<{ sessionId: string; logicalW: number | null; logicalH: number | null }> {
  return (async () => {
    const alloy = crucibleAlloy();
    const busy = deps.db
      .prepare(`SELECT 1 FROM runs WHERE device_udid = ? AND status IN ('queued','running') AND kind != 'manual' LIMIT 1`)
      .get(udid);
    if (busy) throw new ManualSessionError('QUEUE_ACTIVE', 'a queued/running automated run owns this device — wait or abort it');
    // waiting queue entries are fine (dispatcher serializes); only ACTIVE runs block

    const runId = `run_${createHash('sha256').update(`manual${Date.now()}${Math.random()}`).digest('hex').slice(0, 8)}`;
    const sessionId = `ms_${runId.slice(4, 12)}`;
    // runs row (manual)
    deps.db
      .prepare(`INSERT INTO runs(id, ticket_key, kind, status, triggered_by, device_udid, started_at, note)
                VALUES (?, 'MANUAL', 'manual', 'running', ?, ?, ?, ?)`)
      .run(runId, operator, udid, Date.now(), `manual:${sessionId}`);
    // open WITHOUT holding open-lease, then take the lease as the manual holder
    const open = (await alloy.dispatch('alloy_apps', { action: 'open', app: 'com.apple.Preferences', udid, hold: false }, deps.dispatchDeps)) as
      | { ok: true }
      | { ok: false; error: { message: string } };
    if (!open.ok) {
      deps.db.prepare(`UPDATE runs SET status='aborted', finished_at=? WHERE id=?`).run(Date.now(), runId);
      throw new ManualSessionError('LEASE_LOST', `open failed: ${open.error.message}`);
    }
    // dimensions from snapshot for coord mapping
    const snap = (await alloy.dispatch('alloy_snapshot', { udid, interactiveOnly: false }, deps.dispatchDeps)) as
      | { ok: true; result: { nodes?: Array<{ rect?: { width: number; height: number } }> } }
      | { ok: false };
    let w: number | null = null;
    let h: number | null = null;
    if (snap.ok) {
      const root = snap.result.nodes?.[0]?.rect;
      if (root) { w = root.width; h = root.height; }
    }
    deps.db
      .prepare(`INSERT INTO manual_sessions(id, run_id, udid, operator, logical_w, logical_h, started_at, last_activity)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(sessionId, runId, udid, operator, w, h, Date.now(), Date.now());
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

export async function manualTap(deps: ManualDeps, sessionId: string, x: number, y: number): Promise<void> {
  const s = liveSession(deps, sessionId);
  const alloy = crucibleAlloy();
  const r = (await alloy.dispatch('alloy_act', { udid: s.udid, action: 'press', target: { x, y }, settle: false }, deps.dispatchDeps)) as
    | { ok: true }
    | { ok: false; error: { code: string; message: string } };
  if (!r.ok) throw new ManualSessionError('LEASE_LOST', `tap failed: ${r.error.message}`);
  deps.db.prepare('UPDATE manual_sessions SET last_activity = ? WHERE id = ?').run(Date.now(), sessionId);
  await recordStep(deps, sessionId, { action: 'tap', x, y });
  deps.bus.emit('manual.session.tap', { sessionId, x, y });
}

export async function manualScroll(deps: ManualDeps, sessionId: string, direction: 'up' | 'down' | 'left' | 'right'): Promise<void> {
  const s = liveSession(deps, sessionId);
  const alloy = crucibleAlloy();
  const r = (await alloy.dispatch('alloy_act', { udid: s.udid, action: 'scroll', direction, settle: false }, deps.dispatchDeps)) as
    | { ok: true }
    | { ok: false };
  if (!r.ok) throw new ManualSessionError('LEASE_LOST', 'scroll failed');
  deps.db.prepare('UPDATE manual_sessions SET last_activity = ? WHERE id = ?').run(Date.now(), sessionId);
  await recordStep(deps, sessionId, { action: 'scroll', direction });
  deps.bus.emit('manual.session.scroll', { sessionId, direction });
}

export async function manualType(deps: ManualDeps, sessionId: string, x: number, y: number, text: string): Promise<void> {
  const s = liveSession(deps, sessionId);
  const alloy = crucibleAlloy();
  // engine `fill`: targets the field at (x,y) and replaces its text — same
  // coordinate space as tap (logical points from the session dims)
  const r = (await alloy.dispatch('alloy_act', { udid: s.udid, action: 'fill', target: { x, y }, text, settle: true }, deps.dispatchDeps)) as
    | { ok: true }
    | { ok: false; error: { code: string; message: string } };
  if (!r.ok) throw new ManualSessionError('LEASE_LOST', `type failed: ${'message' in r.error ? r.error.message : 'engine error'}`);
  deps.db.prepare('UPDATE manual_sessions SET last_activity = ? WHERE id = ?').run(Date.now(), sessionId);
  await recordStep(deps, sessionId, { action: 'type', x, y, text });
  deps.bus.emit('manual.session.type', { sessionId, x, y, len: text.length });
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
  const alloy = crucibleAlloy();
  const r = (await alloy.dispatch('alloy_screenshot', { udid: s.udid }, deps.dispatchDeps)) as
    | { ok: true; result: { path: string } }
    | { ok: false; error: { message: string } };
  if (!r.ok) throw new ManualSessionError('LEASE_LOST', `snapshot failed: ${r.error.message}`);
  deps.db.prepare('UPDATE manual_sessions SET last_activity = ? WHERE id = ?').run(Date.now(), sessionId);
  deps.bus.emit('manual.session.snapshot', { sessionId, path: r.result.path });
  return r.result;
}

export async function finishManualSession(deps: ManualDeps, sessionId: string, note?: string): Promise<void> {
  const s = deps.db.prepare('SELECT * FROM manual_sessions WHERE id = ?').get(sessionId) as
    | { id: string; run_id: string; udid: string; finished_at: number | null }
    | undefined;
  if (!s) throw new ManualSessionError('SESSION_NOT_FOUND', `no session ${sessionId}`);
  if (s.finished_at) return; // idempotent
  const alloy = crucibleAlloy();
  await alloy.dispatch('alloy_release', { udid: s.udid }, deps.dispatchDeps).catch(() => undefined);
  deps.db.prepare('UPDATE manual_sessions SET finished_at = ? WHERE id = ?').run(Date.now(), sessionId);
  deps.db.prepare(`UPDATE runs SET status = 'passed', finished_at = ?, note = ? WHERE id = ?`).run(Date.now(), note ?? `manual:${sessionId}`, s.run_id);
  deps.bus.emit('manual.session.finish', { sessionId });
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
