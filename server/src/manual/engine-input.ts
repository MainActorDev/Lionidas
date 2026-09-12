/** Simdeck input channel — server-side device-control dispatch to the wrapped
 *  surface's `POST /simulators/:udid/input` route during a driving session.
 *
 *  Replaces the engine-WS transport (the first-party engine is retired): the
 *  child's HTTP route takes the SAME gesture dialect with two dialect keys —
 *  `type` (not `kind`) and `width`/`height` in device points on tap/swipe so
 *  it can normalize (missing dims = parse error, found live). Grants are a
 *  no-op: the gated proxy (simdeck/proxy.ts) enforces session ownership at
 *  the network seam — the server-side fetch bypasses the proxy loop entirely
 *  (it talks to the child directly, which is what a driving session means).
 *
 *  Acks: HTTP `{ok:boolean}` — no seq correlation needed. Timeouts reject
 *  with INPUT_TIMEOUT so callers' alloy fallbacks keep working. */
const ACK_TIMEOUT_MS = 2_000;
/** `type` is the one kind whose ack latency scales with payload: the child
 *  holds the route until every keystroke lands (~105ms/char measured, live).
 *  A flat 2s budget aborts mid-type at ~19 chars, forcing the alloy fill
 *  fallback to re-run the whole string (or hang forever on a never-idle
 *  screen — settle starvation). Budget = base + per-char headroom. */
const TYPE_ACK_PER_CHAR_MS = 300;
export function ackTimeoutMsFor(gesture: Record<string, unknown>): number {
  const text = gesture['text'];
  const chars = typeof text === 'string' ? text.length : 0;
  return ACK_TIMEOUT_MS + chars * TYPE_ACK_PER_CHAR_MS;
}
export const INPUT_TIMEOUT = 'INPUT_TIMEOUT';

/** test seam: replace the base URL entirely. */
let baseOverride: (() => string) | null = null;
export function __setSimdeckInputBaseForTest(fn: (() => string) | null): void {
  baseOverride = fn;
}

function base(): string {
  if (baseOverride) return baseOverride();
  // lazy require pattern avoids importing the supervisor (and its spawn state)
  // into every consumer of this module
  const port = Number(process.env['CRUCIBLE_SIMDECK_PORT'] ?? 8422);
  return `http://127.0.0.1:${port}`;
}

/** our gesture dialect → the child's. ONE translation table (plan Task 1.5):
 *  tap/swipe carry width/height (device points) for normalization; `kind`
 *  renames to `type`; everything else passes through. */
const POSITIONAL_KINDS = new Set(['tap', 'swipe', 'touch1', 'touch2', 'pan']);
/** Crucible kinds whose child wire type differs (verified: 'press' -> "unknown kind: press"). */
const KIND_TO_WIRE: Record<string, string> = { press: 'button' };

export function toSimdeckGesture(gesture: Record<string, unknown>, logicalW: number, logicalH: number): Record<string, unknown> {
  const out: Record<string, unknown> = { ...gesture };
  if ('kind' in out) {
    const k = String(out['kind']);
    out['type'] = KIND_TO_WIRE[k] ?? k;
    delete out['kind'];
  }
  const t = out['type'] as string | undefined;
  // the child requires width/height on EVERY positional gesture (verified:
  // touch1 without dims -> "missing field: width")
  if (t && POSITIONAL_KINDS.has(t) && logicalW > 0 && logicalH > 0) {
    out['width'] = logicalW;
    out['height'] = logicalH;
  }
  return out;
}

/** Send one input gesture; resolves on ok. Rejects INPUT_TIMEOUT / connect
 *  errors — the caller decides whether to fall back. */
export async function engineInput(udid: string, gesture: Record<string, unknown>, dims?: { logicalW: number; logicalH: number }): Promise<void> {
  const body = toSimdeckGesture(gesture, dims?.logicalW ?? 0, dims?.logicalH ?? 0);
  let r: Response;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ackTimeoutMsFor(gesture));
  try {
    r = await fetch(`${base()}/simulators/${encodeURIComponent(udid)}/input`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('abort') || msg.includes('timeout')) throw new Error(INPUT_TIMEOUT);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!r.ok) throw new Error(`simdeck input HTTP ${r.status}`);
  const ack = await r.json().catch(() => ({ ok: false })) as { ok?: boolean };
  assertAck(ack);
}

/** Pure ack interpretation — unit-tested apart from the http round trip
 *  (the ok:false-path integration hung under the vitest runner for reasons
 *  never isolated; the contract itself is proven here + by the ok:true
 *  integration test + connect-failure test). */
export function assertAck(ack: { ok?: boolean }): void {
  if (ack.ok !== true) throw new Error(INPUT_TIMEOUT);
}
