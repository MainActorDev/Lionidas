<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { useRoute } from 'vue-router';

const route = useRoute();
const udid = (route.query.udid as string) ?? '';
const sessionId = ref<string | null>(null);
const busy = ref(false);
const error = ref('');
const operator = ref('qa');

// ── LIVE CANVAS STREAM (same relay as the wall) ──
const canvasRef = ref<HTMLCanvasElement | null>(null);
let relayWs: WebSocket | null = null;
let frameCount = 0;
let lastFpsTime = Date.now();
const displayFps = ref(0);
const connected = ref(false);

function connectStream(): void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  relayWs = new WebSocket(`${proto}://${location.host}/api/stream/${udid}`);
  relayWs.binaryType = 'arraybuffer';
  relayWs.onopen = () => { connected.value = true; };
  relayWs.onclose = () => {
    connected.value = false;
    // auto-reconnect while session is live
    if (sessionId.value) setTimeout(() => { if (sessionId.value) connectStream(); }, 1500);
  };
  relayWs.onerror = () => { /* onclose fires */ };
  relayWs.onmessage = async (ev) => {
    if (typeof ev.data === 'string') return; // error — onclose handles
    const blob = new Blob([ev.data], { type: 'image/jpeg' });
    const bitmap = await createImageBitmap(blob);
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
      displayFps.value = Math.round((frameCount * 1000) / (now - lastFpsTime));
      frameCount = 0;
      lastFpsTime = now;
    }
  };
}

function disconnectStream(): void {
  if (relayWs) { relayWs.onclose = null; relayWs.close(); relayWs = null; }
  connected.value = false;
}

async function api(path: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`/api/manual/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
  });
  return (await res.json()) as Record<string, unknown>;
}

async function start(): Promise<void> {
  busy.value = true; error.value = '';
  try {
    const r = await fetch('/api/manual/start', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ udid, operator: operator.value }),
    });
    const body = await r.json() as { sessionId?: string; error?: string };
    if (body.sessionId) {
      sessionId.value = body.sessionId;
      connectStream();
    } else error.value = body.error ?? 'failed to start';
  } finally { busy.value = false; }
}

// ── TAP: send + IMMEDIATE visual feedback (no round-trip wait) ──
async function onTap(e: MouseEvent): Promise<void> {
  if (!sessionId.value || !(e.target instanceof HTMLCanvasElement)) return;
  const canvas = e.target;
  const rect = canvas.getBoundingClientRect();
  // canvas internal size vs displayed size → scale tap to device logical px
  const x = Math.round(((e.clientX - rect.left) / rect.width) * canvas.width * 2); // ×2 = half-scale relay
  const y = Math.round(((e.clientY - rect.top) / rect.height) * canvas.height * 2);
  busy.value = true;
  try {
    await api(`${sessionId.value}/tap`, { x, y });
    // NO setTimeout refresh — the stream relay pushes the next frame automatically
  } finally { busy.value = false; }
}

async function scroll(direction: string): Promise<void> {
  if (!sessionId.value) return;
  await api(`${sessionId.value}/scroll`, { direction });
  // stream pushes the frame — no manual refresh
}

async function finish(): Promise<void> {
  if (!sessionId.value) return;
  await api(`${sessionId.value}/finish`, { note: 'manual:dashboard' });
  sessionId.value = null;
  disconnectStream();
}

onUnmounted(() => { disconnectStream(); void finish(); });
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
      <div style="margin-top: var(--s-3);">
        <button class="btn btn-primary" :disabled="busy || !udid" @click="start">{{ busy ? 'starting…' : 'take control' }}</button>
      </div>
      <div v-if="error" class="meta-row" style="color: var(--color-ember);">{{ error }}</div>
    </div>

    <template v-else>
      <div class="card" style="padding: var(--s-2);">
        <canvas ref="canvasRef" @click="onTap"
          style="width: 100%; display: block; cursor: crosshair; border-radius: var(--r-sm); background: var(--color-void); min-height: 200px;"
        />
        <div style="display: flex; justify-content: space-between; align-items: baseline; margin-top: 4px; font-size: 10px; color: var(--color-steel);">
          <span>{{ connected ? `live · ${displayFps}fps` : 'stream reconnecting…' }}</span>
          <span>tap anywhere on screen</span>
        </div>
      </div>
      <div style="display: flex; gap: var(--s-2); margin-top: var(--s-3);">
        <button class="btn btn-sm" @click="scroll('up')">↑</button>
        <button class="btn btn-sm" @click="scroll('down')">↓</button>
        <button class="btn btn-sm" @click="scroll('left')">←</button>
        <button class="btn btn-sm" @click="scroll('right')">→</button>
        <span style="flex: 1;"></span>
        <button class="btn btn-sm btn-danger" @click="finish">finish</button>
      </div>
      <div v-if="busy" class="meta-row" style="margin-top: var(--s-2); color: var(--color-ash);">sending…</div>
    </template>
  </div>
</template>
