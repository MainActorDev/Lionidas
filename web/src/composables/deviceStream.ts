/** Live device stream composable — the ONE canvas-MJPEG renderer for the app.
 *
 *  Owns: WS connection to /api/stream/:udid, binary frame decode (createImageBitmap
 *  off-main-thread), canvas draw, fps meter, first-frame + error signaling, and
 *  graceful degradation. Pages mount the returned canvas element and read state.
 */
import { ref, type Ref } from 'vue';

export type StreamState = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'failed';

export interface DeviceStream {
  canvasRef: Ref<HTMLCanvasElement | null>;
  /** template binding — use as :ref="stream.setCanvas" (survives v-for arrays) */
  setCanvas(el: unknown): void;
  state: Ref<StreamState>;
  fps: Ref<number>;
  frames: Ref<number>;
  /** human-readable failure reason when state === 'failed' */
  failure: Ref<string>;
  start(udid: string): void;
  stop(): void;
}

export function useDeviceStream(): DeviceStream {
  const canvasRef = ref<HTMLCanvasElement | null>(null);
  const state = ref<StreamState>('idle');
  const fps = ref(0);
  const failure = ref('');
  const frames = ref(0); // total received — distinguishes "connected, idle screen" from "nothing ever"

  // Vue assigns template refs inside v-for as ARRAYS — normalize to one element.
  function setCanvas(el: unknown): void {
    if (el === null || el === undefined) { canvasRef.value = null; return; }
    if (Array.isArray(el)) { canvasRef.value = (el[0] as HTMLCanvasElement | undefined) ?? null; return; }
    canvasRef.value = el as HTMLCanvasElement;
  }

  let ws: WebSocket | null = null;
  let currentUdid = '';
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let frameCount = 0;
  let lastFpsTime = Date.now();
  let generation = 0; // invalidate stale async work after stop()/restart()

  function drawFrame(buf: ArrayBuffer): Promise<void> {
    return createImageBitmap(new Blob([buf], { type: 'image/jpeg' })).then((bitmap) => {
      const canvas = canvasRef.value;
      if (canvas) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          ctx.drawImage(bitmap, 0, 0);
        }
      }
      bitmap.close();
      frameCount++;
      const now = Date.now();
      if (now - lastFpsTime >= 1000) {
        fps.value = Math.round((frameCount * 1000) / (now - lastFpsTime));
        frameCount = 0;
        lastFpsTime = now;
      }
    });
  }

  function connect(udid: string, isRetry: boolean): void {
    const gen = generation;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    state.value = isRetry ? 'reconnecting' : 'connecting';
    ws = new WebSocket(`${proto}://${location.host}/api/stream/${udid}`);
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (ev) => {
      if (gen !== generation) return;
      if (typeof ev.data === 'string') {
        // typed error from the relay — surface it and stop retrying silently
        try {
          const body = JSON.parse(ev.data) as { error?: string };
          if (body.error) fail(body.error);
        } catch { /* not JSON — ignore */ }
        return;
      }
      state.value = 'live';
      failure.value = '';
      frames.value++;
      void drawFrame(ev.data as ArrayBuffer);
    };
    ws.onclose = () => {
      if (gen !== generation) return;
      // auto-reconnect while started (server restart, engine respawn)
      state.value = 'reconnecting';
      retryTimer = setTimeout(() => {
        if (gen === generation && currentUdid) connect(currentUdid, true);
      }, 1500);
    };
    ws.onerror = () => { /* onclose fires */ };
  }

  function fail(reason: string): void {
    state.value = 'failed';
    failure.value = reason;
    teardown();
  }

  function teardown(): void {
    generation++;
    if (ws) { ws.onclose = null; ws.onmessage = null; ws.close(); ws = null; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  }

  return {
    canvasRef,
    setCanvas,
    state,
    fps,
    frames,
    failure,
    start(udid: string): void {
      if (currentUdid === udid && (state.value === 'live' || state.value === 'connecting' || state.value === 'reconnecting')) return;
      teardown();
      currentUdid = udid;
      failure.value = '';
      connect(udid, false);
    },
    stop(): void {
      currentUdid = '';
      state.value = 'idle';
      failure.value = '';
      teardown();
    },
  };
}

/** Tap → device LOGICAL points. Canvas pixels are DEVICE pixels (e.g. 1284 wide
 *  for a 428pt screen); the engine expects logical coordinates, so scale through
 *  the session's logical dimensions. Falls back to raw canvas coords if unknown. */
export function canvasPointToLogical(canvas: HTMLCanvasElement, clientX: number, clientY: number, logicalW?: number | null, logicalH?: number | null): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const px = ((clientX - rect.left) / rect.width) * canvas.width;
  const py = ((clientY - rect.top) / rect.height) * canvas.height;
  if (!logicalW || !logicalH || !canvas.width || !canvas.height) return { x: Math.round(px), y: Math.round(py) };
  const sx = logicalW / canvas.width;
  const sy = logicalH / canvas.height;
  return { x: Math.round(px * sx), y: Math.round(py * sy) };
}
