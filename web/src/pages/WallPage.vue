<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import NewRunModal from '../components/NewRunModal.vue';
import { useLiveEvents } from '../stores/live.ts';
import { useDeviceStream } from '../composables/deviceStream.ts';

interface DeviceRow { udid: string; name: string | null; state: string | null; platform: string | null; kind: string | null; lease_holder: string | null; lease_engine: string | null }
interface QueueRow { id: string; state: string; priority: number; requested_by: string }
interface RunRow { id: string; ticket_key: string; status: string; kind: string }

const live = useLiveEvents();
const devices = ref<DeviceRow[]>([]);
const queue = ref<QueueRow[]>([]);
const watching = ref<string | null>(null);
const newRunOpen = ref(false);
const ticketQuery = ref('');
const powerMsg = ref('');
const lastRuns = ref<Record<string, RunRow>>({});
let poll: ReturnType<typeof setInterval> | null = null;

const stream = useDeviceStream();

const booted = computed(() => devices.value.filter((d) => d.state === 'Booted'));
const shelf = computed(() => devices.value.filter((d) => d.state !== 'Booted'));

async function load(): Promise<void> {
  const [d, q] = await Promise.all([
    fetch('/api/devices').then((r) => r.json()) as Promise<{ devices: DeviceRow[] }>,
    fetch('/api/queue').then((r) => r.json()) as Promise<{ queue: QueueRow[] }>,
  ]);
  devices.value = d.devices;
  queue.value = q.queue.filter((x) => x.state === 'waiting');
  void loadLastRuns();
}
async function loadLastRuns(): Promise<void> {
  // one row per device: latest run touching it (for tile context)
  const res = await fetch('/api/runs?limit=40');
  const body = (await res.json()) as { runs: Array<{ id: string; ticket_key: string; status: string; kind: string; device_udid: string; started_at: number | null }> };
  const map: Record<string, { id: string; ticket_key: string; status: string; kind: string; started_at: number | null }> = {};
  for (const r of body.runs) {
    if (!map[r.device_udid] && r.kind !== 'manual') map[r.device_udid] = r;
  }
  lastRuns.value = map;
}
async function abortQueue(id: string): Promise<void> {
  await fetch(`/api/queue/${id}`, { method: 'DELETE' });
  await load();
}
async function openTicket(): Promise<void> {
  const key = ticketQuery.value.trim();
  if (key) window.location.href = `/tickets/${encodeURIComponent(key)}`;
}

function watch_(udid: string): void {
  if (watching.value === udid) { stopWatch(); return; }
  watching.value = udid;
  stream.start(udid);
}
function stopWatch(): void {
  watching.value = null;
  stream.stop();
}
// stream died terminally (relay said so) → drop back to tile-only view
watch(() => stream.state.value, (s) => {
  if (s === 'failed' && watching.value) {
    powerMsg.value = `watch failed — ${stream.failure.value}`;
    watching.value = null;
  }
});
async function power(udid: string, action: 'boot' | 'shutdown'): Promise<void> {
  powerMsg.value = `${action}ing…`;
  try {
    const res = await fetch(`/api/devices/${udid}/power`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }),
    });
    const body = await res.json() as { ok?: boolean; error?: string };
    powerMsg.value = body.ok ? `${action} sent` : (body.error ?? `${action} failed`);
    if (body.ok) setTimeout(() => { void load(); }, 1500);
  } catch { powerMsg.value = `${action} request failed`; }
}

// device.changed events nudge an immediate refresh (mirror is truth-adjacent)
const unwatchEvents = watch(
  () => live.events.length,
  () => {
    const latest = live.events[live.events.length - 1];
    if (latest && latest.type === 'device.changed') void load();
  },
);

onMounted(() => {
  live.connect();
  void load().then(() => {
    // deep-links from ⌘K: /?watch=<udid> opens the stream, /?new=1 opens the modal
    const q = new URLSearchParams(window.location.search);
    const w = q.get('watch');
    if (w && devices.value.some((d) => d.udid === w && d.state === 'Booted')) watch_(w);
    if (q.get('new') === '1') newRunOpen.value = true;
    if (w || q.get('new')) window.history.replaceState({}, '', '/');
  });
  poll = setInterval(() => void load(), 2000);
});
onUnmounted(() => { if (poll) clearInterval(poll); stopWatch(); unwatchEvents(); live.release(); });
</script>

