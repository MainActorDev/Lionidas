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
    snapSrc.value = `/api/manual-frame?path=${encodeURIComponent(r['path'] as string)}&t=${Date.now()}`;
  } else if (r['error']) error.value = String(r['error']);
}

async function onTap(e: MouseEvent): Promise<void> {
  if (!sessionId.value || !(e.target instanceof HTMLImageElement)) return;
  const img = e.target;
  const rect = img.getBoundingClientRect();
  const x = Math.round(((e.clientX - rect.left) / rect.width) * img.naturalWidth);
  const y = Math.round(((e.clientY - rect.top) / rect.height) * img.naturalHeight);
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

onUnmounted(() => { void finish(); });
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
        <img v-if="snapSrc" :src="snapSrc" alt="device screen" @click="onTap" style="width: 100%; display: block; cursor: crosshair; border-radius: var(--r-sm);" />
        <div v-else class="empty" style="border: none;">loading screen…</div>
      </div>
      <div style="display: flex; gap: var(--s-2); margin-top: var(--s-3);">
        <button class="btn btn-sm" @click="refresh()">refresh</button>
        <button class="btn btn-sm" @click="scroll('up')">↑</button>
        <button class="btn btn-sm" @click="scroll('down')">↓</button>
        <span style="flex: 1;"></span>
        <button class="btn btn-sm btn-danger" @click="finish">finish</button>
      </div>
    </template>
  </div>
</template>
