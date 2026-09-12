/** Device input — pointer/keyboard/wheel dispatch from the stream canvas
 *  to the manual-session routes (server relays to the engine).
 *
 *  Contract: dispatch ONLY while a driving session is live; the server
 *  re-checks ownership anyway (defense in depth). Coordinates convert
 *  CSS → logical points through the canvas rect, same math as taps
 *  before this composable existed. */
import { ref, type Ref } from 'vue';

interface LogicalDims { w?: number | null; h?: number | null }

export function useDeviceInput(
  sessionId: Ref<string | null>,
  logical: Ref<LogicalDims>,
  api: (path: string, body?: unknown) => Promise<Record<string, unknown>>,
  /** optional: notified when an input is dispatched to the device (tap,
   *  drag, wheel-pan/pinch, key). Lets inspect mode invalidate its AX tree
   *  and lets a surface block dispatch entirely while inspecting. */
  onGesture?: (kind: 'tap' | 'scroll' | 'drag' | 'pinch' | 'key') => void,
) {
  const failed = ref('');

  /** set by the owning surface: while true, pointer taps/drags are NOT
   *  dispatched to the device (inspect mode: clicks select, screen must
   *  not move). Wheel + keys stay live: they're navigation per the
   *  inspect contract, and their dispatch notifies onGesture so the tree
   *  invalidates anyway. */
  let inputSuspended = false;
  function setSuspended(v: boolean): void { inputSuspended = v; }

  function canvasPointToLogical(canvas: HTMLCanvasElement, clientX: number, clientY: number): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    const w = logical.value.w ?? canvas.width;
    const h = logical.value.h ?? canvas.height;
    return {
      x: Math.round(((clientX - rect.left) / rect.width) * w),
      y: Math.round(((clientY - rect.top) / rect.height) * h),
    };
  }

  async function post(path: string, body: unknown): Promise<void> {
    if (!sessionId.value) return;
    failed.value = '';
    // HTTP through crucible's session routes — the server owns the child
    // dialect translation (kind→type, press→button, dims). The old engine-WS
    // fast path is gone with the engine: it wrapped gestures in a
    // {type:'input'} envelope the child parses as "unknown kind: input" and
    // silently dropped (every wall tap vanished with no error).
    const r = await api(`${sessionId.value}/${path}`, body);
    if (r['error']) failed.value = String(r['error']);
  }

  // ── pointer state machine (baguette's MouseGestureSource, 1:1) ──
  // mousedown: 'pending', NO wire traffic. Move past the threshold:
  // touchDown + stream touchMove (drag). Up without promotion: ONE atomic
  // tap envelope (engine does down→50ms hold→up). Streaming an immediate
  // down and lifting it left iOS with a stuck/two-finger touch — the bug
  // this replaces.
  const DRAG_THRESHOLD_PX = 6;
  let lastPt = { x: 0, y: 0 };
  let pState: 'pending' | 'drag-stream' | null = null;
  let startClient = { x: 0, y: 0 };
  let moveRaf = 0;

  function onPointerDown(e: PointerEvent, canvas: HTMLCanvasElement): void {
    if (!sessionId.value || e.button !== 0) return;
    if (inputSuspended) return; // inspect: clicks select on the surface, never dispatch
    pState = 'pending';
    startClient = { x: e.clientX, y: e.clientY };
    // capture: the drag continues even when the pointer leaves the canvas
    try { canvas.setPointerCapture(e.pointerId); } catch { /* older engines */ }
  }

  function onPointerMove(e: PointerEvent, canvas: HTMLCanvasElement): void {
    if (!pState) return;
    if (pState === 'pending') {
      if (Math.hypot(e.clientX - startClient.x, e.clientY - startClient.y) < DRAG_THRESHOLD_PX) return;
      // promote → drag: down at the drag START point, then stream moves
      const start = canvasPointToLogical(canvas, startClient.x, startClient.y);
      pState = 'drag-stream';
      onGesture?.('drag');
      void post('touch1', { kind: 'touch1', phase: 'down', x: start.x, y: start.y }).catch(() => undefined);
    }
    // rAF throttle: one in-flight move at a time, always the newest point
    lastPt = canvasPointToLogical(canvas, e.clientX, e.clientY);
    if (moveRaf) return;
    moveRaf = requestAnimationFrame(() => {
      moveRaf = 0;
      if (pState !== 'drag-stream') return;
      void post('touch1', { kind: 'touch1', phase: 'move', x: lastPt.x, y: lastPt.y }).catch(() => undefined);
    });
  }

  function onPointerUp(e: PointerEvent, canvas: HTMLCanvasElement): void {
    if (!pState) return;
    if (moveRaf) { cancelAnimationFrame(moveRaf); moveRaf = 0; }
    if (pState === 'pending') {
      // never promoted → one atomic tap (engine: down → hold → up)
      const p = canvasPointToLogical(canvas, e.clientX, e.clientY);
      onGesture?.('tap');
      void post('tap', { kind: 'tap', x: p.x, y: p.y }).catch(() => undefined);
    } else {
      const p = canvasPointToLogical(canvas, e.clientX, e.clientY);
      void post('touch1', { kind: 'touch1', phase: 'up', x: p.x, y: p.y }).catch(() => undefined);
    }
    pState = null;
  }

  // ── wheel: baguette's WheelGestureSource recipe 1:1 ──
  const BASE_SPREAD_PT = 80;   // sim-pt for the synthesized finger pair
  const WHEEL_IDLE_MS = 120;   // wheel idle → close 2-finger
  interface WheelState {
    kind: 'pinch' | 'pan';
    f1: { x: number; y: number };
    f2: { x: number; y: number };
    scale: number;
    idleTimer: ReturnType<typeof setTimeout> | null;
  }
  let wheelState: WheelState | null = null;

  function wheelClose(): void {
    if (!wheelState) return;
    void post('touch2', { kind: 'touch2', phase: 'up', x1: wheelState.f1.x, y1: wheelState.f1.y, x2: wheelState.f2.x, y2: wheelState.f2.y }).catch(() => undefined);
    wheelState = null;
  }

  function onWheel(e: WheelEvent, canvas: HTMLCanvasElement): void {
    if (!sessionId.value) return;
    e.preventDefault(); // navigation scrolls the device even while inspecting
    const w = logical.value.w ?? canvas.width;
    const h = logical.value.h ?? canvas.height;
    if (!w || !h) return;
    const r = canvas.getBoundingClientRect();
    const vx = e.clientX - r.left, vy = e.clientY - r.top;
    const centre = { x: (vx / r.width) * w, y: (vy / r.height) * h };
    const wantKind = e.ctrlKey ? 'pinch' : 'pan';

    if (!wheelState || wheelState.kind !== wantKind) {
      if (wheelState) wheelClose();
      wheelState = {
        kind: wantKind,
        f1: { x: centre.x + BASE_SPREAD_PT, y: centre.y },
        f2: { x: centre.x - BASE_SPREAD_PT, y: centre.y },
        scale: 1, idleTimer: null,
      };
      void post('touch2', { kind: 'touch2', phase: 'down', x1: wheelState.f1.x, y1: wheelState.f1.y, x2: wheelState.f2.x, y2: wheelState.f2.y }).catch(() => undefined);
    }

    if (wheelState.kind === 'pinch') {
      wheelState.scale = Math.max(0.25, Math.min(6, wheelState.scale * Math.exp(-e.deltaY / 200)));
      const rr = BASE_SPREAD_PT * wheelState.scale;
      wheelState.f1 = { x: centre.x + rr, y: centre.y };
      wheelState.f2 = { x: centre.x - rr, y: centre.y };
      onGesture?.('pinch'); // zoom reflows content — tree must not survive it
    } else {
      const shiftX = (-e.deltaX / r.width) * w;
      const shiftY = (-e.deltaY / r.height) * h;
      wheelState.f1.x += shiftX; wheelState.f1.y += shiftY;
      wheelState.f2.x += shiftX; wheelState.f2.y += shiftY;
      onGesture?.('scroll');
    }

    void post('touch2', { kind: 'touch2', phase: 'move', x1: wheelState.f1.x, y1: wheelState.f1.y, x2: wheelState.f2.x, y2: wheelState.f2.y }).catch(() => undefined);

    if (wheelState.idleTimer) clearTimeout(wheelState.idleTimer);
    wheelState.idleTimer = setTimeout(wheelClose, WHEEL_IDLE_MS);
  }

  // ── keyboard: focus-gated capture on the canvas ──
  // REALTIME: one keystroke = one `key` dispatch, no buffering. A batched
  // `type` makes the engine usleep-hold every character on its main queue,
  // freezing the stream until the whole batch lands (the 10s-delay bug).
  // Per-key dispatch matches a physical keyboard: ~40ms of wire time each,
  // interleaved with frame delivery.
  const namedKeys = new Set(['Enter', 'Escape', 'Backspace', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);

  function onKeyDown(e: KeyboardEvent): void {
    if (!sessionId.value) return;
    if (e.key === 'Escape') { (e.target as HTMLElement)?.blur(); return; }
    if (e.metaKey || e.ctrlKey) return;   // app shortcuts stay app shortcuts
    if (e.repeat && e.key.length !== 1 && !namedKeys.has(e.code)) return;

    const modifiers: string[] = [];
    if (e.shiftKey) modifiers.push('shift');
    if (e.altKey) modifiers.push('option');

    if (namedKeys.has(e.code)) {
      onGesture?.('key');
      void post('key', { kind: 'key', code: e.code, modifiers, duration: 0.04 }).catch(() => undefined);
      e.preventDefault();
      return;
    }
    if (e.key.length === 1 && e.code) {
      // printable: dispatch the PHYSICAL key + modifiers (US layout —
      // shift+Digit1 types '!'). matches how a real keyboard feeds iOS.
      onGesture?.('key');
      void post('key', { kind: 'key', code: e.code, modifiers, duration: 0.04 }).catch(() => undefined);
      e.preventDefault();
    }
  }

  function onBlur(): void { /* per-key flow has no buffer to flush */ }

  return {
    failed,
    setSuspended,
    onPointerDown, onPointerMove, onPointerUp,
    onWheel, onKeyDown, onBlur,
  };
}