<template>
  <div>
    <div class="page-header">
      <div>
        <div class="page-title">devices</div>
        <div class="page-desc">
          {{ booted.length }} booted · {{ devices.length }} known
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

    <div v-if="powerMsg" class="meta-row" style="margin-bottom: var(--s-2);">{{ powerMsg }}</div>

    <div v-if="devices.length === 0" class="empty">no devices — alloy poller not reporting</div>

    <div v-if="booted.length > 0" style="display: flex; flex-wrap: wrap; gap: var(--s-3); margin-bottom: var(--s-5);">
      <div v-for="d in booted" :key="d.udid" class="card" :class="{ 'card-accent': watching === d.udid }" style="min-width: 280px; margin-bottom: 0; flex: 1 1 320px; max-width: 480px;">
        <div class="card-header">
          <span class="card-title">{{ d.name ?? d.udid.slice(0, 8) }}</span>
          <span class="status" :class="d.state === 'Booted' ? 'status-passed' : 'status-none'">{{ d.state?.toLowerCase() ?? 'unknown' }}</span>
        </div>
        <div class="meta-row">
          <span class="k">kind</span>
          <b>{{ d.kind === 'simulator' ? 'simulator' : d.kind === 'device' ? 'physical' : (d.kind ?? 'unknown') }}<span v-if="d.platform && d.platform !== 'ios'"> · {{ d.platform }}</span></b>
        </div>
        <div class="meta-row">
          <span class="k">lease</span>
          <b v-if="d.lease_holder?.startsWith('manual:')">▸ manual</b>
          <b v-else-if="d.lease_holder">{{ d.lease_holder }}</b>
          <b v-else>free</b>
        </div>
        <div class="meta-row" v-if="lastRuns[d.udid]">
          <span class="k">last run</span>
          <b>
            <RouterLink :to="`/runs/${lastRuns[d.udid]!.id}`" style="color: inherit;">{{ lastRuns[d.udid]!.ticket_key }}</RouterLink>
            · <span class="status" :class="`status-${lastRuns[d.udid]!.status}`">{{ lastRuns[d.udid]!.status }}</span>
          </b>
        </div>
        <div v-if="watching === d.udid" style="margin-top: var(--s-2); position: relative;">
          <canvas v-show="stream.state.value !== 'failed'" :ref="stream.setCanvas" style="width: 100%; border: 1px solid var(--color-iron); border-radius: var(--r-sm); display: block; min-height: 120px; background: var(--color-void);"></canvas>
          <div style="display: flex; justify-content: space-between; font-size: 10px; color: var(--color-steel); margin-top: 2px;">
            <span v-if="stream.state.value === 'live'">{{ stream.fps.value > 0 ? `live · ${stream.fps.value}fps` : 'live · idle (screen unchanged)' }}</span>
            <span v-else-if="stream.state.value === 'failed'">{{ stream.failure.value || 'stream failed' }}</span>
            <span v-else>{{ stream.state.value }}…</span>
            <span>read-only</span>
          </div>
        </div>
        <div style="display: flex; gap: var(--s-2); margin-top: var(--s-3); align-items: center;">
          <button v-if="watching !== d.udid" class="btn btn-sm" @click="watch_(d.udid)">watch</button>
          <button v-else class="btn btn-sm btn-ghost" @click="stopWatch">stop</button>
          <RouterLink :to="`/drive?udid=${d.udid}`" class="btn btn-sm">take control</RouterLink>
          <span style="flex: 1;"></span>
          <button v-if="d.kind === 'simulator'" class="btn btn-sm btn-danger" @click="power(d.udid, 'shutdown')">shut down</button>
        </div>
      </div>
    </div>

    <template v-if="shelf.length > 0">
      <div class="section-label">powered off · {{ shelf.length }}</div>
      <div class="card" style="padding: var(--s-2);">
        <div v-for="d in shelf" :key="d.udid" class="meta-row" style="padding: var(--s-1) 0;">
          <span class="k" style="min-width: 140px;">{{ d.name ?? d.udid.slice(0, 12) }}</span>
          <b style="color: var(--color-steel);">{{ d.kind === 'simulator' ? 'simulator' : d.kind ?? '' }}</b>
          <span style="flex: 1;"></span>
          <button v-if="d.kind === 'simulator'" class="btn btn-sm" @click="power(d.udid, 'boot')">boot</button>
        </div>
      </div>
    </template>

    <NewRunModal :open="newRunOpen" @close="newRunOpen = false" />
  </div>
</template>
