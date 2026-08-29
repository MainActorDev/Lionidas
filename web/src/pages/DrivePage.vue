<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { useRoute } from 'vue-router';

const route = useRoute();
const udid = (route.query.udid as string) ?? '';
const sessionId = ref<string | null>(null);
const snapSrc = ref<string>('');
const busy = ref(false);
const error = ref('');
const operator = ref('qa');
const logical = ref<{ w: number | null; h: number | null }>({ w: null, h: null });

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
      await refresh();
    } else error.value = body.error ?? 'failed to start';
  } finally { busy.value = false; }
}

async function refresh(): Promise<void> {
  if (!sessionId.value) return;
  const r = await api(`${sessionId.value}/snapshot`);
  if (typeof r['path'] === 'string') {
    // serve via a signed local file? simplest: screenshot file read through evidence-less static
    snapSrc.value = `/api/manual-frame?path=${encodeURIComponent(r['path'])}`;
  } else if (r['error']) error.value = String(r['error']);
}

async function onTap(e: MouseEvent): Promise<void> {
  if (!sessionId.value || !(e.target instanceof HTMLImageElement)) return;
  const rect = e.target.getBoundingClientRect();
  const x = Math.round(((e.clientX - rect.left) / rect.width) * (logical.value.w ?? rect.width));
  const y = Math.round(((e.clientY - rect.top) / rect.height) * (logical.value.h ?? rect.height));
  busy.value = true;
  try {
    await api(`${sessionId.value}/tap`, { x, y });
    setTimeout(() => void refresh(), 600);
  } finally { busy.value = false; }
}

async function scroll(direction: string): Promise<void> {
  if (!sessionId.value) return;
  await api(`${sessionId.value}/scroll`, { direction });
  setTimeout(() => void refresh(), 600);
}

async function finish(): Promise<void> {
  if (!sessionId.value) return;
  await api(`${sessionId.value}/finish`, { note: 'manual:dashboard' });
  sessionId.value = null;
  snapSrc.value = '';
}

let ws: WebSocket | null = null;
onMounted(() => {
  // observer mode: other tabs see taps live
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/api/events`);
});
onUnmounted(() => { ws?.close(); void finish(); });
void 0;
</script>

<template>
  <main class="page">
    <header class="head">
      <h1>Drive <span class="mono dim">{{ udid.slice(0, 8) }}…</span> <span class="manual-badge">MANUAL — never counts</span></h1>
      <RouterLink to="/" class="mono dim">← wall</RouterLink>
    </header>

    <p v-if="!sessionId" class="start">
      <label class="mono">operator <input v-model="operator" /></label>
      <button :disabled="busy || !udid" @click="start">{{ busy ? 'starting…' : 'Take control' }}</button>
      <span v-if="error" class="err">{{ error }}</span>
    </p>

    <template v-else>
      <div class="screen" :class="{ busy }">
        <img v-if="snapSrc" :src="snapSrc" alt="device screen" @click="onTap" />
        <p v-else class="dim">loading screen…</p>
      </div>
      <div class="controls">
        <button @click="refresh()">Refresh</button>
        <button @click="scroll('up')">↑</button>
        <button @click="scroll('down')">↓</button>
        <button class="finish" @click="finish">Finish</button>
      </div>
    </template>
  </main>
</template>

<style scoped>
.page { padding: var(--s6); }
.head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: var(--s4); }
h1 { font-size: var(--text-base); font-weight: 600; margin: 0; display: flex; gap: var(--s2); align-items: baseline; }
.manual-badge { color: var(--amber); font-size: var(--text-xs); border: 1px solid var(--amber); border-radius: var(--radius-ctl); padding: 1px var(--s2); }
.start { display: flex; gap: var(--s3); align-items: center; }
input { background: var(--surface); border: 1px solid var(--border); color: var(--fg); border-radius: var(--radius-ctl); padding: var(--s1) var(--s2); }
.err { color: var(--fail); font-size: var(--text-sm); }
.screen { max-width: 420px; border: 1px solid var(--border); border-radius: var(--radius-card); overflow: hidden; background: var(--surface); }
.screen img { display: block; width: 100%; cursor: crosshair; }
.controls { display: flex; gap: var(--s2); margin-top: var(--s3); }
button { border: 1px solid var(--border); background: var(--surface); color: var(--fg); border-radius: var(--radius-ctl); padding: var(--s2) var(--s3); cursor: pointer; font-size: var(--text-sm); }
.finish { border-color: var(--fail); color: var(--fail); }
</style>
