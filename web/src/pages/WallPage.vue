<script setup lang="ts">
import PageHeader from '../components/PageHeader.vue';
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import DeviceSidebar, { type SidebarDevice } from '../components/DeviceSidebar.vue';
import DeviceMiniPreview from '../components/DeviceMiniPreview.vue';
import { useLiveEvents } from '../stores/live.ts';

interface DeviceRow { udid: string; name: string | null; state: string | null; platform: string | null; kind: string | null; os_version: string | null; resolution: string | null; lease_holder: string | null; lease_engine: string | null; lease_display?: string | null; pinned?: boolean; lastUsed?: number | null; memoryRss?: number | null }
interface QueueRow { id: string; state: string; priority: number; requested_by: string }
interface RunRow { id: string; ticket_key: string; status: string; kind: string }

const live = useLiveEvents();
const devices = ref<DeviceRow[]>([]);
const queue = ref<QueueRow[]>([]);
const lastRuns = ref<Record<string, RunRow>>({});
let poll: ReturnType<typeof setInterval> | null = null;

// ── per-row pending power state (no global message bar) ──
// udid → 'boot' | 'shutdown' | 'restart' while the request is in flight /
// awaiting the poller's state confirmation; cleared by device.changed or timeout
type PowerAction = 'boot' | 'shutdown' | 'restart';
const pending = ref(new Map<string, PowerAction>());
const PENDING_TIMEOUT_MS = 90_000;
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
function setPending(udid: string, action: PowerAction): void {
  clearPending(udid);
  pending.value.set(udid, action);
  // reactivity through Map mutation: force new ref identity
  pending.value = new Map(pending.value);
  pendingTimers.set(udid, setTimeout(() => clearPending(udid), PENDING_TIMEOUT_MS));
}
function clearPending(udid: string): void {
  if (pending.value.delete(udid)) pending.value = new Map(pending.value);
  const t = pendingTimers.get(udid);
  if (t) { clearTimeout(t); pendingTimers.delete(udid); }
}
function isPending(udid: string): PowerAction | undefined { return pending.value.get(udid); }

// ── sidebar (pushed) — the one stream mount point on the wall ──
const sidebar = ref<{ device: SidebarDevice } | null>(null);
/** udids with a live run (take-control blocked state in the sidebar) */
const runActiveUdids = ref(new Set<string>());
const runActiveSet = computed(() => runActiveUdids.value);
function leaseInfoFor(udid: string | undefined): string | null {
  if (!udid) return null;
  return devices.value.find((d) => d.udid === udid)?.lease_display ?? null;
}

const booted = computed(() => devices.value.filter((d) => d.state === 'Booted'));
// pinned ∧ not booted — booted pins live in the booted table like everyone else
const pinnedShelf = computed(() => devices.value.filter((d) => d.pinned && d.state !== 'Booted'));
const shelf = computed(() => devices.value.filter((d) => !d.pinned && d.state !== 'Booted'));
/** fleet host memory of booted sims (bytes) — the wall's running cost */
const fleetMem = computed(() => booted.value.reduce((s, d) => s + (d.memoryRss ?? 0), 0));

function fmtBytes(b: number | null | undefined): string {
  if (b == null || b <= 0) return '—';
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  const mb = b / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}
function timeAgo(ts: number | null | undefined): string {
  if (ts == null) return '';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

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

async function togglePin(d: DeviceRow): Promise<void> {
  const on = !d.pinned;
  devices.value = devices.value.map((x) => (x.udid === d.udid ? { ...x, pinned: on } : x)); // optimistic
  const res = await fetch(`/api/devices/${d.udid}/pin`, { method: on ? 'PUT' : 'DELETE' });
  if (!res.ok) devices.value = devices.value.map((x) => (x.udid === d.udid ? { ...x, pinned: !on } : x)); // revert
}

function openSidebar(d: DeviceRow): void {
  if (!sidebar.value || sidebar.value.device.udid !== d.udid) {
    sidebar.value = { device: { udid: d.udid, name: d.name, os_version: d.os_version, state: d.state } };
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
    sidebar.value = { device: { udid: fresh.udid, name: fresh.name, os_version: fresh.os_version, state: fresh.state } };
    void sig;
  },
);

async function power(udid: string, action: PowerAction): Promise<void> {
  setPending(udid, action);
  try {
    const res = await fetch(`/api/devices/${udid}/power`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }),
    });
    const body = await res.json() as { ok?: boolean; error?: string };
    if (!body.ok) { clearPending(udid); console.warn(`power ${action} failed:`, body.error); return; }
    // ok=true: the engine accepted. Wait for the poller to confirm the state
    // flip — pending clears in the device.changed watcher (timeout as backstop).
    setTimeout(() => void load(), 1500);
  } catch { clearPending(udid); }
}

