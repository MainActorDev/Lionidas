/** Device mini-preview — a small always-on canvas riding the wrapped surface's
 *  stream through the gated proxy (watch mode), for the wall's device table.
 *  One WS per booted device the table shows; lazy-attaches only when visible
 *  (IntersectionObserver) so a long shelf costs nothing. */
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { makeAvccDecoder, type Codec } from '../composables/stream/codecs.ts';

const props = defineProps<{ udid: string }>();
const canvasEl = ref<HTMLCanvasElement | null>(null);
const live = ref(false);

let ws: WebSocket | null = null;
let codec: Codec | null = null;
let pending: ImageBitmap | VideoFrame | null = null;
let raf = 0;
let alive = false;
let visible = false;
let resolveAbort: AbortController | null = null;

function paint(): void {
  if (!alive) return;
  const c = canvasEl.value;
  if (pending && c) {
    const f = pending;
    pending = null;
    const w = (f as VideoFrame).displayWidth || (f as ImageBitmap).width;
    const h = (f as VideoFrame).displayHeight || (f as ImageBitmap).height;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const ctx = c.getContext('2d');
    if (ctx) ctx.drawImage(f, 0, 0);
    if (typeof (f as VideoFrame).close === 'function') { try { (f as VideoFrame).close(); } catch { /* ok */ } }
  }
  raf = requestAnimationFrame(paint);
}

async function connect(): Promise<void> {
  if (ws || !visible) return;
  resolveAbort = new AbortController();
  try {
    const r = await fetch(`/api/devices/${encodeURIComponent(props.udid)}/stream`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      signal: resolveAbort.signal,
    });
    if (!r.ok) return;
    const b = await r.json() as { simdeckUrl?: string };
    if (!b.simdeckUrl || !visible) return;
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${b.simdeckUrl}/stream?format=avcc&version=v2`;
    const socket = new WebSocket(url);
    ws = socket;
    socket.binaryType = 'arraybuffer';
    codec = makeAvccDecoder((frame) => {
      if (pending && typeof (pending as VideoFrame).close === 'function') { try { (pending as VideoFrame).close(); } catch { /* ok */ } }
      pending = frame;
      live.value = true;
    });
    socket.onopen = () => { alive = true; raf = requestAnimationFrame(paint); };
    socket.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data === 'string') return; // control plane noise (tolerant)
      codec?.feed(ev.data as ArrayBuffer);
    };
    socket.onclose = () => {
      ws = null; alive = false;
      if (raf) cancelAnimationFrame(raf);
      live.value = false;
      codec?.dispose(); codec = null;
      // quiet reconnect
      setTimeout(() => { if (visible) void connect(); }, 4000);
    };
    socket.onerror = () => { /* onclose follows */ };
  } catch { /* resolve raced unmount or failed — onclose/retry handles */ }
}

function disconnect(): void {
  resolveAbort?.abort();
  resolveAbort = null;
  visible = false;
  if (ws) { try { ws.close(); } catch { /* gone */ } ws = null; }
  if (raf) cancelAnimationFrame(raf);
  alive = false;
  codec?.dispose(); codec = null;
  live.value = false;
}

let io: IntersectionObserver | null = null;

onMounted(() => {
  io = new IntersectionObserver((entries) => {
    visible = entries.some((e) => e.isIntersecting);
    if (visible) void connect();
  }, { threshold: 0.05 });
  if (canvasEl.value) io.observe(canvasEl.value);
});

onBeforeUnmount(() => {
  io?.disconnect(); io = null;
  disconnect();
});

watch(() => props.udid, () => { disconnect(); visible = true; void connect(); });
</script>

<template>
  <div class="mini-preview" :class="{ live }">
    <canvas ref="canvasEl" width="0" height="0"></canvas>
    <span v-if="!live" class="mini-idle">···</span>
  </div>
</template>

<style scoped>
.mini-preview { position: relative; width: 44px; height: 76px; background: var(--color-void); border: 1px solid var(--color-iron); overflow: hidden; }
.mini-preview.live { border-color: var(--color-ember); }
.mini-preview canvas { width: 100%; height: 100%; display: block; object-fit: cover; }
.mini-idle { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--color-steel); font-size: 10px; }
</style>
