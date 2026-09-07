<script setup lang="ts">
import { ref, computed, onUnmounted, onBeforeUnmount } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useDeviceStream, canvasPointToLogical } from '../composables/deviceStream.ts';
import { hitTestNodeAt, selectorPreview, type AxNode } from '@crucible/shared/ax-tree';
import { useInspectTree } from '../composables/useInspectTree.ts';
import InspectOverlay from '../components/InspectOverlay.vue';

const route = useRoute();
const router = useRouter();
const udid = (route.query.udid as string) ?? '';
const sessionId = ref<string | null>(null);
const logicalW = ref<number | null>(null);
const logicalH = ref<number | null>(null);
const busy = ref(false);
const error = ref('');
const operator = ref('qa');
const actionMsg = ref(''); // transient: last action outcome

const stream = useDeviceStream();

// ── INSPECT MODE — Figma-style element inspection over the live stream ─────
// Contract: while inspect is ON, a canvas CLICK never dispatches to the
// device — it selects an element. Scroll (wheel/arrows) stays enabled in BOTH
// modes: scroll is navigation, not interaction.
const inspect = ref(false);
const hoverNode = ref<AxNode | null>(null);
const selNode = ref<AxNode | null>(null);
const hoverXY = ref<{ x: number; y: number } | null>(null); // CSS px, chip position
let rafId = 0;
let wheelAccum = 0;
let wheelBusy = false;

const tree = useInspectTree(async (sid, signal) => {
  const res = await fetch(`/api/manual/${sid}/tree`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal,
  });
  if (!res.ok) throw new Error(`tree ${res.status}`);
  return await res.json() as { nodes: AxNode[]; logicalW: number | null; logicalH: number | null };
});

function toggleInspect(): void {
  inspect.value = !inspect.value;
  if (inspect.value && sessionId.value) {
    tree.enable(sessionId.value);
    stream.onFrame(tree.feedFrame); // realign on live screen changes
  } else {
    tree.disable();
    hoverNode.value = null; selNode.value = null;
  }
}

// keyboard: i toggles, Esc deselects then exits (guarded against inputs)
function onKey(e: KeyboardEvent): void {
  if ((e.target as HTMLElement)?.matches?.('input, textarea, select')) return;
  if (e.key === 'i' && sessionId.value) { e.preventDefault(); toggleInspect(); }
  else if (e.key === 'Escape') {
    if (selNode.value) { selNode.value = null; }
    else if (inspect.value) toggleInspect();
  }
}
window.addEventListener('keydown', onKey);

// hover = MATH on the current tree (rAF-throttled), never DOM events on rects
function onCanvasMove(e: MouseEvent): void {
  if (!inspect.value) return;
  const xy = { x: e.clientX, y: e.clientY };
  if (!rafId) rafId = requestAnimationFrame(() => {
    rafId = 0;
    hoverXY.value = xy;
    const canvas = stream.canvasRef.value;
    if (!canvas || tree.state.value !== 'aligned') { hoverNode.value = null; return; }
    const { x, y } = canvasPointToLogical(canvas, xy.x, xy.y, tree.logicalW.value, tree.logicalH.value);
    hoverNode.value = hitTestNodeAt(tree.nodes.value, x, y);
  });
}

// settle driver: 1s ticker while inspect is on (quiet can pass without frames)
let settleInterval: ReturnType<typeof setInterval> | null = null;
function startSettleTicker(): void {
  if (settleInterval) return;
  settleInterval = setInterval(() => { if (inspect.value) tree.tick(Date.now()); }, 1000);
}
startSettleTicker();

// wheel scroll — BOTH modes (navigation). Threshold + single-flight.
function onCanvasWheel(e: WheelEvent): void {
  if (!sessionId.value) return;
  e.preventDefault();
  wheelAccum += e.deltaY;
  if (wheelBusy || Math.abs(wheelAccum) < 80) return;
  const dir = wheelAccum > 0 ? 'down' : 'up';
  wheelAccum = 0;
  void doScroll(dir);
}

