<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import NewRunModal from '../components/NewRunModal.vue';
import DeviceSidebar, { type SidebarDevice } from '../components/DeviceSidebar.vue';
import { useLiveEvents } from '../stores/live.ts';

interface DeviceRow { udid: string; name: string | null; state: string | null; platform: string | null; kind: string | null; os_version: string | null; lease_holder: string | null; lease_engine: string | null }
interface QueueRow { id: string; state: string; priority: number; requested_by: string }
interface RunRow { id: string; ticket_key: string; status: string; kind: string }

const live = useLiveEvents();
const devices = ref<DeviceRow[]>([]);
const queue = ref<QueueRow[]>([]);
const newRunOpen = ref(false);
const ticketQuery = ref('');
const powerMsg = ref('');
const lastRuns = ref<Record<string, RunRow>>({});
let poll: ReturnType<typeof setInterval> | null = null;

// ── sidebar (pushed) — the one stream mount point on the wall ──
const sidebar = ref<{ device: SidebarDevice; mode: 'watch' | 'control' } | null>(null);

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

function openSidebar(d: DeviceRow, mode: 'watch' | 'control'): void {
  if (!sidebar.value || sidebar.value.device.udid !== d.udid || sidebar.value.mode !== mode) {
    sidebar.value = {
      device: { udid: d.udid, name: d.name, os_version: d.os_version, state: d.state },
      mode,
    };
  }
}
function closeSidebar(): void { sidebar.value = null; }

// device state changed under the sidebar → refresh its state (device shut down mid-watch)
watch(
  () => devices.value.map((d) => `${d.udid}:${d.state}`).join('|'),
  (sig) => {
    if (!sidebar.value) return;
    const fresh = devices.value.find((d) => d.udid === sidebar.value?.device.udid);
    if (!fresh) { closeSidebar(); return; }
    sidebar.value = { device: { udid: fresh.udid, name: fresh.name, os_version: fresh.os_version, state: fresh.state }, mode: sidebar.value.mode };
    void sig;
  },
);

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
    // deep-links from ⌘K: /?watch=<udid> opens the sidebar in watch mode, /?new=1 opens the modal
    const q = new URLSearchParams(window.location.search);
    const w = q.get('watch');
    if (w) {
      const d = devices.value.find((x) => x.udid === w && x.state === 'Booted');
      if (d) openSidebar(d, 'watch');
    }
    if (q.get('new') === '1') newRunOpen.value = true;
    if (w || q.get('new')) window.history.replaceState({}, '', '/');
  });
  poll = setInterval(() => void load(), 2000);
});
onUnmounted(() => { if (poll) clearInterval(poll); closeSidebar(); unwatchEvents(); live.release(); });
</script>

<template>
  <div>
    <div class="page-header">
      <div>
        <div class="page-title">devices</div>
        <div class="page-desc">
          {{ booted.length }} booted · {{ devices.length }} simulators
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

    <div v-if="devices.length === 0" class="empty">no simulators — alloy poller not reporting</div>

    <!-- booted sims: compact rich table, distinct treatment, actions -->
    <template v-if="booted.length > 0">
      <div class="section-label">booted · {{ booted.length }}</div>
      <div class="card table-wrap" style="padding: 0;">
        <table>
          <thead>
            <tr>
              <th style="width: 26%;">device</th>
              <th>os</th>
              <th>lease</th>
              <th>last run</th>
              <th style="text-align: right;">actions</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="d in booted" :key="d.udid" :class="{ 'row-booted': true, 'row-active': sidebar?.device.udid === d.udid }" @click="openSidebar(d, 'watch')">
              <td>
                <div style="color: var(--color-paper);">{{ d.name ?? d.udid.slice(0, 8) }}</div>
                <div style="font-size: 10px; color: var(--color-steel);">{{ d.udid.slice(0, 8) }}…</div>
              </td>
              <td style="color: var(--color-fog);">{{ d.os_version ?? '—' }}</td>
              <td>
                <b v-if="d.lease_holder?.startsWith('manual:')" style="color: var(--color-ember);">manual</b>
                <b v-else-if="d.lease_holder">{{ d.lease_holder }}</b>
                <span v-else style="color: var(--color-steel);">free</span>
              </td>
              <td>
                <template v-if="lastRuns[d.udid]">
                  <RouterLink :to="`/runs/${lastRuns[d.udid]!.id}`" style="color: inherit;">{{ lastRuns[d.udid]!.ticket_key }}</RouterLink>
                  <span class="status" :class="`status-${lastRuns[d.udid]!.status}`" style="margin-left: 6px;">{{ lastRuns[d.udid]!.status }}</span>
                </template>
                <span v-else style="color: var(--color-steel);">—</span>
              </td>
              <td style="text-align: right; white-space: nowrap;" @click.stop>
                <button class="btn btn-sm" @click="openSidebar(d, 'watch')">watch</button>
                <button class="btn btn-sm btn-ghost" style="margin-left: 6px;" @click="openSidebar(d, 'control')">take control</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- powered-off sims: dense shelf -->
    <template v-if="shelf.length > 0">
      <div class="section-label">powered off · {{ shelf.length }}</div>
      <div class="card table-wrap" style="padding: 0;">
        <table>
          <tbody>
            <tr v-for="d in shelf" :key="d.udid">
              <td style="width: 26%;"><span style="color: var(--color-fog);">{{ d.name ?? d.udid.slice(0, 12) }}</span></td>
              <td style="color: var(--color-steel);">{{ d.os_version ?? '—' }}</td>
              <td style="text-align: right;"><button class="btn btn-sm" @click="power(d.udid, 'boot')">boot</button></td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <NewRunModal :open="newRunOpen" @close="newRunOpen = false" />
    <DeviceSidebar :device="sidebar?.device ?? null" :mode="sidebar?.mode ?? 'watch'" @close="closeSidebar" />
  </div>
</template>

<style scoped>
.row-booted td { border-bottom: 1px solid var(--color-iron); }
.row-active { background: var(--color-carbon); }
.row-booted:hover { background: var(--color-carbon); }
</style>
