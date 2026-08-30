<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue';
import { useLiveEvents } from '../stores/live.ts';

interface TrafficRow {
  id: string; ts: number; mode: string; method: string; path: string;
  status: number; latency_ms: number; matched_preset_id: string | null; run_id: string | null;
}
interface PresetRow { id: string; method: string; path_pattern: string; match: string; status: number }

const live = useLiveEvents();
const traffic = ref<TrafficRow[]>([]);
const presets = ref<PresetRow[]>([]);
const mode = ref('hybrid');
const newPresetPath = ref('');
const newPresetStatus = ref(200);
const newPresetMethod = ref('GET');
const msg = ref('');

const MODE_HELP: Record<string, string> = {
  record: 'watch only — real traffic passes through and is logged',
  hybrid: 'real traffic, matched endpoints faked — default',
  intercept: 'fully fake — unmatched requests get 501',
};

// ── MITM proxy state: the actual thing the app must talk to ──
interface MitmStatus { running: boolean; port?: number }
const mitm = ref<MitmStatus>({ running: false });
const mitmBusy = ref(false);
async function loadMitm(): Promise<void> {
  try {
    const res = await fetch('/api/forge/mitm/status');
    mitm.value = (await res.json()) as MitmStatus;
  } catch { /* server unreachable — banner shows offline */ }
}
async function startMitm(): Promise<void> {
  mitmBusy.value = true;
  try {
    await fetch('/api/forge/mitm/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    await loadMitm();
    msg.value = mitm.value.running ? `proxy up on 127.0.0.1:${mitm.value.port}` : 'proxy did not come up';
  } finally { mitmBusy.value = false; }
}

// ── Simulator routing: sims inherit the HOST proxy at boot ──
interface RoutingState { enabled: boolean; service: string | null; host: string | null; port: number | null }
const routing = ref<RoutingState>({ enabled: false, service: null, host: null, port: null });
const routingBusy = ref(false);
async function loadRouting(): Promise<void> {
  try {
    routing.value = (await (await fetch('/api/forge/sim-routing')).json()) as RoutingState;
  } catch { /* ignore */ }
}
async function setRouting(on: boolean): Promise<void> {
  routingBusy.value = true;
  try {
    const res = await fetch('/api/forge/sim-routing', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: on }),
    });
    const body = await res.json() as RoutingState & { error?: string };
    if (body.error) msg.value = body.error;
    else {
      routing.value = body;
      msg.value = on
        ? `sims now route through the proxy (${body.service}) — RESTART booted simulators once to pick it up (device tile → shut down → boot)`
        : 'sims back on direct connection — restart booted simulators once';
    }
  } finally { routingBusy.value = false; }
}

async function loadTraffic(): Promise<void> {
  const res = await fetch('/api/forge/traffic?limit=100');
  traffic.value = (await res.json() as { traffic: TrafficRow[] }).traffic;
}
async function loadPresets(): Promise<void> {
  const res = await fetch('/api/forge/presets');
  presets.value = (await res.json() as { presets: PresetRow[] }).presets;
}
async function setMode(m: string): Promise<void> {
  const res = await fetch('/api/forge/mode', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: m }),
  });
  mode.value = (await res.json() as { mode: string }).mode;
}
async function freeze(row: TrafficRow): Promise<void> {
  const res = await fetch('/api/forge/presets', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      pathPattern: row.path, match: 'exact', method: row.method,
      status: row.status, createdBy: 'freeze-from-traffic',
    }),
  });
  const body = await res.json() as { id?: string; error?: string };
  msg.value = body.id ? `frozen as ${body.id}` : (body.error ?? 'freeze failed');
  await loadPresets();
}
async function addPreset(): Promise<void> {
  if (!newPresetPath.value) return;
  const res = await fetch('/api/forge/presets', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      pathPattern: newPresetPath.value, match: 'exact', method: newPresetMethod.value,
      status: newPresetStatus.value, createdBy: 'dashboard',
    }),
  });
  const body = await res.json() as { id?: string; error?: string };
  msg.value = body.id ? `preset ${body.id} created` : (body.error ?? 'failed');
  newPresetPath.value = '';
  await loadPresets();
}

// live: prepend WS traffic hits (server rows arrive via events)
const unwatch = watch(
  () => live.traffic.length,
  () => { void loadTraffic(); }, // refresh from db for full rows (cheap, bounded)
);

onMounted(() => {
  live.connect();
  void loadTraffic();
  void loadPresets();
  void loadMitm();
  void loadRouting();
});
onUnmounted(() => { unwatch(); live.release(); });
</script>

