<script setup lang="ts">
/** StageBezel — the single spacious device (locked sketch): stream canvas in a
 *  bezel, session chip, screen-state chip (F5 ladder), session-lost banner.
 *  Tap dispatch = the DrivePage chain (canvas→logical via session dims),
 *  inspect NEVER dispatches. Session start/finish owned by the page? No —
 *  kept here: the bezel IS the drive surface (page passes udid + stream). */
import { computed, ref, watch } from 'vue';
import { useDeviceStream, canvasPointToLogical } from '../../composables/deviceStream.ts';

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

watch(() => props.udid, (u) => {
  // switching devices: release nothing server-side (lease is per-device; the
  // active lease stays), just detach the stream + local session view
  sessionId.value = null;
  logicalW.value = null;
  lost.value = false;
  screenState.value = '—';
  if (u) stream.start(u); else stream.stop();
}, { immediate: true });

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

const sessionLabel = computed((): string | null => {
  if (!sessionId.value || !startedAt.value) return null;
  const min = Math.floor((Date.now() - startedAt.value) / 60000);
  return `MANUAL · ${min}m`;
});
defineExpose({ takeControl, release, sessionLabel, screenState, setScreenState: (s: string): void => { screenState.value = s; } });
</script>

<template>
  <div class="stage">
    <div v-if="lost" class="lost">session lost — take control again</div>
    <div class="bezel">
      <div class="screen">
        <div v-if="sessionLabel" class="session-chip">{{ sessionLabel }}</div>
        <canvas v-show="stream.state.value !== 'idle'" :ref="stream.setCanvas" @click="onTap" />
        <div v-if="stream.state.value === 'failed'" class="failbox">
          <span>{{ stream.failure.value || 'stream failed' }}</span>
          <button v-if="stream.retryable.value" type="button" @click="stream.retry()">retry</button>
        </div>
        <div v-else-if="!sessionId && stream.state.value !== 'live'" class="placeholder">no session — take control to drive</div>
        <div class="statechip">screen · {{ screenState }}</div>
      </div>
    </div>
    <div class="drivebar">
      <button v-if="!sessionId" class="primary" :disabled="busy" @click="takeControl">take control</button>
      <button v-else :disabled="busy" @click="release">release</button>
      <span v-if="error" class="err">{{ error }}</span>
    </div>
  </div>
</template>

<style scoped>
.stage { position: relative; display: grid; place-items: center; overflow: auto; grid-template-rows: 1fr auto; width: 100%; height: 100%; }
.bezel { position: relative; width: min(340px, 44vh); aspect-ratio: 340 / 700; max-height: calc(100% - 56px); background: var(--color-graphite); border: 1px solid var(--color-slate); border-radius: 16px; padding: 10px; }
.screen { position: relative; width: 100%; height: 100%; background: var(--color-void); border-radius: 4px; overflow: hidden; display: grid; place-items: center; }
.screen canvas { display: block; height: 100%; width: auto; max-width: 100%; }
.session-chip { position: absolute; top: 8px; right: 8px; z-index: 3; border: 1px solid var(--color-ember); color: var(--color-ember); background: rgba(0, 0, 0, .72); font-size: 10px; padding: 1px 6px; }
.statechip { position: absolute; bottom: 10px; left: 50%; transform: translateX(-50%); font-size: 10px; color: var(--color-fog); border: 1px solid var(--color-iron); background: rgba(0, 0, 0, .72); padding: 1px 8px; white-space: nowrap; }
.placeholder { color: var(--color-steel); font-size: var(--text-caption); }
.failbox { display: flex; flex-direction: column; gap: 8px; align-items: center; color: var(--color-paper); font-size: var(--text-caption); }
.failbox button { background: none; border: 1px solid var(--color-iron); color: var(--color-fog); padding: 2px 10px; border-radius: var(--r); cursor: pointer; font-family: inherit; font-size: var(--text-caption); }
.lost { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); z-index: 6; background: var(--color-carbon); border: 1px solid var(--color-paper); color: var(--color-paper); font-size: 11px; padding: 6px 10px; }
.drivebar { display: flex; gap: 10px; align-items: center; padding: 10px 0; }
.drivebar button { font-family: inherit; background: none; border: 1px solid var(--color-iron); color: var(--color-fog); padding: var(--s-1) var(--s-2); cursor: pointer; font-size: var(--text-caption); border-radius: var(--r); }
.drivebar button:hover:not(:disabled) { border-color: var(--color-slate); color: var(--color-paper); }
.drivebar button.primary { background: var(--color-ember); border-color: var(--color-ember); color: #000; font-weight: var(--weight-bold); }
.drivebar button:disabled { opacity: .5; cursor: default; }
.err { color: var(--color-paper); font-size: var(--text-caption); }
</style>
