/** Live device stream composable — the ONE canvas-MJPEG renderer for the app.
 *
 *  Owns: WS connection to /api/stream/:udid, binary frame decode (createImageBitmap
 *  off-main-thread), canvas draw, fps meter, first-frame + error signaling, and
 *  graceful degradation. Pages mount the returned canvas element and read state.
 */
import { ref, type Ref } from 'vue';
import { makeAvccDecoder, makeMjpegDecoder, hasAvccSupport, type Codec } from './stream/codecs.ts';

export type StreamState = 'idle' | 'connecting' | 'live' | 'paused' | 'reconnecting' | 'failed';

export interface DeviceStream {
  canvasRef: Ref<HTMLCanvasElement | null>;
  /** template binding — use as :ref="stream.setCanvas" (survives v-for arrays) */
  setCanvas(el: unknown): void;
  state: Ref<StreamState>;
  fps: Ref<number>;
  frames: Ref<number>;
  /** human-readable failure reason when state === 'failed' */
  failure: Ref<string>;
  /** server said a retry is likely to recover (stale-engine class) — show a retry button */
  retryable: Ref<boolean>;
  start(udid: string, opts?: { format?: 'avcc' | 'mjpeg' }): void;
  stop(): void;
  /** re-connect after a failure (manual retry from the failed overlay) */
  retry(): void;
  /** post-action screenshot fast-path — draws one still onto the live canvas
   *  without resizing it and without racing the decode loop (no-ops when the
   *  stream is actively painting — see paintStillImage). */
  paintStillImage(source: ImageBitmap | HTMLImageElement): void;
  /** Stream-frame observer (inspect-mode settle detection): called with the
   *  paint timestamp for every decoded frame. Returns an unsubscribe. Callbacks
   *  must be cheap (they run inside the decode loop); do the work outside. */
  onFrame(cb: (paintedAt: number) => void): () => void;
}

