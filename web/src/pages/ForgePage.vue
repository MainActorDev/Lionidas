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
});
onUnmounted(() => { unwatch(); live.release(); });
</script>

<template>
  <div>
    <div class="page-header">
      <div>
        <div class="page-title">forge · traffic</div>
        <div class="page-desc">{{ traffic.length }} requests · mode: {{ mode }}<span v-if="!live.connected" style="color: var(--color-ember);"> · live offline</span></div>
      </div>
      <div style="display: flex; gap: var(--s-2);">
        <button v-for="m in ['record', 'hybrid', 'intercept']" :key="m" class="btn btn-sm" :class="{ 'btn-primary': mode === m }" @click="setMode(m)">{{ m }}</button>
      </div>
    </div>

    <div v-if="msg" class="meta-row">{{ msg }}</div>

    <div class="card">
      <div class="card-header"><span class="card-title">presets · {{ presets.length }}</span></div>
      <div class="table-wrap">
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
        <input v-model.number="newPresetStatus" type="number" style="width: 80px;" />
        <button class="btn btn-sm btn-primary" @click="addPreset">add</button>
      </div>
    </div>

    <div class="card">
      <div class="card-header"><span class="card-title">traffic</span></div>
      <div v-if="traffic.length === 0" class="empty" style="border: none;">no requests yet — point a DEV build at the proxy or rehearse a scenario</div>
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
              <td><button v-if="!t.matched_preset_id && t.status > 0" class="btn btn-sm" @click="freeze(t)">freeze</button></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
