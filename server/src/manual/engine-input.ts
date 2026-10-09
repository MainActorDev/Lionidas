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
const POSITIONAL_KINDS = new Set(['tap', 'swipe', 'touch1', 'touch2', 'pan', 'scroll']); // scroll: the child synthesizes a 2-finger pan (scroll-HID aborts backboardd) and needs the screen size
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

/** Ack interpretation that keeps the child's own words: a `ok:false` ack
 *  with an error string (e.g. "device busy: a gesture is already in
 *  flight" — the per-sim input gate, child ServerPluginRoutes) surfaces
 *  that text instead of collapsing into INPUT_TIMEOUT. Timed sequences
 *  (double-tap) must NOT blind-retry a busy ack — an honest failure beats
 *  a tap into possibly-changed screen state (plan F2). */
export function assertAckVerbose(ack: { ok?: boolean; error?: string }): void {
  if (ack.ok === true) return;
  if (typeof ack.error === 'string' && ack.error.length > 0) {
    throw new Error(`INPUT_REFUSED: ${ack.error}`);
  }
  throw new Error(INPUT_TIMEOUT);
}

/** child ack shape carrying an error string (INPUT_REFUSED source). */
type ChildAck = { ok?: boolean; error?: string };

async function postInput(udid: string, body: Record<string, unknown>, timeoutMs: number): Promise<ChildAck> {
  let r: Response;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
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
  return r.json().catch(() => ({ ok: false })) as ChildAck;
}

// ---------------------------------------------------------------------------
// Stage-1 input verbs (plan 20261009T001703Z, T0-probed 2026-10-09)

/** Double-tap cadence constants — MEASUREED, not free numbers (T0(c)):
 *  per-event dispatch overhead ≈ 57–90 ms on the ack path, so the sleeps
 *  are pre-compensated. hold sleep 25 ms → ~113 ms actual hold;
 *  gap sleep 0 → ~96 ms actual inter-tap gap. iOS aggregates taps into a
 *  double-tap below ~250 ms; measured gap 96 ms passes the ≤120 ms plan
 *  criterion with headroom. */
const DT_HOLD_SLEEP_MS = 25;
const DT_GAP_SLEEP_MS = 0;
const LP_DWELL_DEFAULT_MS = 800; // T0(d): 800 ms dwell fired the context menu (~500 ms threshold)

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

/** Double-tap via four timed touch1 events over the child HTTP input route.
 *  Busy acks surface verbatim (assertAckVerbose) — no blind retries. */
export async function doubleTapSim(udid: string, x: number, y: number, dims: { logicalW: number; logicalH: number }): Promise<void> {
  const point = { x, y, ...(dims.logicalW > 0 && dims.logicalH > 0 ? { width: dims.logicalW, height: dims.logicalH } : {}) };
  assertAckVerbose(await postInput(udid, { type: 'touch1-down', ...point }, ACK_TIMEOUT_MS));
  await sleep(DT_HOLD_SLEEP_MS);
  assertAckVerbose(await postInput(udid, { type: 'touch1-up', ...point }, ACK_TIMEOUT_MS));
  await sleep(DT_GAP_SLEEP_MS);
  assertAckVerbose(await postInput(udid, { type: 'touch1-down', ...point }, ACK_TIMEOUT_MS));
  await sleep(DT_HOLD_SLEEP_MS);
  assertAckVerbose(await postInput(udid, { type: 'touch1-up', ...point }, ACK_TIMEOUT_MS));
}

/** Long-press via touch1 down → dwell → up (T0(d)-proven recipe). */
export async function longPressSim(udid: string, x: number, y: number, dwellMs: number, dims: { logicalW: number; logicalH: number }): Promise<void> {
  const dwell = dwellMs > 0 ? dwellMs : LP_DWELL_DEFAULT_MS;
  const point = { x, y, ...(dims.logicalW > 0 && dims.logicalH > 0 ? { width: dims.logicalW, height: dims.logicalH } : {}) };
  assertAckVerbose(await postInput(udid, { type: 'touch1-down', ...point }, ACK_TIMEOUT_MS));
  await sleep(dwell);
  assertAckVerbose(await postInput(udid, { type: 'touch1-up', ...point }, ACK_TIMEOUT_MS));
}

/** Shake — the child's own HTTP route (T0(a): 200 twice). Same ack
 *  contract; the child answers `{"ok":true}` JSON. */
export async function shakeSim(udid: string): Promise<void> {
  let r: Response;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ACK_TIMEOUT_MS);
  try {
    r = await fetch(`${base()}/simulators/${encodeURIComponent(udid)}/shake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'close' },
      signal: ac.signal,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('abort') || msg.includes('timeout')) throw new Error(INPUT_TIMEOUT);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!r.ok) throw new Error(`simdeck shake HTTP ${r.status}`);
  assertAckVerbose(await r.json().catch(() => ({ ok: false })) as ChildAck);
}

/** Paste — composed in Lionidas (plan F1; T0(b)-proven): set the sim
 *  pasteboard via `xcrun simctl pbcopy` (text on stdin — baguette's own
 *  recipe), then Cmd+V through the child input route. `press:false` stops
 *  after the pasteboard set (apps reading UIPasteboard directly). */
export async function pasteTextSim(udid: string, text: string, execFile: typeof import('node:child_process').execFile, press = true): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = execFile('xcrun', ['simctl', 'pbcopy', udid], { maxBuffer: 10 * 1024 * 1024 }, (err: Error | null) => {
      if (err) reject(new Error(`pbcopy failed: ${err.message}`));
      else resolve();
    });
    child.stdin?.on('error', () => { /* EPIPE if the child exits early; execFile callback reports the real error */ });
    child.stdin?.end(text, 'utf8');
  });
  if (!press) return;
  assertAckVerbose(await postInput(udid, { type: 'key', code: 'KeyV', modifiers: ['command'] }, ACK_TIMEOUT_MS));
}
