<script setup lang="ts">
/** StageBezel — the single spacious device on the REAL simdeck bezel chrome
 *  (bezel PNG + screen-rect % + hardware buttons), same source as
 *  DeviceSidebar (composables/simdeckChrome.ts) — not a CSS mock. Absent
 *  chrome degrades to the bare canvas. Zoom: magnifier −/+ steps; the wrap
 *  is SIZED at the zoom factor (real layout, stage scrolls when larger) so
 *  tap mapping — which is rect-derived — stays correct at any zoom.
 *  Session chip, screen-state chip (F5 ladder), session-lost banner. */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useDeviceStream, canvasPointToLogical } from '../../composables/deviceStream.ts';
import { loadBezelDefinition, peekBezelDefinition, type BezelDefinition } from '../../composables/simdeckChrome.ts';
import InspectOverlay from '../InspectOverlay.vue';
import StreamShimmer from './StreamShimmer.vue';
import InspectRedlines from '../InspectRedlines.vue';
import { hitTestNodeAt, type AxNode } from '@crucible/shared/ax-tree';

const props = defineProps<{
  udid: string;
  /** device mid power-restart: the bezel STAYS with a restarting veil —
   *  the stream dies with the device, but the chrome must not vanish */
  restarting?: boolean;
  /** a testcase is running on this device: take control is unavailable
   *  (driving mid-case poisons the case's steps) */
  caseRunning?: boolean;
  /** durable per-device session handle from the page's map — a returning tab
   *  adopts this instead of showing idle (plan F6/:key remount shape) */
  session?: { sessionId: string; startedAt: number } | null;
  overlayNodes?: Array<Record<string, unknown>>;
  overlayW?: number | null;
  overlayH?: number | null;
  overlayVisible?: boolean;
  selParentNode?: Record<string, unknown> | null;
}>();
const overlayNodesC = computed((): never => (props.overlayNodes ?? []) as never);
const overlayWC = computed((): number | null => props.overlayW ?? null);
const overlayHC = computed((): number | null => props.overlayH ?? null);
const overlayVisibleC = computed((): boolean => props.overlayVisible ?? false);
const selNodeC = computed((): Record<string, unknown> | null => props.selParentNode ?? null);
const emit = defineEmits<{
  (e: 'session-state', s: { sessionId: string | null; dims?: { w: number | null; h: number | null } }): void;
  (e: 'inspect-click', ev: MouseEvent): void;
  (e: 'session-acquired', s: { sessionId: string; startedAt: number }): void;
  (e: 'session-dropped'): void;

  (e: 'exit-inspect'): void;
  (e: 'abort-running'): void;
}>();

const stream = useDeviceStream();
// fps-chip smoothing — rolling 2s PEAK. The instantaneous chip flickered
// 20→8→20 during gesture pauses (scroll-settle keeps compositing light
// frames, so fps never reaches 0 between swipes — a zero-guard hysteresis
// missed it, found in the 2026-10-03 drill). Showing the peak over the
// last 2s reads as the motion rate; after 2s true quiet the label drops
// to idle. Display-only; the stream/meter/evidence are untouched.
const fpsWindow = ref<{ t: number; fps: number }[]>([]);
const fpsTick = ref(0);
let fpsPruner: ReturnType<typeof setInterval> | undefined;
watch(stream.fps, (fps) => {
  if (fps > 0) fpsWindow.value.push({ t: Date.now(), fps });
});
const pushSample = () => { if (stream.fps.value > 0) fpsWindow.value.push({ t: Date.now(), fps: stream.fps.value }); };
const fpsLabel = computed(() => {
  void fpsTick.value; // recompute on the prune tick, not just on fps change
  const cutoff = Date.now() - 2000;
  const recent = fpsWindow.value.filter((s) => s.t >= cutoff);
  if (recent.length === 0) return 'live · idle (screen unchanged)';
  return `live · ${Math.max(...recent.map((s) => s.fps))}fps`;
});
onMounted(() => {
  // tick feeds the window too: an UNCHANGED fps (>0) never fires the watch,
  // so between swipes the window drained and the peak collapsed to the
  // settle rate — the exact flicker this smoothing exists to hide.
  fpsPruner = setInterval(() => { pushSample(); fpsTick.value++; }, 500);
});
onBeforeUnmount(() => { if (fpsPruner) clearInterval(fpsPruner); if (watchRetry) clearInterval(watchRetry); });

