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
import { loadBezelDefinition, type BezelDefinition } from '../../composables/simdeckChrome.ts';

const props = defineProps<{ udid: string }>();
const emit = defineEmits<{ (e: 'session-state', s: { sessionId: string | null; dims?: { w: number | null; h: number | null } }): void }>();

const stream = useDeviceStream();
const sessionId = ref<string | null>(null);
const logicalW = ref<number | null>(null);
const logicalH = ref<number | null>(null);
const busy = ref(false);
const error = ref('');
const lost = ref(false);
const screenState = ref('—'); // F5 ladder: run arrival > inspect > '—'
const startedAt = ref<number | null>(null);

// ── REAL bezel chrome (simdeck definition; degrades to null → bare canvas) ──
const bezelDef = ref<BezelDefinition | null>(null);
watch(() => props.udid, async (u) => {
  // switching devices: release nothing server-side (lease is per-device; the
  // active lease stays), just detach the stream + local session view
  sessionId.value = null;
  logicalW.value = null;
  lost.value = false;
  screenState.value = '—';
  bezelDef.value = null;
  if (u) {
    stream.start(u);
    bezelDef.value = await loadBezelDefinition(u);
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
onBeforeUnmount(() => { wrapObs?.disconnect(); wrapObs = null; });

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
      emit('session-state', { sessionId: body.sessionId, dims: { w: logicalW.value, h: logicalH.value } });
      if (!stream.state.value || stream.state.value === 'idle') stream.start(props.udid);
    } else error.value = body.error ?? 'failed to start';
  } finally { busy.value = false; }
}

async function release(): Promise<void> {
  const id = sessionId.value;
  sessionId.value = null; startedAt.value = null;
  emit('session-state', { sessionId: null });
  if (id) { try { await api(`${id}/finish`, { note: 'manual:cockpit' }); } catch { /* idempotent server-side */ } }
}

function endSession(): void {
  sessionId.value = null; startedAt.value = null;
  lost.value = true;
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

async function onTap(e: MouseEvent): Promise<void> {
  if (!sessionId.value || !(e.target instanceof HTMLCanvasElement)) return;
  const canvas = e.target;
  const { x, y } = canvasPointToLogical(canvas, e.clientX, e.clientY, logicalW.value, logicalH.value);
  busy.value = true; error.value = '';
  try {
    const r = await api(`${sessionId.value}/tap`, { x, y });
    if (r['error']) {
      error.value = String(r['error']);
      if (String(r['code']) === 'LEASE_LOST' || String(r['code']) === 'SESSION_NOT_FOUND') endSession();
    } else await fastPathFrame();
  } finally { busy.value = false; }
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

const sessionLabel = computed((): string | null => {
  if (!sessionId.value || !startedAt.value) return null;
  const min = Math.floor((Date.now() - startedAt.value) / 60000);
  return `MANUAL · ${min}m`;
});
defineExpose({ takeControl, release, sessionLabel, screenState, zoomIn, zoomOut, setScreenState: (s: string): void => { screenState.value = s; } });
</script>

<template>
  <div class="stage">
    <div v-if="lost" class="lost">session lost — take control again</div>

    <!-- magnifiers: zoom out / label / zoom in -->
    <div class="zoombar">
      <button type="button" :disabled="zoomIdx === 0" title="zoom out (−)" @click="zoomOut">−</button>
      <span class="zlabel">{{ zoomLabel }}</span>
      <button type="button" :disabled="zoomIdx === ZOOM_STEPS.length - 1" title="zoom in (+)" @click="zoomIn">+</button>
    </div>

    <!-- the REAL bezel: PNG body + % screen rect + hardware buttons -->
    <div v-if="bezelDef" ref="bezelWrapEl" class="bezel-wrap">
      <img class="bezel-img" :src="bezelDef.bezel.url" :width="bezelDef.bezel.width" :height="bezelDef.bezel.height" alt="" draggable="false" />
      <canvas v-show="stream.state.value !== 'idle'" :ref="stream.setCanvas" class="bezel-screen" tabindex="0" @click="onTap"
        :style="{ left: `${bezelDef.screen.xPct}%`, top: `${bezelDef.screen.yPct}%`,
                  width: `${bezelDef.screen.wPct}%`, height: `${bezelDef.screen.hPct}%`,
                  borderRadius: `${bezelDef.screenRadius.pctW}% / ${bezelDef.screenRadius.pctH}%` }"></canvas>
      <img v-for="b in bezelDef.buttons" :key="b.name" class="bezel-btn"
        :src="buttonSrc(b)" :alt="b.name" draggable="false"
        :style="buttonStyle(b)"
        :class="{ 'on-top': b.onTop, armed: !!sessionId }"
        @pointerenter="hoverBtn = b.name" @pointerleave="hoverBtn = ''"
        @pointerdown.prevent="pressedBtn = b.name; pressBtn(b)"
        @pointerup.prevent="pressedBtn = ''; hoverBtn = ''"
        @pointercancel.prevent="pressedBtn = ''" />
      <div v-if="sessionLabel" class="session-chip">{{ sessionLabel }}</div>
      <div v-if="stream.state.value === 'failed'" class="failbox">
        <span>{{ stream.failure.value || 'stream failed' }}</span>
        <button v-if="stream.retryable.value" type="button" @click="stream.retry()">retry</button>
      </div>
    </div>

    <!-- fallback: no chrome bundle for this model — bare canvas -->
    <div v-else class="bezel-bare">
      <div class="screen">
        <div v-if="sessionLabel" class="session-chip">{{ sessionLabel }}</div>
        <canvas v-show="stream.state.value !== 'idle'" :ref="stream.setCanvas" @click="onTap" />
        <div v-if="stream.state.value === 'failed'" class="failbox">
          <span>{{ stream.failure.value || 'stream failed' }}</span>
          <button v-if="stream.retryable.value" type="button" @click="stream.retry()">retry</button>
        </div>
        <div v-else-if="!sessionId && stream.state.value !== 'live'" class="placeholder">no session — take control to drive</div>
      </div>
    </div>

    <div class="statechip">screen · {{ screenState }}</div>
    <div class="drivebar">
      <button v-if="!sessionId" class="primary" :disabled="busy" @click="takeControl">take control</button>
      <button v-else :disabled="busy" @click="release">release</button>
      <span v-if="error" class="err">{{ error }}</span>
    </div>
  </div>
</template>

<style scoped>
.stage { position: relative; display: grid; place-items: center; overflow: auto; grid-template-rows: 1fr auto; width: 100%; height: 100%; }
.lost { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); z-index: 6; background: var(--color-carbon); border: 1px solid var(--color-paper); color: var(--color-paper); font-size: 11px; padding: 6px 10px; }
.zoombar { position: absolute; top: 12px; right: 12px; z-index: 6; display: flex; align-items: center; gap: 6px; background: var(--color-carbon); border: 1px solid var(--color-iron); border-radius: var(--r); padding: 3px 6px; }
.zoombar button { font-family: inherit; width: 22px; height: 22px; line-height: 1; background: none; border: 1px solid var(--color-iron); color: var(--color-fog); border-radius: var(--r); cursor: pointer; font-size: 14px; display: grid; place-items: center; }
.zoombar button:hover:not(:disabled) { border-color: var(--color-ember); color: var(--color-ember); }
.zoombar button:disabled { opacity: .35; cursor: default; }
.zlabel { font-size: 10px; color: var(--color-fog); min-width: 36px; text-align: center; }

