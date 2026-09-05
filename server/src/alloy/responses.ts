/** Engine-response codecs — the narrow boundary where untyped alloy results
 *  become typed Crucible values. Retires the scattered `as` casts and the
 *  message-regex error classification accumulated during the wedge fixes:
 *  classification is by STRUCTURE (ok + shape), strings only as labeled
 *  detail. If the engine changes shape, the codec fails closed (unknown →
 *  'other' / null), never by accidental string match. */

export interface SnapNode {
  index: number;
  parentIndex: number;
  type?: string;
  label?: string;
  identifier?: string;
  rect?: { x: number; y: number; width: number; height: number };
  hittable?: boolean;
  [k: string]: unknown;
}

type DispatchOk = { ok: true; result: unknown };
type DispatchErr = { ok: false; error?: { message?: string; code?: string } };
export type DispatchResult = DispatchOk | DispatchErr | { ok: boolean; result?: unknown; error?: { message?: string; code?: string } };

function isOk(r: DispatchResult): r is DispatchOk {
  return (r as { ok?: boolean }).ok === true;
}

/** snapshot → nodes (null when the dispatch failed or shape is unexpected) */
export function decodeSnapshotResult(r: DispatchResult): SnapNode[] | null {
  if (!isOk(r)) return null;
  const nodes = (r.result as { nodes?: unknown } | undefined)?.nodes;
  return Array.isArray(nodes) ? (nodes as SnapNode[]) : null;
}

/** alert inspect → the probed engine contract:
 *  ok:true with a message = dialog present; ok:false "alert not found" = none;
 *  anything else = error (never treated as presence). */
export type AlertInspect =
  | { present: true; message: string }
  | { present: false }
  | { error: string };

export function decodeAlertInspect(r: DispatchResult): AlertInspect {
  if (!isOk(r)) {
    const msg = (r as DispatchErr).error?.message ?? '';
    if (msg.includes('alert not found')) return { present: false };
    return { error: msg || 'engine error' };
  }
  const message = (r.result as { message?: unknown } | undefined)?.message;
  if (typeof message === 'string' && message.length > 0) return { present: true, message };
  return { error: 'alert inspect returned ok without a message' };
}

/** error classification for the known engine conditions Crucible reacts to.
 *  Ordered by specificity; unknown → 'other'. */
export type EngineErrorClass =
  | 'runner-busy'        // act refused before execution (safe to resend)
  | 'already-recording'  // video start refused (stale/wedged recorder)
  | 'session-claimed'    // device owned by a session (ours to release)
  | 'fetch-failed'       // transport loss (retryable, NOT safe to resend mutations)
  | 'other';

export function classifyEngineError(r: DispatchResult): EngineErrorClass {
  if (isOk(r)) return 'other';
  const err = (r as DispatchErr).error;
  const msg = err?.message ?? '';
  const code = err?.code ?? '';
  if (code === 'RUNNER_BUSY' || msg.includes('still finishing a previous command')) return 'runner-busy';
  if (msg.includes('video recording is already active')) return 'already-recording';
  if (/is owned by session|DEVICE_IN_USE/i.test(msg)) return 'session-claimed';
  if (code === 'TRANS_FETCH_FAILED' || /fetch failed|ECONNREFUSED/i.test(msg)) return 'fetch-failed';
  return 'other';
}