async function doScroll(direction: 'up' | 'down' | 'left' | 'right'): Promise<void> {
  if (!sessionId.value || wheelBusy) return;
  wheelBusy = true; busy.value = true; actionMsg.value = '';
  if (inspect.value) tree.markScroll();
  try {
    const r = await api(`${sessionId.value}/scroll`, { direction });
    if (r['error']) {
      error.value = String(r['error']);
      if (String(r['code']) === 'LEASE_LOST' || String(r['code']) === 'SESSION_NOT_FOUND') endSession();
    } else {
      await fastPathFrame();
    }
  } finally { wheelBusy = false; busy.value = false; }
}

// inspect click: SELECT, never dispatch. (drive-mode click path unchanged below)
function onInspectClick(e: MouseEvent): void {
  const canvas = stream.canvasRef.value;
  if (!canvas || tree.state.value !== 'aligned') return;
  const { x, y } = canvasPointToLogical(canvas, e.clientX, e.clientY, tree.logicalW.value, tree.logicalH.value);
  selNode.value = hitTestNodeAt(tree.nodes.value, x, y); // null on empty click = deselect
}

// drawer: tap this — the ONLY deliberate device dispatch while inspecting
async function tapThis(): Promise<void> {
  const n = selNode.value;
  if (!n?.rect || !sessionId.value) return;
  const cx = n.rect.x + n.rect.width / 2;
  const cy = n.rect.y + n.rect.height / 2;
  tree.markInteraction();
  busy.value = true;
  try {
    const r = await api(`${sessionId.value}/tap`, { x: cx, y: cy });
    if (r['error']) error.value = String(r['error']);
  } finally { busy.value = false; }
}

function parentChain(n: AxNode): string[] {
  const out: string[] = [];
  let cur: AxNode | undefined = n;
  while (cur?.parentIndex !== undefined && cur.parentIndex >= 0 && out.length < 4) {
    const p = tree.nodes.value.find((m) => m.index === cur!.parentIndex);
    if (!p) break;
    out.push(p.identifier ?? p.label ?? p.type ?? '?');
    cur = p;
  }
  return out;
}

const selPreview = computed(() => (selNode.value ? selectorPreview(selNode.value) : null));

const chipName = computed(() => {
  const n = hoverNode.value;
  if (!n) return '';
  return n.identifier ?? n.label ?? n.type ?? 'element';
});
const chipXY = computed(() => {
  const canvas = stream.canvasRef.value;
  if (!canvas || !hoverXY.value) return { x: 0, y: 0 };
  const r = canvas.getBoundingClientRect();
  // clamp inside the frame; sit the chip above-left of the cursor
  return {
    x: Math.min(Math.max(hoverXY.value.x - r.left + 10, 4), Math.max(r.width - 150, 4)),
    y: Math.min(Math.max(hoverXY.value.y - r.top - 26, 4), Math.max(r.height - 22, 4)),
  };
});

const treeLabel = computed(() => {
  switch (tree.state.value) {
    case 'aligned': return `${tree.nodes.value.length} nodes`;
    case 'fetching': return 'loading tree…';
    case 'realigning': return 're-aligning…';
    case 'failed': return 'tree unavailable';
    default: return '';
  }
});

async function copySelector(): Promise<void> {
  if (!selPreview.value) return;
  try { await navigator.clipboard.writeText(selPreview.value.text); actionMsg.value = 'selector copied'; }
  catch { actionMsg.value = 'copy blocked — select the text manually'; }
}

// ── TAP: send → immediate ripple → snapshot fast-path → stream catches up ──
const ripple = ref<{ x: number; y: number; id: number } | null>(null);
let rippleTimer: ReturnType<typeof setTimeout> | null = null;