<template>
  <div>
    <div class="page-header">
      <div>
        <div class="page-title">network · traffic</div>
        <div class="page-desc">{{ traffic.length }} requests · mode: {{ mode }}<span v-if="!live.connected" style="color: var(--color-ember);"> · live offline</span></div>
      </div>
      <div style="display: flex; gap: var(--s-2); align-items: center; flex-wrap: wrap;">
        <span v-if="mitm.running" class="badge badge-accent" title="point the app's proxy at this address">proxy 127.0.0.1:{{ mitm.port }}</span>
        <button v-else class="btn btn-sm" :disabled="mitmBusy" @click="startMitm">{{ mitmBusy ? 'starting…' : 'start proxy' }}</button>
        <button
          class="btn btn-sm" :class="{ 'btn-primary': routing.enabled }" :disabled="routingBusy || (!routing.enabled && !mitm.running)"
          :title="routing.enabled ? 'sims route through the proxy (restart sims to change)' : 'route all simulator traffic through the proxy — restarts booted sims apply at next boot'"
          @click="setRouting(!routing.enabled)"
        >
          {{ routingBusy ? '…' : routing.enabled ? `sims routed${routing.service ? ` · ${routing.service}` : ''}` : 'route sims' }}
        </button>
        <button v-for="m in ['record', 'hybrid', 'intercept']" :key="m" class="btn btn-sm" :class="{ 'btn-primary': mode === m }" :title="MODE_HELP[m]" @click="setMode(m)">{{ m }}</button>
      </div>
    </div>

    <div style="display: flex; justify-content: space-between; align-items: baseline; gap: var(--s-4); margin-bottom: var(--s-4); font-size: var(--text-caption); color: var(--color-steel);">
      <span>{{ MODE_HELP[mode] ?? '' }}</span>
      <span>mode is global — it applies to every request through the proxy</span>
    </div>

    <div v-if="msg" class="meta-row">{{ msg }}</div>

    <div class="card">
      <div class="card-header">
        <span class="card-title">presets · {{ presets.length }}</span>
        <span style="font-size: var(--text-caption); color: var(--color-steel);">a preset fakes one endpoint's response</span>
      </div>
      <div v-if="presets.length === 0" class="empty" style="border: none; padding: var(--s-3);">no presets — freeze one from real traffic below, or add one here</div>
      <div v-else class="table-wrap">
        <table>
          <thead><tr><th>method</th><th>path</th><th>match</th><th>status</th></tr></thead>
          <tbody>
            <tr v-for="p in presets" :key="p.id" style="cursor: default;">
              <td>{{ p.method }}</td>
              <td>{{ p.path_pattern }}</td>
              <td style="color: var(--color-steel);">{{ p.match }}</td>
              <td>{{ p.status }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div style="display: flex; gap: var(--s-2); margin-top: var(--s-3); align-items: center;">
        <select v-model="newPresetMethod" style="width: 90px;">
          <option>GET</option><option>POST</option><option>PUT</option><option>DELETE</option><option>*</option>
        </select>
        <input v-model="newPresetPath" placeholder="/api/path" style="flex: 1;" />
        <input v-model.number="newPresetStatus" type="number" style="width: 80px;" title="HTTP status the fake response returns" />
        <button class="btn btn-sm btn-primary" @click="addPreset">add</button>
      </div>
      <div style="font-size: var(--text-caption); color: var(--color-steel); margin-top: var(--s-1);">
        need bodies, delays, or failure sequences? create presets via the API — richer editing lands later.
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <span class="card-title">traffic</span>
        <span style="font-size: var(--text-caption); color: var(--color-steel);">live — every request through the proxy</span>
      </div>
      <div v-if="traffic.length === 0" class="empty" style="border: none;">
        <div style="margin-bottom: var(--s-2); color: var(--color-fog);">no requests yet</div>
        <div style="text-align: left; display: inline-block; line-height: 1.8;">
          <b>to see traffic here:</b><br />
          1. start the proxy <span v-if="mitm.running">(running — 127.0.0.1:{{ mitm.port }})</span><br />
          2. <b>route sims</b> — points the Mac's proxy at it; then restart booted simulators (shut down → boot)<br />
          3. HTTPS needs the local CA trusted once: run <span class="mono">scripts/setup-forge-tls.command</span><br />
          4. use the app on the device — requests appear here live
        </div>
      </div>
      <div v-else class="table-wrap">
        <table>
          <thead><tr><th>time</th><th>method</th><th>path</th><th>status</th><th>latency</th><th>mode</th><th>preset</th><th></th></tr></thead>
          <tbody>
            <tr v-for="t in traffic" :key="t.id" style="cursor: default;">
              <td style="color: var(--color-steel);">{{ new Date(t.ts).toLocaleTimeString() }}</td>
              <td>{{ t.method }}</td>
              <td>{{ t.path }}</td>
              <td>
                <span class="status" :class="t.status >= 500 || t.status === 0 ? 'status-fail' : t.status >= 400 ? 'status-changes-pending' : 'status-passed'">{{ t.status }}</span>
              </td>
              <td style="color: var(--color-ash);">{{ t.latency_ms }}ms</td>
              <td style="color: var(--color-steel);">{{ t.mode }}</td>
              <td style="color: var(--color-ember); font-size: var(--text-caption);">{{ t.matched_preset_id ?? '' }}</td>
              <td>
                <button v-if="!t.matched_preset_id && t.status > 0" class="btn btn-sm" title="make this real response replay forever — future hits to this endpoint return it" @click="freeze(t)">freeze</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
