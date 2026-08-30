<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';

interface DeviceRow {
  udid: string; name: string | null; state: string | null;
  lease_holder: string | null; lease_engine: string | null;
}
interface QueueRow { id: string; state: string; priority: number; requested_by: string }

const devices = ref<DeviceRow[]>([]);
const queue = ref<QueueRow[]>([]);
const watching = ref<string | null>(null);
const frameSrc = ref('');
const error = ref('');
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

async function watch(udid: string): Promise<void> {
  watching.value = udid;
  error.value = '';
  const refresh = async (): Promise<void> => {
    const res = await fetch(`/api/devices/${udid}/watch-frame`, { method: 'POST' });
    if (res.ok) {
      const body = await res.json() as { path?: string };
      if (body.path) frameSrc.value = `/api/watch-frame?path=${encodeURIComponent(body.path)}&t=${Date.now()}`;
    } else if (res.status === 409) {
      error.value = 'device no longer booted';
      stopWatch();
    }
  };
  await refresh();
  pulse = setInterval(() => void refresh(), 2500);
}

function stopWatch(): void {
  watching.value = null;
  frameSrc.value = '';
  if (pulse) clearInterval(pulse);
  pulse = null;
}

onMounted(() => {
  void load();
  poll = setInterval(() => void load(), 2000);
});
onUnmounted(() => { if (poll) clearInterval(poll); stopWatch(); });
</script>

<template>
  <div>
    <div class="page-header">
      <div>
        <div class="page-title">devices</div>
        <div class="page-desc">{{ devices.length }} known · {{ devices.filter((d) => d.state === 'Booted').length }} booted · {{ queue.length }} queued</div>
      </div>
    </div>

    <div v-if="error" class="meta-row">{{ error }}</div>

    <div v-if="devices.length === 0" class="empty">
      no devices — alloy poller not reporting
    </div>

    <div v-for="d in devices" :key="d.udid" class="card" :class="{ 'card-accent': d.state === 'Booted' }" style="display: inline-block; min-width: 280px; margin-right: var(--s-3); vertical-align: top;">
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
      <div v-if="watching === d.udid && frameSrc" style="margin-top: var(--s-2);">
        <img :src="frameSrc" alt="live frame" style="width: 100%; border: 1px solid var(--color-iron); border-radius: var(--r-sm); display: block;" />
      </div>
      <div style="display: flex; gap: var(--s-2); margin-top: var(--s-3);">
        <button v-if="watching !== d.udid && d.state === 'Booted'" class="btn btn-sm" @click="watch(d.udid)">watch</button>
        <button v-else-if="watching === d.udid" class="btn btn-sm btn-ghost" @click="stopWatch">stop</button>
        <RouterLink v-if="d.state === 'Booted'" :to="`/drive?udid=${d.udid}`" class="btn btn-sm">take control</RouterLink>
      </div>
    </div>
  </div>
</template>