const sessionId = ref<string | null>(null);
const logicalW = ref<number | null>(null);
const logicalH = ref<number | null>(null);
const busy = ref(false);
const error = ref('');
const lost = ref(false);
const screenState = ref('—'); // F5 ladder: run arrival > inspect > '—'
const startedAt = ref<number | null>(null);

// ── inspect mode (page toggles; clicks select instead of dispatch) ──
const inspect = ref(false);
const selNode = ref<AxNode | null>(null);
const hoverNode = ref<AxNode | null>(null);
let rafId = 0;
function onCanvasMove(e: MouseEvent): void {
  if (!inspect.value) return;
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    const canvas = document.querySelector('.stage .bezel-screen') as HTMLCanvasElement | null;
    if (!canvas) return;
    const { x, y } = canvasPointToLogical(canvas, e.clientX, e.clientY, logicalW.value, logicalH.value);
    hoverNode.value = hitTestNodeAt(overlayNodesC.value as never, x, y);
  });
}
function setInspect(on: boolean): void { inspect.value = on; if (!on) { selNode.value = null; hoverNode.value = null; } }
function onCanvasLeave(): void { hoverNode.value = null; }

// ── REAL bezel chrome (simdeck definition; degrades to null → bare canvas) ──
const bezelDef = ref<BezelDefinition | null>(null);
// Chrome-ready gate: the bezel must appear WHOLE (definition + decoded PNG),
// never half-in. Found live: img render raced PNG decode — first switch drew
// a gap, return switches re-fetched everything. Cache (simdeckChrome) kills
// the refetch; decode() gates the reveal; a 200ms opacity fade replaces the
// pop-in. Screen content (canvas/shimmer) is NOT gated — only chrome.
const chromeReady = ref(false);
let chromeGen = 0;
watch(() => props.udid, async (u) => {
  // per-mount (page remounts via :key): adopt the page map's handle if the
  // device still holds a live session — returning to a tab resumes control
  const adopt = props.session ?? null;
  sessionId.value = adopt?.sessionId ?? null;
  startedAt.value = adopt?.startedAt ?? null;
  // adoption must reach the page too: sessionOn drives ToolsDrawer (inspect)
  // and tab-close cleanup. Without this emit, a session adopted at mount (e.g.
  // page reload with a live session) was invisible to the page — inspect's
  // tree never enabled (found live: badge stuck '· off', 0 /tree fetches).
  if (adopt) emit('session-acquired', { sessionId: adopt.sessionId, startedAt: adopt.startedAt });
  logicalW.value = null;
  lost.value = false;
  screenState.value = '—';
  bezelDef.value = null;
  if (u) {
    // warm switch: a cached def paints the wrap THIS frame (skeleton at
    // half opacity) — kills the empty-stage gap between tab mounts. The
    // full reveal still waits for PNG decode.
    const warm = peekBezelDefinition(u);
    if (warm) { bezelDef.value = warm; chromeReady.value = false; }
    // :key remount: let the outgoing instance's teardown (stream.stop) land
    // first — starting instantly raced it and double-connected per switch
    await new Promise((r) => setTimeout(r, 120));
    stream.start(u);
    const def = await loadBezelDefinition(u);
    bezelDef.value = def;
    // chrome reveal gate: def cached hit is instant, but the PNG must be
    // DECODED before we show it — an undecoded <img> paints a gap on first
    // switch. Decode in parallel with the stream's first frames; reveal when
    // both chrome + a rendered frame exist (or 600ms cap — never block the
    // stage on a slow decode).
    const gen = ++chromeGen;
    chromeReady.value = false;
    if (def) {
      const img = new Image();
      img.src = def.bezel.url;
      const decoded = (img.decode?.() ?? Promise.resolve()).catch(() => undefined);
      const frame = new Promise<void>((res) => {
        if (stream.frames.value > 0) { res(); return; }
        const un = watch(stream.frames, (n) => { if (n > 0) { un(); res(); } });
      });
      await Promise.race([Promise.all([decoded, frame]), new Promise((r) => setTimeout(r, 600))]);
      if (gen !== chromeGen) return; // superseded by another switch
    }
    chromeReady.value = true;
  } else stream.stop();
}, { immediate: true });

