<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import NewRunModal from '../components/NewRunModal.vue';
import { useLiveEvents } from '../stores/live.ts';

interface DeviceRow { udid: string; name: string | null; state: string | null; lease_holder: string | null; lease_engine: string | null }
interface QueueRow { id: string; state: string; priority: number; requested_by: string }

const live = useLiveEvents();
const devices = ref<DeviceRow[]>([]);
const queue = ref<QueueRow[]>([]);
const watching = ref<string | null>(null);
const frameSrc = ref('');
const watchMode = ref<'stream' | 'pulse'>('stream');
const newRunOpen = ref(false);
const ticketQuery = ref('');
let poll: ReturnType<typeof setInterval> | null = null;
let pulse: ReturnType<typeof setInterval> | null = null;

async function load(): Promise<void> {
  const [d, q] = await Promise.all([
    fetch('/api/devices').then((r) => r.json()) as Promise<{ devices: DeviceRow[] }>,
    fetch('/api/queue').then((r) => r.json()) as Promise<{ queue: QueueRow[] }>,
  ]);
  devices.value = d.devices;
  queue.value = q.queue.filter((x) => x.state === 'waiting');
}
async function abortQueue(id: string): Promise<void> {
  await fetch(`/api/queue/${id}`, { method: 'DELETE' });
  await load();
}
async function openTicket(): Promise<void> {
  const key = ticketQuery.value.trim();
  if (key) window.location.href = `/tickets/${encodeURIComponent(key)}`;
}

async function watch(udid: string): Promise<void> {
  await watchCanvas(udid);
}
async function startPulse(udid: string): Promise<void> {
  watchMode.value = 'pulse';
  const refresh = async (): Promise<void> => {
    const res = await fetch(`/api/devices/${udid}/watch-frame`, { method: 'POST' });
    if (res.ok) {
      const body = await res.json() as { path?: string };
      if (body.path) frameSrc.value = `/api/watch-frame?path=${encodeURIComponent(body.path)}&t=${Date.now()}`;
    }
  };
  await refresh();
  pulse = setInterval(() => void refresh(), 2500);
}
// stream died after URL handout (server exit) → terminal for session → pulse fallback
function onFrameError(): void {
  if (watchMode.value === 'stream' && watching.value) {
    const udid = watching.value;
    stopWatch();
    watching.value = udid;
    void startPulse(udid);
  }
}

// ── LOW-LATENCY CANVAS STREAM ──
// WS binary frames → createImageBitmap (off-main-thread) → canvas.drawImage
// No multipart parser, no <img> buffering, zero queueing.
let relayWs: WebSocket | null = null;
const canvasRef = ref<HTMLCanvasElement | null>(null);
let frameCount = 0;
let lastFpsTime = Date.now();
const displayFps = ref(0);

