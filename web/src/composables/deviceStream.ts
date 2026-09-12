/** Live device stream composable — the ONE canvas-MJPEG renderer for the app.
 *
 *  Owns: WS connection to /api/stream/:udid, binary frame decode (createImageBitmap
 *  off-main-thread), canvas draw, fps meter, first-frame + error signaling, and
 *  graceful degradation. Pages mount the returned canvas element and read state.
 */
import { ref, type Ref } from 'vue';
import { makeAvccDecoder, type Codec } from './stream/codecs.ts';

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
  // Unmount (null) is DEFERRED: during a v-if/v-else canvas branch swap the
  // incoming canvas's ref call can land BEFORE the outgoing branch's teardown
  // null, leaving canvasRef null forever — the paint loop then spins on a
  // detached/no canvas and the sidebar shows a frozen 300x150 default while
  // fps keeps counting (observed intermittently in Safari 26; Chrome's patch
  // order happened to tear down first). Cancelling the pending null on every
  // real bind makes the live canvas survive the race.
  let nullTimer: ReturnType<typeof setTimeout> | null = null;
  function setCanvas(el: unknown): void {
    if (el === null || el === undefined) {
      if (nullTimer) clearTimeout(nullTimer);
      nullTimer = setTimeout(() => { canvasRef.value = null; }, 50);
      return;
    }
    if (nullTimer) { clearTimeout(nullTimer); nullTimer = null; }
    if (Array.isArray(el)) { canvasRef.value = (el[0] as HTMLCanvasElement | undefined) ?? null; return; }
    canvasRef.value = el as HTMLCanvasElement;
  }

  let ws: WebSocket | null = null;
  let codec: Codec | null = null;
  let livenessTimer: ReturnType<typeof setInterval> | null = null;
  let directRaf: (() => void) | null = null;
  let currentUdid = '';
  // ── lossless still on quiet ─────────────────────────────────────────
  // Video can't beat information theory: a 5.4× downscale eats thin-glyph
  // detail, and H.264 adds 4:2:0 chroma loss on top. But a STATIC screen
  // can be served pixel-exact: when frames stop flowing (seed-gated quiet),
  // fetch a lossless PNG (simctl screenshot) and paint it over the video's
  // last frame. Motion instantly cancels and re-arms. Net effect: the
  // stream "develops" into simulator quality whenever it stops moving —
  // which is exactly when you're reading it.
  let stillTimer: ReturnType<typeof setTimeout> | null = null;
  let stillStale = false; // a video frame painted after the PNG → cancel
  let stillBusy = false; // capture in flight (don't stack requests)
  const armStill = (udid: string, gen: number): void => {
    if (stillTimer) clearTimeout(stillTimer);
    stillTimer = setTimeout(async () => {
      stillTimer = null;
      if (gen !== generation || stillBusy || stillStale) return;
      const canvas = canvasRef.value;
      if (!canvas || state.value !== 'live') return;
      stillBusy = true;
      try {
        // lossless still straight from the simdeck child (simctl-grade PNG,
        // no app session needed — the alloy watch-frame route requires one).
        // Uses the same /simdeck proxy prefix as the stream WS itself.
        const rd = await fetch(`/simdeck/simulators/${encodeURIComponent(udid)}/screenshot.png`, { credentials: 'include' });
        if (!rd.ok) return; // engine busy: keep the video frame, retry later
        const blob = await rd.blob();
        // gen check AFTER the await: a reconnect/restart may have happened
        if (gen !== generation || stillStale) return;
        const img = new Image();
        await new Promise<void>((res, rej) => {
          img.onload = () => res();
          img.onerror = () => rej(new Error('still decode failed'));
          img.src = URL.createObjectURL(blob);
        });
        if (gen !== generation || stillStale) return;
        const c = canvasRef.value;
        if (!c || state.value !== 'live') return;
        // paint through the SAME stepped-resample path as live frames —
        // native backing would hand the lossless PNG back to the GPU's
        // mipmap-less downscale and reintroduce the aliasing we're killing
        const r = c.getBoundingClientRect();
        const dpr = Math.max(1, window.devicePixelRatio || 1);
        const tw = r.width >= 2 ? Math.max(1, Math.round(r.width * dpr)) : img.naturalWidth;
        const th = r.height >= 2 ? Math.max(1, Math.round(r.height * dpr)) : img.naturalHeight;
        if (c.width !== tw || c.height !== th) { c.width = tw; c.height = th; }
        const ctx = c.getContext('2d');
        if (ctx) {
          if (tw < img.naturalWidth && th < img.naturalHeight) {
            drawScaled(ctx, img, img.naturalWidth, img.naturalHeight, tw, th);
          } else {
            ctx.drawImage(img, 0, 0);
          }
          lastPaintAt = Date.now(); // counts as a paint: keeps quiet detectable
          if (frameObservers.size > 0) for (const cb of frameObservers) cb(lastPaintAt);
        }
        URL.revokeObjectURL(img.src);
      } catch {
        // network/decode failure: video last frame stays — silent is fine
      } finally {
        stillBusy = false;
        // NO unconditional re-arm: every real pixel change ships a video
        // frame (seed-gated diff), and each WS frame re-arms the still.
        // Re-fetching a 3.5MB PNG every 400ms while idle would be pure
        // waste — the still is only stale when motion says so.
      }
    }, 400);
  };
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
  /** latest delivered source from the AVCC codec (playing <video> or seed bitmap) */
  let delivered: { value: ImageBitmap | VideoFrame | null } = { value: null };
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
    if (srcW(job.bitmap) === job.w && srcH(job.bitmap) === job.h) {
      // baguette 1:1: sizes already match — plain blit, no resample
      job.ctx.drawImage(job.bitmap, 0, 0);
    } else {
      drawScaled(job.ctx, job.bitmap, srcW(job.bitmap), srcH(job.bitmap), job.w, job.h);
    }
    lastFrame = job; // kept for hidden-tab resume (source stays open)
    lastPaintAt = Date.now();
    if (frameObservers.size > 0) for (const cb of frameObservers) cb(lastPaintAt);
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

  /** AVCC delivery: hand the frame to the SAME rAF painter; the JPEG seed
   *  bitmap rides the identical path.
   *  baguette 1:1: canvas backing = NATIVE FRAME SIZE, single drawImage blit,
   *  CSS/GPU compositor downscales to the display box. No per-frame software
   *  resample — that cost multiplied by 60fps was the motion stutter. */


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