// device.changed events nudge an immediate refresh (mirror is truth-adjacent)
const unwatchEvents = watch(
  () => live.events.length,
  () => {
    const latest = live.events[live.events.length - 1];
    if (latest && latest.type === 'device.changed') {
      void load();
      // state confirmation for any pending power action on this device
      const udid = typeof latest.payload['udid'] === 'string' ? latest.payload['udid'] : null;
      if (udid && pending.value.has(udid)) {
        const row = devices.value.find((d) => d.udid === udid);
        const wants = pending.value.get(udid);
        // boot/restart confirmed when Booted; shutdown when not-Booted
        if (row && ((wants === 'shutdown') !== (row.state === 'Booted'))) clearPending(udid);
      }
    }
    if (latest && latest.type === 'run.started' && typeof latest.payload['udid'] === 'string') {
      const s2 = new Set(runActiveUdids.value); s2.add(latest.payload['udid']); runActiveUdids.value = s2;
    }
    if (latest && latest.type === 'run.finished' && typeof latest.payload['udid'] === 'string') {
      const s2 = new Set(runActiveUdids.value); s2.delete(latest.payload['udid']); runActiveUdids.value = s2;
    }
  },
);

onMounted(() => {
  live.connect();
  void load().then(() => {
    // deep-link from ⌘K: /?watch=<udid> opens the sidebar in watch mode
    const q = new URLSearchParams(window.location.search);
    const w = q.get('watch');
    if (w) {
      const d = devices.value.find((x) => x.udid === w && x.state === 'Booted');
      if (d) openSidebar(d);
      window.history.replaceState({}, '', '/');
    }
  });
  poll = setInterval(() => void load(), 2000);
});
onUnmounted(() => {
  if (poll) clearInterval(poll);
  for (const t of pendingTimers.values()) clearTimeout(t);
  closeSidebar(); unwatchEvents(); live.release();
});
</script>

