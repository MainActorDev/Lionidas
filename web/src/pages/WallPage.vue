<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';

interface DeviceRow {
  udid: string; name: string | null; state: string | null;
  lease_holder: string | null; lease_engine: string | null;
}
interface QueueRow { id: string; state: string; priority: number; requested_by: string }

const router = useRouter();
const devices = ref<DeviceRow[]>([]);
const queue = ref<QueueRow[]>([]);
const watching = ref<string | null>(null);
const frameSrc = ref('');
const mode = ref<'ambient' | 'focused'>((localStorage.getItem('wallMode') as 'ambient' | 'focused') ?? 'focused');
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

function leaseBadge(d: DeviceRow): string {
  if (d.lease_holder?.startsWith('manual:')) return 'MANUAL';
  if (d.lease_holder) return `lease ${d.lease_holder}`;
  return '';
}

async function watch(udid: string): Promise<void> {
  watching.value = udid;
  const refresh = async (): Promise<void> => {
    // screenshot pulse: server stores latest frame per device under artifacts/watch/<udid>.png
    const res = await fetch(`/api/devices/${udid}/watch-frame`, { method: 'POST' });
    if (res.ok) {
      const body = await res.json() as { path?: string };
      if (body.path) frameSrc.value = `/api/watch-frame?path=${encodeURIComponent(body.path)}&t=${Date.now()}`;
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

function toggleMode(): void {
  mode.value = mode.value === 'ambient' ? 'focused' : 'ambient';
  localStorage.setItem('wallMode', mode.value);
}

onMounted(() => {
  void load();
  poll = setInterval(() => void load(), 2000);
});
onUnmounted(() => { if (poll) clearInterval(poll); stopWatch(); });
</script>

<template>
  <main class="wall" :class="{ ambient: mode === 'ambient' }">
    <header v-if="mode === 'focused'" class="wall-head">
      <h1>Crucible</h1>
      <nav class="mono dim">
        <RouterLink to="/runs">runs</RouterLink>
        <RouterLink to="/baselines">baselines</RouterLink>
        <RouterLink to="/flakes">flakes</RouterLink>
        <a href="#" @click.prevent="toggleMode">ambient (A)</a>
      </nav>
    </header>
    <header v-else class="wall-head ambient-head">
      <a href="#" class="mono dim" @click.prevent="toggleMode">focused (A)</a>
    </header>

    <section class="tiles">
      <article v-for="d in devices" :key="d.udid" class="tile" :class="{ booted: d.state === 'Booted', held: Boolean(d.lease_holder) }">
        <div class="row1">
          <strong>{{ d.name ?? d.udid.slice(0, 8) }}</strong>
          <span v-if="leaseBadge(d)" class="lease" :class="{ manual: d.lease_holder?.startsWith('manual:') }">{{ leaseBadge(d) }}</span>
        </div>
        <div v-if="mode === 'focused'" class="row2 mono dim">
          {{ d.state ?? 'unknown' }}
          <span class="actions">
            <button v-if="watching !== d.udid && d.state === 'Booted'" @click="watch(d.udid)">Watch</button>
            <button v-else-if="watching === d.udid" class="off" @click="stopWatch">stop</button>
            <RouterLink v-if="d.state === 'Booted'" :to="`/drive?udid=${d.udid}`" tag="button" class="drive">Take control</RouterLink>
          </span>
        </div>
        <img v-if="watching === d.udid && frameSrc" :src="frameSrc" class="frame" alt="live frame" />
      </article>
      <article v-if="devices.length === 0" class="tile empty-state">
        <strong>No devices</strong>
        <p>Alloy poller not reporting — is the server up with a live engines config?</p>
      </article>
    </section>

    <footer v-if="mode === 'focused' && queue.length > 0" class="queue mono dim">
      queue: {{ queue.length }} waiting — {{ queue.slice(0, 3).map((q) => q.requested_by).join(', ') }}{{ queue.length > 3 ? '…' : '' }}
    </footer>
  </main>
</template>

<style scoped>
.wall { padding: var(--s6); height: 100%; overflow: auto; }
.wall-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: var(--s4); }
.wall-head h1 { font-size: var(--text-base); font-weight: 600; margin: 0; }
nav a, nav RouterLink { color: var(--fg-dim); margin-left: var(--s3); text-decoration: none; }
.tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: var(--s3); }
.tile { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-card); padding: var(--s3); }
.tile.booted { border-color: var(--pass); }
.row1 { display: flex; justify-content: space-between; align-items: baseline; gap: var(--s2); }
.lease { font-size: var(--text-xs); color: var(--fg-dim); border: 1px solid var(--border); border-radius: var(--radius-ctl); padding: 0 var(--s1); }
.lease.manual { color: var(--amber); border-color: var(--amber); }
.row2 { display: flex; justify-content: space-between; align-items: center; margin-top: var(--s2); font-size: var(--text-xs); }
.actions button, .actions :deep(button) { margin-left: var(--s1); font-size: var(--text-xs); background: none; border: 1px solid var(--border); color: var(--fg-dim); border-radius: var(--radius-ctl); padding: 1px var(--s2); cursor: pointer; }
.actions .drive { display: inline-block; margin-left: var(--s1); font-size: var(--text-xs); border: 1px solid var(--border); color: var(--fg-dim); border-radius: var(--radius-ctl); padding: 1px var(--s2); text-decoration: none; }
.frame { width: 100%; margin-top: var(--s2); border-radius: var(--radius-ctl); border: 1px solid var(--border); display: block; }
.empty-state strong { display: block; margin-bottom: var(--s1); }
.empty-state p { margin: 0; color: var(--fg-dim); font-size: var(--text-sm); }
.queue { margin-top: var(--s4); font-size: var(--text-xs); }
.ambient .tiles { max-width: 1200px; margin: 0 auto; }
.ambient-head { justify-content: flex-end; }
</style>