/** Engine session shape (baguette lineage, stream-session.js): decoder fed by the WS,
 *  one pending frame max, rAF paints it at FRAME-NATIVE canvas dims and closes
 *  it. No relay frames, no resampling, no dpr math — their pipeline as-is. */
  function attachDirect(socket: WebSocket, udid: string, gen: number, opts?: { tolerantAcks?: boolean }): void {
    const tolerantAcks = opts?.tolerantAcks === true;
    ws = socket;
    ws.binaryType = 'arraybuffer';
    // input rides this socket too (fire-and-forget JSON frames; the engine
    // gates on the server-granted input right)
    let pending: ImageBitmap | VideoFrame | null = null;
    let rafId = 0;
    let alive = true;
    // ── quiet-path polish ──────────────────────────────────────────────
    // The native-res blit leaves downscaling to the GPU compositor, which
    // samples bilinearly WITHOUT mipmaps — at 4–5× reduction it skips
    // pixels and thin text aliases ("still looks pixelated" report). On a
    // QUIET screen (seed-gated: no frames flow when pixels don't change)
    // we re-render the last painted frame into a DISPLAY-SIZED backing
    // (CSS × DPR = one canvas px per physical px) via the stepped-halving
    // drawScaled — proper area averaging, so the compositor maps 1:1.
    // Motion NEVER pays this cost (the per-frame software resample was the
    // motion-stutter regression); the next real frame resizes the backing
    // back to native and blits as before.
    let polishSrc: ImageBitmap | VideoFrame | null = null; // last PAINTED source, kept open
    let polishTimer: ReturnType<typeof setInterval> | null = null;
    let lastRealPaint = 0;
    const polish = (): void => {
      if (!alive || gen !== generation) {
        if (polishTimer) { clearInterval(polishTimer); polishTimer = null; }
        closeSrc(polishSrc); polishSrc = null;
        return;
      }
      // quiet = no real paint for 300ms AND nothing waiting to paint —
      // during 60fps motion lastRealPaint is <17ms old, so this never fires
      if (pending || !polishSrc || Date.now() - lastRealPaint < 300) return;
      const canvas = canvasRef.value;
      if (!canvas) return;
      const r = canvas.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return; // hidden/unlaid-out
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const tw = Math.max(1, Math.round(r.width * dpr));
      const th = Math.max(1, Math.round(r.height * dpr));
      const sw = (polishSrc as VideoFrame).displayWidth || (polishSrc as ImageBitmap).width;
      const sh = (polishSrc as VideoFrame).displayHeight || (polishSrc as ImageBitmap).height;
      if (tw === canvas.width && th === canvas.height) return; // already polished
      if (tw >= sw || th >= sh) return; // display ≥ source — nothing to resample
      canvas.width = tw; canvas.height = th;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      drawScaled(ctx, polishSrc, sw, sh, tw, th);
      // deliberately NOT touching lastPaintAt / frameObservers: polish is a
      // repaint of identical content — observing it would break quiet
      // detection (inspect settle) and block the snapshot fast-path.
    };
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
      // 60fps @ 8Mbps — the fork's documented pairing for NATIVE-resolution
      // H.264 (StreamConfig.default). 2Mbps was baguette's "Balanced" preset
      // paired with scale=2 (half-res); at native 1206×2622 it visibly
      // macroblocks (user report 2026-09-12). The earlier "24Mbps stuttered"
      // observation was HW-decode saturation at 60fps — if motion ever
      // stutters again, tune fps down before bitrate. Idle screens encode
      // ~0 frames anyway (seed-gated), so stills ride full IDR quality.
      try {
        socket.send(JSON.stringify({ type: 'set_fps', fps: 60 }));
        socket.send(JSON.stringify({ type: 'set_bitrate', bps: 8_000_000 }));
      } catch { /* socket gone */ }
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (gen !== generation) return;
      if (typeof ev.data === 'string') {
        try {
          const body = JSON.parse(ev.data) as { type?: string; ok?: boolean; error?: string };
          // input_ack: per-gesture results. Refusals (ungranted input,
          // parse errors) surface on the input status line instead of
          // killing the stream view.
          if (body.type === 'input_ack') {
            if (body.ok === false && body.error) {
              lastInputError.value = body.error;
              // grant refusal = the driving session is gone server-side.
              // Loud, not silent: flag control-lost so the UI demotes itself.
              if (/not granted|no driving session/i.test(body.error)) controlLost.value = true;
            }
            return;
          }
          // sim died mid-stream (shutdown/crash): the engine already tore the
          // stream down; surface it honestly instead of a frozen "live" canvas.
          if (body.type === 'stream_died') {
            fail('device shut down or crashed — stream ended', false);
            return;
          }
          // tolerant (wrapped-surface socket): its control protocol acks
          // every JSON it parses — including our set_* tuning frames it treats
          // as gestures — with {ok:false}. Those are NOISE here, not stream
          // failures; only the engine's explicit error shape kills the view.
          if (body.ok === false && body.error && !tolerantAcks) fail(`stream: ${body.error}`, false);
        } catch { /* not JSON */ }
        return;
      }
      state.value = 'live';
      failure.value = '';
      frames.value++;
      countFps();
      // motion = a frame arrived: the PNG still is stale the moment pixels
      // move, so cancel any pending still capture — it would paint OLD
      // content over LIVE motion (user watching a scroll would see it snap
      // back). Re-armed after quiet by the still timer.
      if (stillTimer) { clearTimeout(stillTimer); stillTimer = null; }
      stillStale = false;
      codec?.feed(ev.data as ArrayBuffer);
      armStill(udid, gen);
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
        // Stepped-resample EVERY frame into a display-sized backing
        // (CSS × DPR). Kills the GPU's mipmap-less downscale aliasing
        // during motion — the last visible gap to "looks like the
        // simulator". Measured 60.25fps on this hardware (2026-09-12);
        // ~3 blits of decreasing size ≈ 4MP/frame is nothing to the GPU
        // canvas. If this ever regresses on weaker machines, gate it
        // behind a quality toggle — do NOT revert to native blit for
        // all sizes.
        const r = canvas.getBoundingClientRect();
        const dpr = Math.max(1, window.devicePixelRatio || 1);
        const tw = r.width >= 2 ? Math.max(1, Math.round(r.width * dpr)) : w;
        const th = r.height >= 2 ? Math.max(1, Math.round(r.height * dpr)) : h;
        if (tw < w && th < h) {
          if (canvas.width !== tw || canvas.height !== th) { canvas.width = tw; canvas.height = th; }
          const ctx = canvas.getContext('2d');
          if (ctx) {
            drawScaled(ctx, f, w, h, tw, th);
            lastPaintAt = Date.now();
            lastRealPaint = Date.now();
            if (frameObservers.size > 0) for (const cb of frameObservers) cb(lastPaintAt);
          }
        } else {
          if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(f, 0, 0);
            lastPaintAt = Date.now();
            lastRealPaint = Date.now();
            if (frameObservers.size > 0) for (const cb of frameObservers) cb(lastPaintAt);
          }
        }
        // keep the painted source OPEN for the quiet-path polish, closing
        // the previous kept one (a closed VideoFrame draws transparent)
        if (polishSrc && polishSrc !== f) closeSrc(polishSrc);
        polishSrc = f;
      }
      rafId = requestAnimationFrame(paint);
    };
    rafId = requestAnimationFrame(paint);
    // quiet-path polish: cheap 500ms tick, gated internally by 300ms-quiet
    polishTimer = setInterval(polish, 500);
    // route stop() through the same cleanup: track the raf loop for teardown
    directRaf = () => {
      alive = false;
      if (rafId) cancelAnimationFrame(rafId);
      if (polishTimer) { clearInterval(polishTimer); polishTimer = null; }
      closeSrc(polishSrc); polishSrc = null;
    };
  }

  async function connect(udid: string, isRetry: boolean): Promise<void> {
    const gen = generation;
    state.value = isRetry ? 'reconnecting' : 'connecting';
    controlLost.value = false;   // fresh attach: previous refusal is stale
    if (pendingFormat === 'mjpeg') {
      // The mjpeg relay path is deleted (Phase 3) — the wrapped surface's
      // AVCC stream is the only engine. An explicit mjpeg request fails
      // LOUDLY instead of silently wedging at 'connecting'.
      fail('mjpeg stream format is no longer supported', false);
      return;
    }
    // H.264 by default: bare start(udid) (RunPanel, DrivePage, sidebar
    // before /me resolves) must ride the AVCC path, not fall through the
    // removed mjpeg branch and wedge.
    try {
      const rd = await fetch(`/api/devices/${encodeURIComponent(udid)}/stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      if (!rd.ok) {
        const eb = await rd.json().catch(() => ({})) as { error?: string; retryable?: boolean };
        throw new Error(eb.error ?? `resolve ${rd.status}`);
      }
      const bd = await rd.json() as { simdeckUrl?: string };
      if (!bd.simdeckUrl) throw new Error('no device surface url in resolve');
      const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${bd.simdeckUrl}/stream?format=avcc&version=v2`;
      attachDirect(new WebSocket(wsUrl), udid, gen, { tolerantAcks: true });
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err), true);
    }
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
    if (stillTimer) { clearTimeout(stillTimer); stillTimer = null; }
    stillStale = true; // any in-flight PNG capture aborts on its gen check
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
// Direct-socket send hook: set by attachDirect when the browser owns a
// stream WS to the engine; the input composable binds it so gestures ride
// the same socket (realtime, no HTTP hop). Cleared on teardown.
/** last engine-side input refusal (surfaced by the sidebar status line) */
const lastInputError = ref('');
export function inputError(): Ref<string> { return lastInputError; }

/** control-lost signal: the engine refused input with 'not granted' — the
 *  driving session was reaped/revoked server-side (idle watchdog, restart).
 *  The stream keeps playing, so without this the wall looks live while every
 *  gesture silently dies. The sidebar drops to watching + banner on it. */
const controlLost = ref(false);
export function isControlLost(): Ref<boolean> { return controlLost; }


export function canvasPointToLogical(canvas: HTMLCanvasElement, clientX: number, clientY: number, logicalW?: number | null, logicalH?: number | null): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const px = ((clientX - rect.left) / rect.width) * canvas.width;
  const py = ((clientY - rect.top) / rect.height) * canvas.height;
  if (!logicalW || !logicalH || !canvas.width || !canvas.height) return { x: Math.round(px), y: Math.round(py) };
  const sx = logicalW / canvas.width;
  const sy = logicalH / canvas.height;
  return { x: Math.round(px * sx), y: Math.round(py * sy) };
}