export function useDeviceStream(): DeviceStream {
  const canvasRef = ref<HTMLCanvasElement | null>(null);
  const state = ref<StreamState>('idle');
  const fps = ref(0);
  const failure = ref('');
  const retryable = ref(false);
  const frames = ref(0); // total received — distinguishes "connected, idle screen" from "nothing ever"

  // Vue assigns template refs inside v-for as ARRAYS — normalize to one element.
  function setCanvas(el: unknown): void {
    if (el === null || el === undefined) { canvasRef.value = null; return; }
    if (Array.isArray(el)) { canvasRef.value = (el[0] as HTMLCanvasElement | undefined) ?? null; return; }
    canvasRef.value = el as HTMLCanvasElement;
  }

  let ws: WebSocket | null = null;
  let codec: Codec | null = null;
  let lastFrameAt = 0;
  let livenessTimer: ReturnType<typeof setInterval> | null = null;
  let directRaf: (() => void) | null = null;
  let currentUdid = '';
  /** requested upstream format (avcc opt-in / mjpeg fallback); null = server default */
  let pendingFormat: 'avcc' | 'mjpeg' | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let autoRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let autoRetried = false; // ONE automatic attempt per failure chain — no spin
  let frameCount = 0;
  let lastFpsTime = Date.now();
  const frameObservers = new Set<(paintedAt: number) => void>();
  let generation = 0; // invalidate stale async work after stop()/restart()

  // Single-flight decode with a one-slot pending buffer — the browser-side
  // twin of the relay's LATEST-WINS queue. Properties:
  //  - frames paint strictly in arrival order (a decode completing late can
  //    never paint over a newer frame → no backwards jumps = no flicker);
  //  - if frames arrive faster than createImageBitmap completes, the stale
  //    ones are OVERWRITTEN in the slot, not queued (no snowball, displayed
  //    fps caps at decode speed);
  //  - starving never happens: every completed decode paints (the previous
  //    drop-on-newer-arrival approach froze the canvas under motion).
  let pendingBuf: ArrayBuffer | null = null;
  /** latest delivered source from the AVCC codec (playing <video> or seed bitmap) */
  let delivered: { value: ImageBitmap | VideoFrame | null } = { value: null };
  let decoding = false;
  let lastPaintAt = 0; // stream-frame paint time — gates the standalone fast-path
  // Reusable offscreen for stepped downscaling (mip-style halving) — created
  // lazily, sized to the largest halving step, reused across frames.
  // ping-pong scratch buffers for drawScaled (see its comment)

  /** High-quality downscale draw: halve repeatedly (≤2x per step) into the
   *  offscreen, then one final scale onto the display canvas. A single-step
   *  1284→~300 drawImage skips pixels → thin text ghosts/doubles; stepped
   *  halving is the standard canvas remedy (software mip-chain). */
  function drawScaled(ctx: CanvasRenderingContext2D, src: CanvasImageSource, srcW: number, srcH: number, dstW: number, dstH: number): void {
    let w = srcW;
    let h = srcH;
    let source: CanvasImageSource = src;
    // ping-pong: resizing a canvas CLEARS it — a single scratch buffer ends
    // up drawing itself onto itself post-clear and paints pure transparency
    // once the halving chain needs 2+ steps (narrow canvases) — found live
    // when the run panel's 101px stream drew 79 blank frames at 25fps
    let ping = false;
    let a: HTMLCanvasElement | null = null;
    let b: HTMLCanvasElement | null = null;
    while (w > dstW * 2 && h > 2) {
      const dst = ping ? b ?? (b = document.createElement('canvas')) : a ?? (a = document.createElement('canvas'));
      ping = !ping;
      const nw = Math.max(dstW, Math.floor(w / 2));
      const nh = Math.max(1, Math.floor(h / 2));
      if (dst.width !== nw || dst.height !== nh) { dst.width = nw; dst.height = nh; }
      const hctx = dst.getContext('2d');
      if (!hctx) break;
      hctx.imageSmoothingEnabled = true;
      hctx.imageSmoothingQuality = 'high';
      hctx.clearRect(0, 0, nw, nh);
      hctx.drawImage(source, 0, 0, nw, nh);
      source = dst;
      w = nw;
      h = nh;
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, dstW, dstH);
  }

  /** Draw a standalone image (post-action screenshot fast-path) WITHOUT
   *  resizing the canvas and WITHOUT racing the live decode loop:
   *  - scaled onto the current canvas dims (assigning width clears → flash);
   *  - skipped entirely when a stream frame painted within the last 150ms —
   *    during animation the stream is fresher than the snapshot, and an
   *    older-over-newer paint reads as the stream jumping backwards. The
   *    fast-path exists for QUIET screens (~0.5fps), which is exactly when
   *    it runs. */
  function paintStillImage(source: ImageBitmap | HTMLImageElement): void {
    const canvas = canvasRef.value;
    if (!canvas || !canvas.width || !canvas.height) return;
    if (Date.now() - lastPaintAt < 150) return; // stream is flowing — stand down
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  }

  /** rAF-paced painter: one pending bitmap max; a newer frame replaces an
   *  unpainted older one (closed immediately). steady presentation cadence.
   *  rAF is PAUSED in hidden tabs — the pending job (and the last painted
   *  bitmap, kept unclosed) survives until visibility returns, so a
   *  backgrounded stream resumes showing the freshest frame instantly. */
  type PaintSource = ImageBitmap | VideoFrame;
  type PaintJob = { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; bitmap: PaintSource; w: number; h: number };
  const srcW = (b: PaintSource): number => (b as VideoFrame).displayWidth || (b as ImageBitmap).width;
  const srcH = (b: PaintSource): number => (b as VideoFrame).displayHeight || (b as ImageBitmap).height;
  const closeSrc = (b: PaintSource | null | undefined): void => { try { (b as VideoFrame | ImageBitmap | undefined)?.close?.(); } catch { /* ok */ } };
  let pendingPaint: PaintJob | null = null;
  let lastFrame: PaintJob | null = null;
  let rafScheduled = false;
  function runPaintJob(job: NonNullable<typeof pendingPaint>): void {
    if (job.canvas.width !== job.w || job.canvas.height !== job.h) { job.canvas.width = job.w; job.canvas.height = job.h; }
    drawScaled(job.ctx, job.bitmap, srcW(job.bitmap), srcH(job.bitmap), job.w, job.h);
    lastFrame = job; // kept for hidden-tab resume (source stays open)
    lastPaintAt = Date.now();
    if (frameObservers.size > 0) for (const cb of frameObservers) cb(lastPaintAt);
  }
  function schedulePaint(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, bitmap: PaintSource, w: number, h: number): void {
    if (pendingPaint) closeSrc(pendingPaint.bitmap); // superseded before display
    pendingPaint = { canvas, ctx, bitmap, w, h };
    if (rafScheduled) return;
    rafScheduled = true;
    requestAnimationFrame(() => {
      rafScheduled = false;
      const job = pendingPaint;
      pendingPaint = null;
      if (!job) return;
      const prev = lastFrame;
      runPaintJob(job);
      if (prev && prev !== job) closeSrc(prev.bitmap); // retire the previous source
    });
  }
  document.addEventListener('visibilitychange', () => {
    // tab visible again: rAF fires once more and paints the freshest frame
    if (document.visibilityState === 'visible' && pendingPaint && !rafScheduled) {
      rafScheduled = true;
      requestAnimationFrame(() => {
        rafScheduled = false;
        const job = pendingPaint;
        pendingPaint = null;
        if (!job) return;
        const prev = lastFrame;
        runPaintJob(job);
        if (prev && prev !== job) closeSrc(prev.bitmap);
      });
    }
  });

  /** AVCC delivery: hand the video element (current frame) to the SAME rAF
   *  painter; the JPEG seed bitmap rides the identical path. */
  async function paintDelivered(): Promise<void> {
    const src = delivered.value;
    if (!src) return;
    const canvas = canvasRef.value;
    if (!canvas) return;
    // display-resolution backing (same policy as the mjpeg path): the source is
    // full-res; painting 1:1 into a 1284px backing on a ~230px CSS box makes the
    // compositor downscale — do it here at high quality instead
    const cssW = canvas.clientWidth || canvas.getBoundingClientRect().width;
    if (cssW <= 0) return;
    const w = srcW(src), h = srcH(src);
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    const targetW = Math.max(1, Math.round(cssW * dpr));
    const targetH = Math.max(1, Math.round(targetW * h / w));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    schedulePaint(canvas, ctx, src, targetW, targetH);
  }

  async function decodeLoop(): Promise<void> {
    if (decoding) return;
    decoding = true;
    try {
      while (pendingBuf !== null) {
        const buf = pendingBuf;
        pendingBuf = null; // newer frames land here while this one decodes
        let bitmap: ImageBitmap;
        const canvas = canvasRef.value;
        try {
          // decode DIRECTLY at display resolution when known: source frames are
          // full-res (~1.3MB, 1284px) and a full decode costs 30-40ms; the
          // resize-aware path decodes+downscales in one optimized GPU-friendly
          // pass (~5ms), keeping the paint loop from falling behind on bursts.
          const cssW0 = canvas?.clientWidth || canvas?.getBoundingClientRect().width || 0;
          const dpr0 = window.devicePixelRatio || 1;
          if (cssW0 > 0) {
            const tw = Math.max(1, Math.round(cssW0 * dpr0));
            // resizeWidth alone preserves the source aspect ratio per spec
            bitmap = await createImageBitmap(new Blob([buf], { type: 'image/jpeg' }),
              { resizeWidth: tw, resizeQuality: 'high' });
          } else {
            bitmap = await createImageBitmap(new Blob([buf], { type: 'image/jpeg' }));
          }
        } catch { continue; /* corrupt frame — skip, keep the loop alive */ }
        if (canvas) {
          // RENDER AT DISPLAY RESOLUTION. The engine frame is 1284px wide; a
          // 1284px backing store shown at ~300 CSS px (sidebar) makes the
          // COMPOSITOR downscale ~4x with bilinear sampling and no mipmaps —
          // thin animated text (typewriter placeholders) lands between sample
          // points and shimmers. Doing the downscale HERE via drawImage uses
          // the 2D context's high-quality resampler; the compositor then
          // blits ~1:1. Tap mapping is unaffected — it scales through
          // canvas.width, whatever the backing size is.
          const cssW = canvas.clientWidth || canvas.getBoundingClientRect().width;
          if (cssW > 0) {
            const dpr = window.devicePixelRatio || 1;
            const targetW = Math.max(1, Math.round(cssW * dpr));
            const targetH = Math.max(1, Math.round(targetW * bitmap.height / bitmap.width));
            // (resize happens inside the rAF paint job — an eager resize here
            //  clears the canvas and opens a black-frame window mid-burst)
            const ctx = canvas.getContext('2d');
            if (ctx) {
              // rAF-paced paint (latest-wins): decode immediately, but draw on
              // the display's cadence. The source emits ~8fps in bursts with
              // 30-110ms gaps — painting on arrival makes the canvas strobe;
              // pacing to rAF coalesces bursts and fills gaps with steady
              // presentation. Latest bitmap wins; older ones close at paint time.
              schedulePaint(canvas, ctx, bitmap, targetW, targetH);
            }
          }
        }
        countFps();
      }
    } finally {
      decoding = false;
    }
  }

  /** fps accounting shared by the mjpeg decode loop and the AVCC codec path */
  function countFps(): void {
    frameCount++;
    const now = Date.now();
    if (now - lastFpsTime >= 1000) {
      fps.value = Math.round((frameCount * 1000) / (now - lastFpsTime));
      frameCount = 0;
      lastFpsTime = now;
    }
  }

/** baguette's session shape, 1:1 (stream-session.js): decoder fed by the WS,
 *  one pending frame max, rAF paints it at FRAME-NATIVE canvas dims and closes
 *  it. No relay frames, no resampling, no dpr math — their pipeline as-is. */
  function attachDirect(socket: WebSocket, udid: string, gen: number): void {
    ws = socket;
    ws.binaryType = 'arraybuffer';
    let pending: ImageBitmap | VideoFrame | null = null;
    let rafId = 0;
    let alive = true;
    codec = makeAvccDecoder(
      (frame) => {
        if (pending && typeof (pending as VideoFrame).close === 'function') {
          try { (pending as VideoFrame).close(); } catch { /* ok */ }
        }
        pending = frame;
      },
      (msg, isErr) => { if (isErr) failure.value = msg; },
    );
    ws.onopen = () => {
      state.value = 'live';
      // QA-grade sharpness: the 8Mbps default starves 1284×2778@60 UI text
      // into mush. 20Mbps is nothing on loopback; text edges survive encode.
      try { socket.send(JSON.stringify({ type: 'set_bitrate', bps: 20_000_000 })); } catch { /* socket gone */ }
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (gen !== generation) return;
      if (typeof ev.data === 'string') {
        try {
          const body = JSON.parse(ev.data) as { ok?: boolean; error?: string };
          if (body.ok === false && body.error) fail(`baguette: ${body.error}`, false);
        } catch { /* not JSON */ }
        return;
      }
      state.value = 'live';
      failure.value = '';
      frames.value++;
      countFps();
      codec?.feed(ev.data as ArrayBuffer);
    };
    ws.onclose = () => {
      if (gen !== generation) return;
      alive = false;
      if (rafId) cancelAnimationFrame(rafId);
      state.value = 'reconnecting';
      retryTimer = setTimeout(() => {
        if (gen === generation && currentUdid) connect(currentUdid, true);
      }, 1500);
    };
    ws.onerror = () => { /* onclose fires */ };
    const paint = (): void => {
      if (!alive || gen !== generation) return;
      const canvas = canvasRef.value;
      if (pending && canvas) {
        const f = pending;
        pending = null;
        const w = (f as VideoFrame).displayWidth || (f as ImageBitmap).width;
        const h = (f as VideoFrame).displayHeight || (f as ImageBitmap).height;
        if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(f, 0, 0);
          lastPaintAt = Date.now();
          if (frameObservers.size > 0) for (const cb of frameObservers) cb(lastPaintAt);
        }
        if (typeof (f as VideoFrame).close === 'function') { try { (f as VideoFrame).close(); } catch { /* ok */ } }
      }
      rafId = requestAnimationFrame(paint);
    };
    rafId = requestAnimationFrame(paint);
    // route stop() through the same cleanup: track the raf loop for teardown
    directRaf = () => { alive = false; if (rafId) cancelAnimationFrame(rafId); };
  }

  async function connect(udid: string, isRetry: boolean): Promise<void> {
    const gen = generation;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    state.value = isRetry ? 'reconnecting' : 'connecting';
    // avcc: browser talks DIRECTLY to baguette (their UI's shape — the relay
    // hop exists for the mjpeg engine path). Resolve the URL via our API
    // (auth + spawn supervision), then connect straight to it.
    if (pendingFormat === 'avcc') {
      try {
        const r = await fetch(`/api/devices/${udid}/stream?format=avcc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        const b = await r.json() as { streamUrl?: string; error?: string };
        if (!r.ok || !b.streamUrl) throw new Error(b.error ?? `resolve ${r.status}`);
        // same-origin via the vite proxy (/baguette → 127.0.0.1:8430): the
        // browser tags the WS sec-fetch-site: same-origin, which baguette's
        // trust check accepts — cross-origin direct connects are refused by
        // design (their sec-fetch guard) and can't be flag-bypassed
        const bag = `/baguette${new URL(b.streamUrl).pathname}${new URL(b.streamUrl).search}`;
        state.value = isRetry ? 'reconnecting' : 'connecting';
        attachDirect(new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${bag}`), udid, gen);
        return;
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err), true);
        return;
      }
    }
    ws = new WebSocket(`${proto}://${location.host}/api/stream/${udid}`);
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (ev) => {
      if (gen !== generation) return;
      if (typeof ev.data === 'string') {
        // typed messages from the relay — format handshake, error (terminal),
        // or status (mid-stream source loss, server keeps retrying underneath)
        try {
          const body = JSON.parse(ev.data) as { error?: string; retryable?: boolean; status?: string; paused?: boolean; format?: string };
          if (body.error) fail(body.error, body.retryable ?? false);
          else if (body.status === 'source-lost') state.value = 'reconnecting';
          else if (body.status === 'run-active' && body.paused) state.value = 'paused';
          else if (body.format === 'avcc' && !codec && hasAvccSupport()) {
            codec = makeAvccDecoder(
              (frame) => {
                frames.value++; countFps();
                delivered.value = frame;
                void paintDelivered();
              },
              (msg, isErr) => { if (isErr) failure.value = msg; },
            );
          } else if (body.format === 'avcc' && !codec && !hasAvccSupport()) {
            // WebCodecs absent: surface honestly and drop to the failure overlay —
            // the wall's pulse fast-path still carries a static frame
            fail('this browser cannot decode H.264 streams (no WebCodecs) — ask the server for mjpeg', false);
          }
        } catch { /* not JSON — ignore */ }
        return;
      }
      state.value = 'live';
      failure.value = '';
      retryable.value = false;
      autoRetried = false; // healthy again — a future outage gets its own auto-retry
      frames.value++;
      lastFrameAt = Date.now();
      if (codec) { codec.feed(ev.data as ArrayBuffer); return; }
      pendingBuf = ev.data as ArrayBuffer;
      void decodeLoop();
    };
    // zombie watchdog: emit-on-change streams send NOTHING while idle, so
    // 'no frames' alone is not death — but the meta line stays honest only if
    // we distinguish. A relay/upstream that dies WITHOUT closing our socket
    // (wedged server instance) leaves 'live' lying forever. Force one reconnect
    // if NO message of any kind arrives for 30s AND we've seen frames before
    // (first-frame timeout is the server's job; this is the after-first gap).
    if (livenessTimer) clearInterval(livenessTimer);
    livenessTimer = setInterval(() => {
      if (gen !== generation || state.value !== 'live') return;
      if (frames.value === 0) return; // pre-first-frame: server's timeout owns it
      if (Date.now() - lastFrameAt > 30_000) {
        state.value = 'reconnecting';
        teardown();
        void connect(currentUdid, true);
      }
    }, 5_000);
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

  function fail(reason: string, canRetry: boolean): void {
    // retryable stream loss (source respawn, run pause windows) self-heals —
    // one auto-retry before showing the fail overlay. The timer re-checks
    // BOTH the udid and that no newer connection took over (generation).
    if (canRetry && !autoRetried) {
      autoRetried = true;
      const failGen = generation;
      state.value = 'reconnecting';
      retryTimer = setTimeout(() => {
        if (currentUdid && failGen === generation) connect(currentUdid, true);
      }, 1500);
      return;
    }
    state.value = 'failed';
    failure.value = reason;
    retryable.value = canRetry;
    teardown();
    // server-flagged retryable (stale-engine class): the resolve route's
    // self-heal respawns the engine chain, so ONE automatic attempt recovers
    // almost always. Bounded — if it fails again, the button is the path.
    if (canRetry && !autoRetried) {
      autoRetried = true;
      const udid = currentUdid;
      autoRetryTimer = setTimeout(() => {
        autoRetryTimer = null;
        if (state.value === 'failed' && udid && udid === currentUdid) retry();
      }, 2500);
    }
  }

  /** manual retry from the failed overlay — re-resolves the stream (the
   * server's self-heal respawns the engine chain on the POST) */
  function retry(): void {
    if (!currentUdid || state.value !== 'failed') return;
    const udid = currentUdid;
    failure.value = '';
    retryable.value = false;
    connect(udid, false);
  }

  function teardown(): void {
    generation++;
    if (codec) { codec.dispose(); codec = null; }
    delivered.value = null; // bitmaps were owned by paint jobs; the video element belongs to the codec
    if (ws) { ws.onclose = null; ws.onmessage = null; ws.close(); ws = null; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (livenessTimer) { clearInterval(livenessTimer); livenessTimer = null; }
    if (directRaf) { directRaf(); directRaf = null; }
    if (autoRetryTimer) { clearTimeout(autoRetryTimer); autoRetryTimer = null; }
  }

  return {
    canvasRef,
    setCanvas,
    state,
    fps,
    frames,
    failure,
    retryable,
    start(udid: string, opts?: { format?: 'avcc' | 'mjpeg' }): void {
      if (currentUdid === udid && (state.value === 'live' || state.value === 'connecting' || state.value === 'reconnecting')) return;
      teardown();
      currentUdid = udid;
      pendingFormat = opts?.format ?? null;
      failure.value = '';
      retryable.value = false;
      void connect(udid, false);
    },
    stop(): void {
      currentUdid = '';
      state.value = 'idle';
      failure.value = '';
      retryable.value = false;
      teardown();
    },
    retry,
    paintStillImage,
    onFrame(cb: (paintedAt: number) => void): () => void {
      frameObservers.add(cb);
      return () => { frameObservers.delete(cb); };
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