// WebKit aspect-ratio collapse guard (same fix as DeviceSidebar): size the
// wrap explicitly from the stage box at the CURRENT zoom — layout is real,
// so the stage scrolls when zoomed past fit and tap rects stay truthful.
const bezelWrapEl = ref<HTMLElement | null>(null);
let wrapObs: ResizeObserver | null = null;
function sizeBezelWrap(): void {
  const wrap = bezelWrapEl.value;
  const def = bezelDef.value;
  if (!wrap || !def) return;
  const stage = wrap.closest('.stage');
  if (!stage) return;
  const ar = def.bezel.width / def.bezel.height;
  const w = Math.min(stage.clientHeight * ar, stage.clientWidth) * zoom.value;
  wrap.style.width = `${Math.max(0, Math.round(w))}px`;
  wrap.style.height = `${Math.max(0, Math.round(w / ar))}px`;
}

// ── zoom (magnifiers): fit=100% baseline, ±25% steps, clamp 50–200% ──
const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;
const zoomIdx = ref(2);
const zoom = computed((): number => ZOOM_STEPS[zoomIdx.value]!);
function zoomIn(): void { if (zoomIdx.value < ZOOM_STEPS.length - 1) { zoomIdx.value++; sizeBezelWrap(); } }
function zoomOut(): void { if (zoomIdx.value > 0) { zoomIdx.value--; sizeBezelWrap(); } }
const zoomLabel = computed((): string => `${Math.round(zoom.value * 100)}%`);
watch([bezelDef, bezelWrapEl], () => sizeBezelWrap(), { flush: 'post' });
onMounted(() => {
  wrapObs = new ResizeObserver(sizeBezelWrap);
  if (bezelWrapEl.value?.closest('.stage')) wrapObs.observe(bezelWrapEl.value.closest('.stage') as Element);
});
onBeforeUnmount(() => {
  wrapObs?.disconnect(); wrapObs = null;
  // stage remounts per udid (:key): the outgoing instance MUST tear down its
  // stream or the leaked WS's reconnect loop fights the new instance's leg
  // (last-viewer-wins evictions = aurora/screen flapping found live)
  stream.stop();
});

