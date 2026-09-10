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
) {
  const failed = ref('');

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
    const r = await api(`${sessionId.value}/${path}`, body);
    if (r['error']) failed.value = String(r['error']);
  }

  // ── pointer state machine: swipe emerges from raw touch1 ──
  let active = false;
  let moved = false;
  let downAt = 0;
  let lastPt = { x: 0, y: 0 };
  let moveRaf = 0;

  function onPointerDown(e: PointerEvent, canvas: HTMLCanvasElement): void {
    if (!sessionId.value || e.button !== 0) return;
    active = true; moved = false; downAt = Date.now();
    // capture: the drag continues even when the pointer leaves the canvas —
    // without it, moving past the rail silently ends the move stream (the
    // "fragile swipe" bug)
    try { canvas.setPointerCapture(e.pointerId); } catch { /* older engines */ }
    lastPt = canvasPointToLogical(canvas, e.clientX, e.clientY);
    void post('touch1', { kind: 'touch1', phase: 'down', x: lastPt.x, y: lastPt.y }).catch(() => undefined);
  }

  function onPointerMove(e: PointerEvent, canvas: HTMLCanvasElement): void {
    if (!active) return;
    const p = canvasPointToLogical(canvas, e.clientX, e.clientY);
    if (!moved && Math.hypot(p.x - lastPt.x, p.y - lastPt.y) > 6) moved = true;
    if (!moved) return;
    lastPt = p;   // update FIRST so the throttled send always carries the
                  // newest point (stale-point sends made drags laggy/jumpy)
    // rAF throttle: one in-flight move at a time
    if (moveRaf) return;
    moveRaf = requestAnimationFrame(() => {
      moveRaf = 0;
      if (!active) return;
      void post('touch1', { kind: 'touch1', phase: 'move', x: lastPt.x, y: lastPt.y }).catch(() => undefined);
    });
  }

  function onPointerUp(e: PointerEvent, canvas: HTMLCanvasElement): void {
    if (!active) return;
    active = false;
    if (moveRaf) { cancelAnimationFrame(moveRaf); moveRaf = 0; }
    const p = canvasPointToLogical(canvas, e.clientX, e.clientY);
    const dt = Date.now() - downAt;
    if (!moved && dt < 300) {
      // quick still press = tap (engine handles down/hold/up atomically)
      void post('tap', { x: p.x, y: p.y }).catch(() => undefined);
    } else {
      void post('touch1', { kind: 'touch1', phase: 'up', x: p.x, y: p.y }).catch(() => undefined);
    }
  }

  // ── wheel: baguette's WheelGestureSource recipe 1:1 ──
  // NO scroll-HID messages: raw wheel deltas through
  // IndigoHIDMessageForScrollEvent are the backboardd-crash class (found
  // live: the sim rebooted on wheel use). Instead the wheel synthesizes a
  // 2-finger touch pan (plain) or pinch (ctrl), auto-closing after a short
  // idle window because wheel events have no natural "finger up".
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
    e.preventDefault();
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
    } else {
      const shiftX = (-e.deltaX / r.width) * w;
      const shiftY = (-e.deltaY / r.height) * h;
      wheelState.f1.x += shiftX; wheelState.f1.y += shiftY;
      wheelState.f2.x += shiftX; wheelState.f2.y += shiftY;
    }

    void post('touch2', { kind: 'touch2', phase: 'move', x1: wheelState.f1.x, y1: wheelState.f1.y, x2: wheelState.f2.x, y2: wheelState.f2.y }).catch(() => undefined);

    if (wheelState.idleTimer) clearTimeout(wheelState.idleTimer);
    wheelState.idleTimer = setTimeout(wheelClose, WHEEL_IDLE_MS);
  }

  // ── keyboard: focus-gated capture on the canvas ──
  const namedKeys = new Set(['Enter', 'Escape', 'Backspace', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);
  let typeBuffer = '';
  let typeTimer: ReturnType<typeof setTimeout> | null = null;

  function flushType(): void {
    if (typeTimer) { clearTimeout(typeTimer); typeTimer = null; }
    if (!typeBuffer) return;
    const text = typeBuffer;
    typeBuffer = '';
    void post('type', { kind: 'type', text }).catch(() => undefined);
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (!sessionId.value) return;
    if (e.key === 'Escape') { (e.target as HTMLElement)?.blur(); return; }
    if (e.metaKey || e.ctrlKey) return;   // app shortcuts stay app shortcuts
    if (namedKeys.has(e.code)) {
      flushType();
      const modifiers: string[] = [];
      if (e.shiftKey) modifiers.push('shift');
      if (e.altKey) modifiers.push('option');
      void post('key', { kind: 'key', code: e.code, modifiers }).catch(() => undefined);
      e.preventDefault();
      return;
    }
    if (e.key.length === 1) {
      typeBuffer += e.key;
      if (typeTimer) clearTimeout(typeTimer);
      typeTimer = setTimeout(flushType, 250);
      e.preventDefault();
    }
  }

  function onBlur(): void { flushType(); }

  return {
    failed,
    onPointerDown, onPointerMove, onPointerUp,
    onWheel, onKeyDown, onBlur, flushType,
  };
}