async function watchCanvas(udid: string): Promise<void> {
  watching.value = udid;
  watchMode.value = 'stream';
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  relayWs = new WebSocket(`${proto}://${location.host}/api/stream/${udid}`);
  relayWs.binaryType = 'arraybuffer';
  relayWs.onmessage = async (ev) => {
    if (typeof ev.data === 'string') {
      // error message from the relay
      const body = JSON.parse(ev.data) as { error?: string };
      if (body.error) { relayWs?.close(); await startPulse(udid); }
      return;
    }
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
  relayWs.onclose = () => {
    if (watchMode.value === 'stream' && watching.value === udid) {
      void startPulse(udid);
    }
  };
  relayWs.onerror = () => { /* onclose handles fallback */ };
}

function stopRelay(): void {
  if (relayWs) { relayWs.onclose = null; relayWs.close(); relayWs = null; }
}
function stopWatch(): void {
  watching.value = null;
  frameSrc.value = '';
  stopRelay();
  if (pulse) clearInterval(pulse);
  pulse = null;
}

onMounted(() => {
  live.connect();
  void load();
  poll = setInterval(() => void load(), 2000);
});
onUnmounted(() => { if (poll) clearInterval(poll); stopWatch(); live.release(); });
</script>

<template>
  <div>
    <div class="page-header">
      <div>
        <div class="page-title">devices</div>
        <div class="page-desc">
          {{ devices.length }} known · {{ devices.filter((d) => d.state === 'Booted').length }} booted
          <span v-if="!live.connected" style="color: var(--color-ember);"> · live offline</span>
        </div>
      </div>
      <div style="display: flex; gap: var(--s-2); align-items: center;">
        <input v-model="ticketQuery" placeholder="ticket…" style="width: 120px;" @keydown.enter="openTicket" />
        <button class="btn btn-primary" @click="newRunOpen = true">+ new run</button>
      </div>
    </div>

    <div v-if="queue.length > 0" class="card card-accent" style="margin-bottom: var(--s-4);">
      <div class="card-header">
        <span class="card-title">queue · {{ queue.length }} waiting</span>
      </div>
      <div v-for="q in queue" :key="q.id" class="meta-row">
        <span class="k">{{ q.id }}</span>
        <b>by {{ q.requested_by }} · priority {{ q.priority }}</b>
        <button class="btn btn-sm btn-danger" style="margin-left: auto;" @click="abortQueue(q.id)">abort</button>
      </div>
    </div>

    <div v-if="devices.length === 0" class="empty">no devices — alloy poller not reporting</div>

    <div style="display: flex; flex-wrap: wrap; gap: var(--s-3);">
      <div v-for="d in devices" :key="d.udid" class="card" :class="{ 'card-accent': d.state === 'Booted' }" style="min-width: 280px; margin-bottom: 0;">
        <div class="card-header">
          <span class="card-title">{{ d.name ?? d.udid.slice(0, 8) }}</span>
          <span class="status" :class="d.state === 'Booted' ? 'status-passed' : 'status-none'">{{ d.state?.toLowerCase() ?? 'unknown' }}</span>
        </div>
        <div class="meta-row"><span class="k">udid</span><b>{{ d.udid.slice(0, 8) }}…</b></div>
        <div class="meta-row">
          <span class="k">lease</span>
          <b v-if="d.lease_holder?.startsWith('manual:')">▸ manual</b>
          <b v-else-if="d.lease_holder">{{ d.lease_holder }}</b>
          <b v-else>free</b>
        </div>
        <div v-if="watching === d.udid" style="margin-top: var(--s-2);">
          <canvas v-show="watchMode === 'stream'" ref="canvasRef" style="width: 100%; border: 1px solid var(--color-iron); border-radius: var(--r-sm); display: block;"></canvas>
          <img v-if="watchMode === 'pulse' && frameSrc" :src="frameSrc" alt="live frame" @error="onFrameError" style="width: 100%; border: 1px solid var(--color-iron); border-radius: var(--r-sm); display: block;" />
          <div v-if="watchMode === 'stream'" style="display: flex; justify-content: space-between; font-size: 10px; color: var(--color-steel); margin-top: 2px;">
            <span>live · {{ displayFps }}fps</span>
            <span>ws canvas</span>
          </div>
          <div v-if="watchMode === 'pulse'" class="badge" style="margin-top: var(--s-1);">pulse (stream unavailable)</div>
        </div>
        <div style="display: flex; gap: var(--s-2); margin-top: var(--s-3);">
          <button v-if="watching !== d.udid && d.state === 'Booted'" class="btn btn-sm" @click="watch(d.udid)">watch</button>
          <button v-else-if="watching === d.udid" class="btn btn-sm btn-ghost" @click="stopWatch">stop</button>
          <RouterLink v-if="d.state === 'Booted'" :to="`/drive?udid=${d.udid}`" class="btn btn-sm">take control</RouterLink>
        </div>
      </div>
    </div>

    <NewRunModal :open="newRunOpen" @close="newRunOpen = false" />
  </div>
</template>