async function api(path: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`/api/manual/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  return (await res.json()) as Record<string, unknown>;
}

async function takeControl(): Promise<void> {
  busy.value = true; error.value = ''; lost.value = false;
  try {
    const res = await fetch('/api/manual/start', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ udid: props.udid }),
    });
    const body = await res.json() as { sessionId?: string; logicalW?: number | null; logicalH?: number | null; error?: string };
    if (body.sessionId) {
      sessionId.value = body.sessionId;
      logicalW.value = body.logicalW ?? null;
      logicalH.value = body.logicalH ?? null;
      startedAt.value = Date.now();
      emit('session-acquired', { sessionId: body.sessionId, startedAt: startedAt.value });
      emit('session-state', { sessionId: body.sessionId, dims: { w: logicalW.value, h: logicalH.value } });
      if (!stream.state.value || stream.state.value === 'idle') stream.start(props.udid);
    } else if (/queued\/running automated run|run holds this device/i.test(body.error ?? '')) {
      // a testcase owns the device: enter WATCH-LOCK — the stream stays (it
      // needs no session), the banner explains, and the button retries the
      // moment the run finishes (operator: take control should be available
      // while a testcase runs — this makes it available-without-poisoning).
      runLocked.value = true;
      if (!stream.state.value || stream.state.value === 'idle') stream.start(props.udid);
      // retry the start every 5s: while the run holds the device the 409
      // keeps the lock; the first success clears it and the session lands
      watchRetry = setInterval(() => { void tryStart(); }, 5000);
    } else error.value = body.error ?? 'failed to start';
  } finally { busy.value = false; }
}
let watchRetry: ReturnType<typeof setInterval> | undefined;
const runLocked = ref(false);
async function tryStart(): Promise<void> {
  const res = await fetch('/api/manual/start', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ udid: props.udid }),
  });
  const body = await res.json() as { sessionId?: string; logicalW?: number | null; logicalH?: number | null; error?: string };
  if (body.sessionId) {
    if (watchRetry) { clearInterval(watchRetry); watchRetry = undefined; }
    runLocked.value = false;
    sessionId.value = body.sessionId;
    logicalW.value = body.logicalW ?? null;
    logicalH.value = body.logicalH ?? null;
    startedAt.value = Date.now();
    emit('session-acquired', { sessionId: body.sessionId, startedAt: startedAt.value });
    emit('session-state', { sessionId: body.sessionId, dims: { w: logicalW.value, h: logicalH.value } });
  }
}

async function release(): Promise<void> {
  const id = sessionId.value;
  sessionId.value = null; startedAt.value = null;
  emit('session-dropped');
  emit('session-state', { sessionId: null });
  if (id) { try { await api(`${id}/finish`, { note: 'manual:cockpit' }); } catch { /* idempotent server-side */ } }
}

function endSession(): void {
  sessionId.value = null; startedAt.value = null;
  lost.value = true;
  emit('session-dropped');
  emit('session-state', { sessionId: null, dims: { w: null, h: null } });
}

async function fastPathFrame(): Promise<void> {
  if (!sessionId.value) return;
  try {
    const r = await api(`${sessionId.value}/snapshot`);
    const path = r['path'] as string | undefined;
    if (path && stream.canvasRef.value) {
      const img = new Image();
      img.onload = () => stream.paintStillImage(img);
      img.src = `/api/manual-frame?path=${encodeURIComponent(path)}&t=${Date.now()}`;
    }
  } catch { /* fast-path only */ }
}

// ── Stage-1 input verbs (plan 20261009T001703Z T2) ──
// 2x / hold arm the NEXT canvas click (tap-modifiers); shake + paste fire
// directly from the verb pad.
const tapMode = ref<'tap' | 'double' | 'hold'>('tap');

/** menu entry: arm a tap modifier (next canvas click fires it) */
function armTapMode(mode: 'tap' | 'double' | 'hold'): void { tapMode.value = mode; }

async function dispatchVerb(kind: 'double' | 'hold', x: number, y: number): Promise<void> {
  if (!sessionId.value) return;
  const path = kind === 'double' ? 'double-tap' : 'long-press';
  const body = kind === 'double' ? { x, y } : { x, y, dwellMs: 800 };
  const r = await api(`${sessionId.value}/${path}`, body);
  if (r['error']) {
    error.value = String(r['error']);
    if (String(r['code']) === 'LEASE_LOST' || String(r['code']) === 'SESSION_NOT_FOUND') endSession();
  } else await fastPathFrame();
}

async function doShake(): Promise<void> {
  if (!sessionId.value || busy.value) return;
  busy.value = true; error.value = '';
  try {
    const r = await api(`${sessionId.value}/shake`);
    if (r['error']) {
      error.value = String(r['error']);
      if (String(r['code']) === 'LEASE_LOST' || String(r['code']) === 'SESSION_NOT_FOUND') endSession();
    } else await fastPathFrame();
  } finally { busy.value = false; }
}

const pasteBusy = ref(false);
async function doPaste(text?: string): Promise<void> {
  if (!sessionId.value || pasteBusy.value) return;
  const body = typeof text === 'string' && text ? text : window.prompt('paste text into the focused field:');
  if (!body) return;
  pasteBusy.value = true; error.value = '';
  try {
    const r = await api(`${sessionId.value}/paste`, { text: body, press: true });
    if (r['error']) {
      error.value = String(r['error']);
      if (String(r['code']) === 'LEASE_LOST' || String(r['code']) === 'SESSION_NOT_FOUND') endSession();
    } else await fastPathFrame();
  } finally { pasteBusy.value = false; }
}

async function onTap(e: MouseEvent): Promise<void> {
  if (!sessionId.value || !(e.target instanceof HTMLCanvasElement)) return;
  if (inspect.value) { emit('inspect-click', e); return; } // select, never dispatch
  const canvas = e.target;
  const { x, y } = canvasPointToLogical(canvas, e.clientX, e.clientY, logicalW.value, logicalH.value);
  if (tapMode.value !== 'tap') {
    const mode = tapMode.value;
    tapMode.value = 'tap'; // one-shot: modifiers arm the next click only
    busy.value = true; error.value = '';
    try { await dispatchVerb(mode, x, y); } finally { busy.value = false; }
    return;
  }
  busy.value = true; error.value = '';
  try {
    const r = await api(`${sessionId.value}/tap`, { x, y });
    if (r['error']) {
      error.value = String(r['error']);
      if (String(r['code']) === 'LEASE_LOST' || String(r['code']) === 'SESSION_NOT_FOUND') endSession();
    } else await fastPathFrame();
  } finally { busy.value = false; }
}

// ── wheel scroll → the SIM owns it (operator directive 2026-10-03) ──
// Inside the device screen the wheel must never scroll the PAGE (the stage
// scrolls when zoomed past fit — that stays available OUTSIDE the bezel).
// Pixel deltas go straight to the session's scroll-delta (finer than the
// old direction scroll); threshold + single-flight keep one gesture = one
// dispatch, mirroring the old DrivePage accumulator.
let wheelAccum = 0;
let wheelBusy = false;
async function onWheel(e: WheelEvent): Promise<void> {
  if (!(e.target instanceof HTMLCanvasElement)) return;
  // the sim owns the wheel inside the screen — the page must not scroll,
  // even with no live session yet (nothing to send, still swallowed)
  e.preventDefault();
  if (!sessionId.value) return;
  wheelAccum += e.deltaY;
  if (wheelBusy || Math.abs(wheelAccum) < 40) return;
  const dy = Math.round(wheelAccum);
  wheelAccum = 0;
  wheelBusy = true;
  try {
    const r = await api(`${sessionId.value}/scroll-delta`, { deltaX: 0, deltaY: dy });
    if (r['error']) {
      error.value = String(r['error']);
      if (String(r['code']) === 'LEASE_LOST' || String(r['code']) === 'SESSION_NOT_FOUND') endSession();
    } else await fastPathFrame();
  } finally { wheelBusy = false; }
}

// ── bezel hardware buttons: hover pop-out + press dispatch (as DeviceSidebar) ──
const hoverBtn = ref('');
const pressedBtn = ref('');
async function pressBtn(b: BezelDefinition['buttons'][number]): Promise<void> {
  if (!sessionId.value) return;
  await api(`${sessionId.value}/button`, { button: b.name }).catch(() => undefined);
  void fastPathFrame();
}
function buttonState(b: BezelDefinition['buttons'][number]): 'rest' | 'hover' | 'pressed' {
  if (pressedBtn.value === b.name) return 'pressed';
  if (hoverBtn.value === b.name) return 'hover';
  return 'rest';
}
function buttonStyle(b: BezelDefinition['buttons'][number]): Record<string, string> {
  return {
    left: `${b.boxPct.left}%`, top: `${b.boxPct.top}%`,
    width: `${b.boxPct.width}%`, height: `${b.boxPct.height}%`,
    transform: b.transform[buttonState(b)],
    transition: 'transform 120ms ease',
  };
}
function buttonSrc(b: BezelDefinition['buttons'][number]): string {
  return buttonState(b) === 'pressed' ? b.pressedImageUrl : b.imageUrl;
}

const nowTick = ref(Date.now());
setInterval(() => { nowTick.value = Date.now(); }, 10_000);
const sessionLabel = computed((): string | null => {
  void nowTick.value;
  if (!sessionId.value || !startedAt.value) return null;
  const min = Math.floor((Date.now() - startedAt.value) / 60000);
  return `MANUAL · ${min}m`;
});
defineExpose({
  takeControl, release, sessionLabel, screenState, zoomIn, zoomOut, runLocked,
  // input-verbs stage 1: menu-driven access (page routes menu events here)
  armTapMode, doShake, doPaste,

  dismissRunLock: (): void => { runLocked.value = false; if (watchRetry) { clearInterval(watchRetry); watchRetry = undefined; } },
  setScreenState: (s: string): void => { screenState.value = s; },
  setInspect, inspect,
  paintSelectedSpec: (n: AxNode | null): void => { selNode.value = n; },
});
</script>

<template>
  <div class="stage">
    <div v-if="lost" class="lost">session lost — take control again</div>
    <div v-if="runLocked" class="runlock">⏳ a test case is running on this device — take control unlocks automatically when it finishes</div>

    <!-- control cluster: zoom on top, session button below -->
    <div class="ctrlcol">
      <div class="zoombar">
        <button type="button" :disabled="zoomIdx === 0" title="zoom out (−)" @click="zoomOut">−</button>
        <span class="zlabel">{{ zoomLabel }}</span>
        <button type="button" :disabled="zoomIdx === ZOOM_STEPS.length - 1" title="zoom in (+)" @click="zoomIn">+</button>
      </div>
      <button v-if="!sessionId && caseRunning" class="session-btn abort" title="abort the running test case / suite" @click="emit('abort-running')">abort</button>
      <button v-else-if="!sessionId" class="session-btn primary" :disabled="busy" @click="takeControl">take control</button>
      <button v-else class="session-btn danger" :disabled="busy" @click="release">release</button>
      <button v-if="inspect" type="button" class="inspect-chip" title="exit inspect (⌘I)" @click.stop="emit('exit-inspect')">⌖ inspecting · ⌘I to exit</button>
      <div v-if="stream.state.value === 'live'" class="fps-chip">{{ fpsLabel }}</div>
    </div>

    <!-- the REAL bezel: PNG body + % screen rect + hardware buttons -->
    <div v-if="bezelDef" ref="bezelWrapEl" class="bezel-wrap" :class="{ ready: chromeReady }">
      <img class="bezel-img" :src="bezelDef.bezel.url" :width="bezelDef.bezel.width" :height="bezelDef.bezel.height" alt="" draggable="false" />
      <canvas v-show="stream.state.value !== 'idle'" :ref="stream.setCanvas" class="bezel-screen"
        @wheel="onWheel" :class="{ 'no-session': !sessionId, inspecting: inspect }" tabindex="0" @click="onTap" @mousemove="onCanvasMove" @mouseleave="onCanvasLeave"
        :style="{ left: `${bezelDef.screen.xPct}%`, top: `${bezelDef.screen.yPct}%`,
                  width: `${bezelDef.screen.wPct}%`, height: `${bezelDef.screen.hPct}%`,
                  borderRadius: `${bezelDef.screenRadius.pctW}% / ${bezelDef.screenRadius.pctH}%` }"></canvas>
      <div v-if="restarting" class="restarting-veil" :style="{ left: `${bezelDef.screen.xPct}%`, top: `${bezelDef.screen.yPct}%`, width: `${bezelDef.screen.wPct}%`, height: `${bezelDef.screen.hPct}%`, borderRadius: `${bezelDef.screenRadius.pctW}% / ${bezelDef.screenRadius.pctH}%` }">
        <span class="restarting-dot" />restarting
      </div>
      <StreamShimmer :state="stream.state.value" :style="{ left: `${bezelDef.screen.xPct}%`, top: `${bezelDef.screen.yPct}%`, width: `${bezelDef.screen.wPct}%`, height: `${bezelDef.screen.hPct}%`, borderRadius: `${bezelDef.screenRadius.pctW}% / ${bezelDef.screenRadius.pctH}%` }" />
      <InspectOverlay v-if="inspect && sessionId" :nodes="overlayNodesC" :logical-w="overlayWC" :logical-h="overlayHC"
        :hover="hoverNode" :selected="(selNodeC as never)" :visible="overlayVisibleC"
        :style="{ left: `${bezelDef.screen.xPct}%`, top: `${bezelDef.screen.yPct}%`,
                  width: `${bezelDef.screen.wPct}%`, height: `${bezelDef.screen.hPct}%` }" />
      <InspectRedlines v-if="inspect && sessionId && selNodeC" :selected="(selNodeC as never)" :parent="null" :siblings="[]"
        mode="both" :visible="overlayVisibleC"
        :logical-w="overlayWC" :logical-h="overlayHC"
        :style="{ left: `${bezelDef.screen.xPct}%`, top: `${bezelDef.screen.yPct}%`,
                  width: `${bezelDef.screen.wPct}%`, height: `${bezelDef.screen.hPct}%` }" />
      <!-- interaction overlay (sketch 030-B): WHERE the system taps/types —
           same screen rect as the inspect overlays, transparent, no events -->
      <div class="ia-slot" :style="{ left: `${bezelDef.screen.xPct}%`, top: `${bezelDef.screen.yPct}%`,
                     width: `${bezelDef.screen.wPct}%`, height: `${bezelDef.screen.hPct}%` }"><slot /></div>
      <img v-for="b in bezelDef.buttons" :key="b.name" class="bezel-btn"
        :src="buttonSrc(b)" :alt="b.name" draggable="false"
        :style="buttonStyle(b)"
        :class="{ 'on-top': b.onTop, armed: !!sessionId }"
        @pointerenter="hoverBtn = b.name" @pointerleave="hoverBtn = ''"
        @pointerdown.prevent="pressedBtn = b.name; pressBtn(b)"
        @pointerup.prevent="pressedBtn = ''; hoverBtn = ''"
        @pointercancel.prevent="pressedBtn = ''" />
      <div v-if="stream.state.value === 'failed'" class="failbox">
        <span>{{ stream.failure.value || 'stream failed' }}</span>
        <button v-if="stream.retryable.value" type="button" @click="stream.retry()">retry</button>
      </div>
    </div>

    <!-- fallback: no chrome bundle for this model — bare canvas -->
    <div v-else class="bezel-bare">
      <div class="screen">
          <canvas v-show="stream.state.value !== 'idle'" :ref="stream.setCanvas" @click="onTap" />
          <div class="ia-slot" style="inset: 0;"><slot /></div>
        <StreamShimmer :state="stream.state.value" />
        <div v-if="stream.state.value === 'failed'" class="failbox">
          <span>{{ stream.failure.value || 'stream failed' }}</span>
          <button v-if="stream.retryable.value" type="button" @click="stream.retry()">retry</button>
        </div>
        <div v-else-if="!sessionId && stream.state.value !== 'live'" class="placeholder">no session — take control to drive</div>
      </div>
    </div>

    <div class="statechip">screen · {{ screenState }}</div>
    <div v-if="error" class="err">{{ error }}</div>
  </div>
</template>

<style scoped>
.stage { position: relative; display: grid; place-items: center; overflow: auto; grid-template-rows: 1fr auto; width: 100%; height: 100%; }
.runlock { position: absolute; top: 14px; left: 50%; transform: translateX(-50%); z-index: 8; background: var(--color-carbon); border: 1px solid var(--color-ember); color: var(--color-ember); font-size: 11px; letter-spacing: .04em; padding: 6px 14px; border-radius: var(--r); white-space: nowrap; }
.lost { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); z-index: 6; background: var(--color-carbon); border: 1px solid var(--color-paper); color: var(--color-paper); font-size: 11px; padding: 6px 10px; }
.ctrlcol { position: absolute; top: 12px; right: 12px; z-index: 6; display: flex; flex-direction: column; align-items: stretch; gap: 6px; }
.zoombar { display: flex; align-items: center; justify-content: center; gap: 6px; background: var(--color-carbon); border: 1px solid var(--color-iron); border-radius: var(--r); padding: 3px 6px; }
.session-btn { font-family: inherit; background: none; border: 1px solid var(--color-iron); color: var(--color-fog); padding: 4px 10px; cursor: pointer; font-size: var(--text-caption); border-radius: var(--r); }
.session-btn:hover:not(:disabled) { border-color: var(--color-slate); color: var(--color-paper); }
.session-btn.primary { background: var(--color-ember); border-color: var(--color-ember); color: #000; font-weight: var(--weight-bold); }
.session-btn.abort { background: none; border: 1px solid var(--color-ember); color: var(--color-ember); }
.session-btn.abort:hover { background: var(--color-ember); color: var(--color-carbon); }
.session-btn.danger { background: #c8342c; border-color: #c8342c; color: #fff; font-weight: var(--weight-bold); }
.session-btn.danger:hover:not(:disabled) { background: #b02a23; border-color: #b02a23; color: #fff; }
.session-btn:disabled { opacity: .5; cursor: default; }
.fps-chip { text-align: center; font-size: 9px; letter-spacing: .06em; color: var(--color-fog); background: var(--color-carbon); border: 1px solid var(--color-iron); border-radius: var(--r); padding: 1px 6px; }
.zoombar button { font-family: inherit; width: 22px; height: 22px; line-height: 1; background: none; border: 1px solid var(--color-iron); color: var(--color-fog); border-radius: var(--r); cursor: pointer; font-size: 14px; display: grid; place-items: center; }
.zoombar button:hover:not(:disabled) { border-color: var(--color-ember); color: var(--color-ember); }
.zoombar button:disabled { opacity: .35; cursor: default; }
.zlabel { font-size: 10px; color: var(--color-fog); min-width: 36px; text-align: center; }

/* the REAL bezel: wrap sized explicitly (WebKit aspect-ratio guard), image
 * fills it; canvas + buttons ride % rects — aligned by construction */
.inspect-chip { background: var(--color-carbon); border: 1px solid var(--color-ember); color: var(--color-ember); font-family: inherit; font-size: 9px; letter-spacing: .06em; text-transform: uppercase; padding: 2px 6px; border-radius: var(--r); cursor: pointer; text-align: center; white-space: nowrap; }
.inspect-chip:hover { background: var(--color-ember); color: var(--color-carbon); }
.restarting-veil { position: absolute; z-index: 6; display: flex; align-items: center; justify-content: center; gap: 7px; background: rgba(0,0,0,.72); color: var(--color-ember); font-size: 11px; letter-spacing: .12em; text-transform: uppercase; border: 1px solid var(--color-iron); }
.restarting-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--color-ember); animation: restarting-pulse 1.1s infinite; }
@keyframes restarting-pulse { 0%,100% { opacity: 1; } 50% { opacity: .25; } }
@media (prefers-reduced-motion: reduce) { .restarting-dot { animation: none; } }
.ia-slot { position: absolute; pointer-events: none; }
.bezel-wrap {
  opacity: .5;
  transition: opacity .2s ease;
}
.bezel-wrap.ready { opacity: 1; }
.bezel-wrap { position: relative; flex: 0 0 auto; font-size: 0; }
.bezel-img { display: block; height: 100%; width: auto; pointer-events: none; user-select: none; -webkit-user-drag: none; }
.bezel-screen { position: absolute; display: block; cursor: pointer; background: var(--color-void); outline: none; }
.bezel-screen.no-session { cursor: default; }
.bezel-screen.inspecting { cursor: default; }
.bezel-btn { position: absolute; z-index: 0; pointer-events: none; user-select: none; -webkit-user-drag: none; }
.bezel-btn.on-top { z-index: 2; }
.bezel-btn.armed { pointer-events: auto; cursor: pointer; }
.bezel-wrap .failbox { position: absolute; inset: 0; z-index: 3; display: flex; flex-direction: column; gap: 8px; align-items: center; justify-content: center; color: var(--color-paper); font-size: var(--text-caption); background: rgba(0, 0, 0, .6); }
.failbox button { background: none; border: 1px solid var(--color-iron); color: var(--color-fog); padding: 2px 10px; border-radius: var(--r); cursor: pointer; font-family: inherit; font-size: var(--text-caption); }

/* bare fallback (no chrome bundle) */
.bezel-bare { position: relative; flex: 0 0 auto; display: flex; align-items: center; justify-content: center; min-height: 60vh; max-height: calc(100% - 40px); aspect-ratio: 340 / 700; }
.bezel-bare { background: none; border: none; padding: 0; border-radius: 0; }
.bezel-bare canvas { height: 100%; width: auto; max-width: 100%; border-radius: 6px; }
.bezel-bare .screen canvas { display: block; height: 100%; width: auto; max-width: 100%; }
.placeholder { color: var(--color-steel); font-size: var(--text-caption); }

.statechip { margin-top: 8px; font-size: 10px; color: var(--color-fog); border: 1px solid var(--color-iron); background: rgba(0, 0, 0, .72); padding: 1px 8px; white-space: nowrap; }
.err { color: var(--color-paper); font-size: var(--text-caption); }
</style>
