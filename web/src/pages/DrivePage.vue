<script setup lang="ts">
import { ref, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useDeviceStream, canvasPointToLogical } from '../composables/deviceStream.ts';

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
      img.onload = () => {
        const canvas = stream.canvasRef.value;
        if (canvas) {
          const ctx = canvas.getContext('2d');
          if (ctx) {
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            ctx.drawImage(img, 0, 0);
          }
        }
      };
      img.src = `/api/manual-frame?path=${encodeURIComponent(path)}&t=${Date.now()}`;
    }
  } catch { /* fast-path only — stream remains the truth */ }
}

async function onTap(e: MouseEvent): Promise<void> {
  if (!sessionId.value || !(e.target instanceof HTMLCanvasElement)) return;
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
  if (!sessionId.value) return;
  busy.value = true;
  actionMsg.value = '';
  try {
    const r = await api(`${sessionId.value}/scroll`, { direction });
    if (r['error']) {
      error.value = String(r['error']);
      if (String(r['code']) === 'LEASE_LOST' || String(r['code']) === 'SESSION_NOT_FOUND') endSession();
    } else {
      await fastPathFrame();
    }
  } finally { busy.value = false; }
}

function endSession(): void {
  sessionId.value = null;
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
        <canvas :ref="stream.setCanvas" @click="onTap"
          style="width: 100%; display: block; cursor: crosshair; border-radius: var(--r-sm); background: var(--color-void); min-height: 200px;"
        />
        <div v-if="ripple" class="tap-ripple" :style="{ left: `${ripple.x}px`, top: `${ripple.y}px` }" />
        <div v-if="stream.state.value !== 'live'" class="stream-overlay">
          <span v-if="stream.state.value === 'connecting'">connecting to device stream…</span>
          <span v-else-if="stream.state.value === 'reconnecting'">stream reconnecting…</span>
          <span v-else-if="stream.state.value === 'failed'">{{ stream.failure.value || 'stream unavailable' }}</span>
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

      <div style="display: flex; gap: var(--s-2); margin-top: var(--s-3);">
        <button class="btn btn-sm" :disabled="busy" @click="scroll('up')">↑</button>
        <button class="btn btn-sm" :disabled="busy" @click="scroll('down')">↓</button>
        <button class="btn btn-sm" :disabled="busy" @click="scroll('left')">←</button>
        <button class="btn btn-sm" :disabled="busy" @click="scroll('right')">→</button>
        <span style="flex: 1;"></span>
        <button class="btn btn-sm" @click="router.push('/')">← devices</button>
        <button class="btn btn-sm btn-danger" :disabled="busy" @click="finish">finish</button>
      </div>
      <div v-if="busy" class="meta-row" style="margin-top: var(--s-2); color: var(--color-ash);">sending…</div>
    </template>
  </div>
</template>

<style scoped>
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
</style>