/* the REAL bezel: wrap sized explicitly (WebKit aspect-ratio guard), image
 * fills it; canvas + buttons ride % rects — aligned by construction */
.bezel-wrap { position: relative; flex: 0 0 auto; font-size: 0; }
.bezel-img { display: block; height: 100%; width: auto; pointer-events: none; user-select: none; -webkit-user-drag: none; }
.bezel-screen { position: absolute; display: block; cursor: crosshair; background: var(--color-void); outline: none; }
.bezel-btn { position: absolute; z-index: 0; pointer-events: none; user-select: none; -webkit-user-drag: none; }
.bezel-btn.on-top { z-index: 2; }
.bezel-btn.armed { pointer-events: auto; cursor: pointer; }
.session-chip { position: absolute; top: 10px; right: 10px; z-index: 3; border: 1px solid var(--color-ember); color: var(--color-ember); background: rgba(0, 0, 0, .72); font-size: 10px; padding: 1px 6px; }
.bezel-wrap .failbox { position: absolute; inset: 0; z-index: 3; display: flex; flex-direction: column; gap: 8px; align-items: center; justify-content: center; color: var(--color-paper); font-size: var(--text-caption); background: rgba(0, 0, 0, .6); }
.failbox button { background: none; border: 1px solid var(--color-iron); color: var(--color-fog); padding: 2px 10px; border-radius: var(--r); cursor: pointer; font-family: inherit; font-size: var(--text-caption); }

/* bare fallback (no chrome bundle) */
.bezel-bare { position: relative; width: min(340px, 44vh); aspect-ratio: 340 / 700; max-height: calc(100% - 56px); background: var(--color-graphite); border: 1px solid var(--color-slate); border-radius: 16px; padding: 10px; }
.bezel-bare .screen { position: relative; width: 100%; height: 100%; background: var(--color-void); border-radius: 4px; overflow: hidden; display: grid; place-items: center; }
.bezel-bare .screen canvas { display: block; height: 100%; width: auto; max-width: 100%; }
.placeholder { color: var(--color-steel); font-size: var(--text-caption); }

.statechip { margin-top: 8px; font-size: 10px; color: var(--color-fog); border: 1px solid var(--color-iron); background: rgba(0, 0, 0, .72); padding: 1px 8px; white-space: nowrap; }
.drivebar { display: flex; gap: 10px; align-items: center; padding: 10px 0; }
.drivebar button { font-family: inherit; background: none; border: 1px solid var(--color-iron); color: var(--color-fog); padding: var(--s-1) var(--s-2); cursor: pointer; font-size: var(--text-caption); border-radius: var(--r); }
.drivebar button:hover:not(:disabled) { border-color: var(--color-slate); color: var(--color-paper); }
.drivebar button.primary { background: var(--color-ember); border-color: var(--color-ember); color: #000; font-weight: var(--weight-bold); }
.drivebar button:disabled { opacity: .5; cursor: default; }
.err { color: var(--color-paper); font-size: var(--text-caption); }
</style>