<template>
  <div>
    <PageHeader title="devices">
      <span class="ph-desc">
        {{ booted.length }} booted · {{ devices.length }} simulators<template v-if="fleetMem > 0"> · {{ fmtBytes(fleetMem) }}</template>
        <span v-if="!live.connected" style="color: var(--color-ember);"> · live offline</span>
      </span>
    </PageHeader>

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

    <div v-if="devices.length === 0" class="empty">no simulators — alloy poller not reporting</div>

    <!-- booted sims: compact rich table, distinct treatment, actions -->
    <template v-if="booted.length > 0">
      <div class="section-label">booted · {{ booted.length }}</div>
      <div class="card table-wrap" style="padding: 0;">
        <table>
          <thead>
            <tr>
              <th style="width: 52px;">live</th>
              <th style="width: 24%;">device</th>
              <th>os</th>
              <th>mem</th>
              <th>lease</th>
              <th>last run</th>
              <th style="text-align: right;">actions</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="d in booted" :key="d.udid" :class="{ 'row-booted': true, 'row-active': sidebar?.device.udid === d.udid }" @click="openSidebar(d)">
              <td @click.stop><DeviceMiniPreview :udid="d.udid" /></td>
              <td>
                <div style="color: var(--color-paper);">
                  {{ d.name ?? d.udid.slice(0, 8) }}<button class="pin" :class="{ on: d.pinned }" :title="d.pinned ? 'unpin — remove from pinned' : 'pin — keep at hand'" @click.stop="togglePin(d)">{{ d.pinned ? '★' : '☆' }}</button>
                </div>
                <div style="font-size: 10px; color: var(--color-steel); user-select: text;">{{ d.udid }}</div>
              </td>
              <td style="color: var(--color-paper);">{{ d.os_version ?? '—' }}</td>
              <td :style="{ color: (d.memoryRss ?? 0) > 1024 * 1024 * 1024 ? 'var(--color-ember)' : 'var(--color-fog)' }" title="host memory: every process referencing this device">{{ fmtBytes(d.memoryRss) }}</td>
              <td>
                <b v-if="d.lease_holder?.startsWith('manual:')" style="color: var(--color-ember);" :title="d.lease_display ?? 'manual'">{{ d.lease_display && d.lease_display !== 'manual' ? d.lease_display : 'manual' }}</b>
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
                <button class="btn btn-sm" @click="openSidebar(d)">drive</button>
                <button class="btn btn-sm" style="margin-left: 6px;" :disabled="isPending(d.udid) !== undefined" @click="power(d.udid, 'restart')">{{ isPending(d.udid) === 'restart' ? 'restarting…' : 'restart' }}</button>
                <button class="btn btn-sm btn-danger" style="margin-left: 6px;" :disabled="isPending(d.udid) !== undefined" @click="power(d.udid, 'shutdown')">{{ isPending(d.udid) === 'shutdown' ? 'shutting down…' : 'shut down' }}</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- pinned ∧ powered-off: the at-hand shelf (booted pins ride the booted table) -->
    <template v-if="pinnedShelf.length > 0">
      <div class="section-label">pinned · {{ pinnedShelf.length }}</div>
      <div class="card table-wrap" style="padding: 0;">
        <table>
          <tbody>
            <tr v-for="d in pinnedShelf" :key="d.udid">
              <td style="width: 24%;">
                <div style="color: var(--color-fog);">
                  {{ d.name ?? d.udid.slice(0, 12) }}<button class="pin on" title="unpin" @click.stop="togglePin(d)">★</button>
                </div>
                <div style="font-size: 10px; color: var(--color-steel); user-select: text;">{{ d.udid }}</div>
              </td>
              <td style="color: var(--color-paper);">{{ d.os_version ?? '—' }}</td>
              <td v-if="d.lastUsed != null" style="color: var(--color-steel);" title="last time this device ran anything (run or manual session)">{{ timeAgo(d.lastUsed) }}</td>
              <td v-else style="color: var(--color-steel);">never used</td>
              <td style="text-align: right;"><button class="btn btn-sm" :disabled="isPending(d.udid) !== undefined" @click="power(d.udid, 'boot')">{{ isPending(d.udid) === 'boot' ? 'booting…' : 'boot' }}</button></td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- powered-off sims: dense shelf (pinned devices excluded — they have their own) -->
    <template v-if="shelf.length > 0">
      <div class="section-label">powered off · {{ shelf.length }}</div>
      <div class="card table-wrap" style="padding: 0;">
        <table>
          <tbody>
            <tr v-for="d in shelf" :key="d.udid">
              <td style="width: 24%;">
                <div style="color: var(--color-fog);">
                  {{ d.name ?? d.udid.slice(0, 12) }}<button class="pin" :class="{ on: d.pinned }" :title="d.pinned ? 'unpin' : 'pin — keep at hand'" @click.stop="togglePin(d)">{{ d.pinned ? '★' : '☆' }}</button>
                </div>
                <div style="font-size: 10px; color: var(--color-steel); user-select: text;">{{ d.udid }}</div>
              </td>
              <td style="color: var(--color-paper);">{{ d.os_version ?? '—' }}</td>
              <td v-if="d.lastUsed != null" style="color: var(--color-steel);">{{ timeAgo(d.lastUsed) }}</td>
              <td v-else style="color: var(--color-steel);">never used</td>
              <td style="text-align: right;"><button class="btn btn-sm" :disabled="isPending(d.udid) !== undefined" @click="power(d.udid, 'boot')">{{ isPending(d.udid) === 'boot' ? 'booting…' : 'boot' }}</button></td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <DeviceSidebar :device="sidebar?.device ?? null" :lease-display="leaseInfoFor(sidebar?.device?.udid)" :run-active="runActiveSet.has(sidebar?.device?.udid ?? '')" @close="closeSidebar" />
  </div>
</template>

<style scoped>
.row-booted td { border-bottom: 1px solid var(--color-iron); }
.row-active { background: var(--color-carbon); }
.row-booted:hover { background: var(--color-carbon); }
.pin {
  background: none; border: none; cursor: pointer; padding: 0 0 0 6px;
  color: var(--color-pewter); font-size: 11px; line-height: 1; vertical-align: baseline;
  transition: color var(--t);
}
.pin:hover { color: var(--color-fog); }
.pin.on { color: var(--color-ember); }
</style>