async function api(path: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`/api/manual/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
  });
  return (await res.json()) as Record<string, unknown>;
}

async function start(): Promise<void> {
  busy.value = true; error.value = '';
  try {
    const res = await fetch('/api/manual/start', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ udid, operator: operator.value }),
    });
    const body = await res.json() as { sessionId?: string; logicalW?: number | null; logicalH?: number | null; error?: string };
    if (body.sessionId) {
      sessionId.value = body.sessionId;
      logicalW.value = body.logicalW ?? null;
      logicalH.value = body.logicalH ?? null;
      stream.start(udid);
    } else error.value = body.error ?? 'failed to start';
  } finally { busy.value = false; }
}

/** After a tap/scroll the engine's screen-change detector decides when the next
 *  MJPEG frame ships (~0.5fps when idle). Pull ONE screenshot so the operator
 *  sees the effect of their action immediately; the live stream then resumes. */
async function fastPathFrame(): Promise<void> {
  if (!sessionId.value) return;
  try {
    const r = await api(`${sessionId.value}/snapshot`);
    const path = r['path'] as string | undefined;
    if (path && stream.canvasRef.value) {
      const img = new Image();
      // drawStill path: no canvas resize (resize = clear = flash) and no race
      // with the live decode loop — stream.paintStillImage stands down while
      // stream frames are flowing (it targets quiet screens by design).
      img.onload = () => stream.paintStillImage(img);
      img.src = `/api/manual-frame?path=${encodeURIComponent(path)}&t=${Date.now()}`;
    }
  } catch { /* fast-path only — stream remains the truth */ }
}

async function onTap(e: MouseEvent): Promise<void> {
  if (!sessionId.value || !(e.target instanceof HTMLCanvasElement)) return;
  if (inspect.value) { onInspectClick(e); return; } // INSPECT: select, never dispatch
  const canvas = e.target;
  // canvas holds device pixels (1284w); engine wants logical points (428w) —
  // scale through the session dims returned by /api/manual/start
  const { x, y } = canvasPointToLogical(canvas, e.clientX, e.clientY, logicalW.value, logicalH.value);
  // instant visual feedback at the tap point
  ripple.value = { x: e.clientX - canvas.getBoundingClientRect().left, y: e.clientY - canvas.getBoundingClientRect().top, id: Date.now() };
  if (rippleTimer) clearTimeout(rippleTimer);
  rippleTimer = setTimeout(() => { ripple.value = null; }, 600);
  busy.value = true;
  actionMsg.value = '';
  try {
    const r = await api(`${sessionId.value}/tap`, { x, y });
    if (r['error']) {
      error.value = String(r['error']);
      if (String(r['code']) === 'LEASE_LOST' || String(r['code']) === 'SESSION_NOT_FOUND') endSession();
    } else {
      await fastPathFrame();
    }
  } finally { busy.value = false; }
}

async function scroll(direction: string): Promise<void> {
  if (['up','down'].includes(direction)) { await doScroll(direction as 'up' | 'down'); return; }
  if (!sessionId.value || wheelBusy) return;
  wheelBusy = true; busy.value = true; actionMsg.value = '';
  if (inspect.value) tree.markScroll();
  try {
    const r = await api(`${sessionId.value}/scroll`, { direction });
    if (r['error']) {
      error.value = String(r['error']);
      if (String(r['code']) === 'LEASE_LOST' || String(r['code']) === 'SESSION_NOT_FOUND') endSession();
    } else {
      await fastPathFrame();
    }
  } finally { wheelBusy = false; busy.value = false; }
}

function endSession(): void {
  sessionId.value = null;
  if (inspect.value) toggleInspect();
  stream.stop();
}

async function finish(): Promise<void> {
  if (!sessionId.value) return;
  const id = sessionId.value;
  sessionId.value = null;
  stream.stop();
  try { await api(`${id}/finish`, { note: 'manual:dashboard' }); } catch { /* idempotent server-side */ }
}

onUnmounted(() => {
  if (rippleTimer) clearTimeout(rippleTimer);
  window.removeEventListener('keydown', onKey);
  if (settleInterval) { clearInterval(settleInterval); settleInterval = null; }
  if (rafId) cancelAnimationFrame(rafId);
  stream.stop();
  if (sessionId.value) void api(`${sessionId.value}/finish`, { note: 'manual:dashboard' }).catch(() => undefined);
});
</script>

<template>
  <div style="max-width: 480px;">
    <div class="page-header">
      <div>
        <div class="page-title">drive · {{ udid.slice(0, 8) }}…</div>
        <div class="page-desc">manual session — never counts toward AC status</div>
      </div>
      <span class="badge badge-accent">manual</span>
    </div>

    <div v-if="!sessionId" class="card">
      <div class="meta-row"><span class="k">operator</span><input v-model="operator" style="width: 160px;" /></div>
      <div style="margin-top: var(--s-3); display: flex; gap: var(--s-2);">
        <button class="btn" @click="router.back()">← back</button>
        <button class="btn btn-primary" :disabled="busy || !udid" @click="start">{{ busy ? 'starting…' : 'take control' }}</button>
      </div>
      <div v-if="error" class="meta-row" style="color: var(--color-ember);">{{ error }}</div>
    </div>

    <template v-else>
      <div class="card" style="padding: var(--s-2); position: relative;">
        <div style="position: relative;">
        <canvas :ref="stream.setCanvas" @click="onTap" @wheel.prevent="onCanvasWheel" @mousemove="onCanvasMove"
          :style="{ width: '100%', display: 'block', cursor: inspect ? 'default' : 'crosshair', borderRadius: 'var(--r-sm)', background: 'var(--color-void)', minHeight: '200px' }"
        />
        <InspectOverlay v-if="inspect" :nodes="tree.nodes.value" :logical-w="tree.logicalW.value" :logical-h="tree.logicalH.value"
          :hover="hoverNode" :selected="selNode" :visible="tree.state.value === 'aligned'" />
        <div v-if="inspect && hoverNode && tree.state.value === 'aligned'" class="hover-chip"
          :style="{ left: `${chipXY.x}px`, top: `${chipXY.y}px` }">{{ chipName }}</div>
        </div>
        <div v-if="ripple" class="tap-ripple" :style="{ left: `${ripple.x}px`, top: `${ripple.y}px` }" />
        <div v-if="stream.state.value !== 'live'" class="stream-overlay">
          <span v-if="stream.state.value === 'connecting'">connecting to device stream…</span>
          <span v-else-if="stream.state.value === 'reconnecting'">stream reconnecting…</span>
          <template v-else-if="stream.state.value === 'failed'">
            <span>{{ stream.failure.value || 'stream unavailable' }}</span>
            <button v-if="stream.retryable.value" class="btn btn-sm stream-retry" @click="stream.retry()">retry stream</button>
          </template>
        </div>
        <div style="display: flex; justify-content: space-between; align-items: baseline; margin-top: 4px; font-size: 10px; color: var(--color-steel);">
          <span>
            <template v-if="stream.state.value === 'live'">{{ stream.fps.value > 0 ? `live · ${stream.fps.value}fps` : 'live · idle (screen unchanged)' }}</template>
            <template v-else>{{ stream.state.value }}</template>
          </span>
          <span>{{ logicalW ? `${logicalW}pt logical · taps map 1:1` : 'tap anywhere on screen' }}</span>
        </div>
      </div>
      <div v-if="error" class="meta-row" style="color: var(--color-ember); margin-top: var(--s-2);">{{ error }}</div>

      <div style="display: flex; gap: var(--s-2); margin-top: var(--s-3); align-items: center;">
        <button class="btn btn-sm" :class="{ 'btn-accent': inspect }" @click="toggleInspect" :title="'inspect (i) — ' + (inspect ? 'clicks select, never tap' : '')">◎ inspect</button>
        <template v-if="inspect">
          <span class="badge" :class="tree.state.value === 'aligned' ? 'badge-ok' : 'badge-warn'">{{ treeLabel }}</span>
          <button v-if="tree.state.value === 'failed'" class="btn btn-sm" @click="tree.refresh()">retry tree</button>
        </template>
        <span style="flex: 1;"></span>
        <button class="btn btn-sm" :disabled="busy" @click="scroll('up')">↑</button>
        <button class="btn btn-sm" :disabled="busy" @click="scroll('down')">↓</button>
        <button class="btn btn-sm" :disabled="busy" @click="scroll('left')">←</button>
        <button class="btn btn-sm" :disabled="busy" @click="scroll('right')">→</button>
        <button class="btn btn-sm" @click="router.push('/')">← devices</button>
        <button class="btn btn-sm btn-danger" :disabled="busy" @click="finish">finish</button>
      </div>
      <div v-if="busy" class="meta-row" style="margin-top: var(--s-2); color: var(--color-ash);">sending…</div>

      <div v-if="inspect && selNode" class="card inspect-drawer">
        <div class="page-title" style="font-size: 13px;">{{ selNode.identifier || selNode.label || selNode.type || 'element' }}</div>
        <div class="meta-row"><span class="k">type</span><span>{{ selNode.type ?? '—' }}</span></div>
        <div class="meta-row"><span class="k">identifier</span><span style="font-family: monospace;">{{ selNode.identifier ?? '—' }}</span></div>
        <div class="meta-row"><span class="k">label</span><span>{{ selNode.label ?? '—' }}</span></div>
        <div class="meta-row" v-if="selNode.rect"><span class="k">rect</span><span style="font-family: monospace;">x{{ selNode.rect.x }} y{{ selNode.rect.y }} · {{ selNode.rect.width }}×{{ selNode.rect.height }}pt</span></div>
        <div class="meta-row"><span class="k">hittable</span><span>{{ selNode.hittable ? 'yes' : 'no' }}</span></div>
        <div class="meta-row" v-if="parentChain(selNode).length"><span class="k">path</span><span style="font-family: monospace; font-size: 10px;">{{ parentChain(selNode).join(' › ') }}</span></div>
        <div class="meta-row"><span class="k">selector</span><span style="font-family: monospace; color: var(--color-accent); ">on: {{ selPreview?.text }}</span></div>
        <div style="display: flex; gap: var(--s-2); margin-top: var(--s-2);">
          <button class="btn btn-sm" @click="copySelector">copy selector</button>
          <button class="btn btn-sm btn-primary" :disabled="busy || tree.state.value !== 'aligned' || !selNode.hittable" @click="tapThis">tap this</button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.hover-chip {
  position: absolute;
  padding: 2px 8px;
  border-radius: var(--r-sm);
  background: var(--color-void);
  color: var(--color-fog);
  font-size: 10px;
  font-family: monospace;
  border: 1px solid var(--color-steel);
  pointer-events: none;
  white-space: nowrap;
  z-index: 2;
}
.inspect-drawer { margin-top: var(--s-2); padding: var(--s-2); }
.tap-ripple {
  position: absolute;
  width: 28px; height: 28px;
  border: 2px solid var(--color-ember);
  border-radius: 50%;
  transform: translate(-50%, -50%);
  pointer-events: none;
  animation: ripple-out 0.6s ease-out forwards;
}
@keyframes ripple-out {
  from { opacity: 0.9; scale: 0.4; }
  to { opacity: 0; scale: 1.6; }
}
.stream-overlay {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, 0.55);
  color: var(--color-fog);
  font-size: var(--text-caption);
  pointer-events: none;
}
/* failed state with a retry button: stack message + action, make ONLY the
 * button clickable (canvas interactions stay dead while the stream is down) */
.stream-overlay:has(.stream-retry) { flex-direction: column; gap: var(--s-2); padding: var(--s-2); text-align: center; }
.stream-overlay .stream-retry { pointer-events: auto; }
</style>
