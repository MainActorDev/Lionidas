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
    lastPt = canvasPointToLogical(canvas, e.clientX, e.clientY);
    void post('touch1', { kind: 'touch1', phase: 'down', x: lastPt.x, y: lastPt.y }).catch(() => undefined);
  }

  function onPointerMove(e: PointerEvent, canvas: HTMLCanvasElement): void {
    if (!active) return;
    const p = canvasPointToLogical(canvas, e.clientX, e.clientY);
    if (!moved && Math.hypot(p.x - lastPt.x, p.y - lastPt.y) > 6) moved = true;
    if (!moved) return;
    // rAF throttle: one in-flight move at a time
    if (moveRaf) return;
    moveRaf = requestAnimationFrame(() => {
      moveRaf = 0;
      if (!active) return;
      void post('touch1', { kind: 'touch1', phase: 'move', x: lastPt.x, y: lastPt.y }).catch(() => undefined);
    });
    lastPt = p;
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

  function onWheel(e: WheelEvent): void {
    if (!sessionId.value) return;
    e.preventDefault();
    // browser deltas are inverted vs. iOS content scroll
    void post('scroll-delta', { deltaX: -e.deltaX, deltaY: -e.deltaY }).catch(() => undefined);
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
