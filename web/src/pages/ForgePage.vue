<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { useLiveEvents } from '../stores/live.ts';

interface TrafficRow {
  id: string; ts: number; mode: string; method: string; host: string | null; path: string;
  status: number; latency_ms: number; matched_preset_id: string | null; run_id: string | null;
  req_sha: string | null; res_sha: string | null;
}
interface BodyInfo { sha: string; contentType: string | null; bytes: number; text: string; pretty: string | null }
interface TrafficDetail extends TrafficRow { reqBody: BodyInfo | null; resBody: BodyInfo | null }
interface PresetRow { id: string; method: string; path_pattern: string; match: string; status: number; body_path: string | null; created_by: string | null }

const live = useLiveEvents();
const traffic = ref<TrafficRow[]>([]);
const presets = ref<PresetRow[]>([]);
const mode = ref('hybrid');
const msg = ref('');
const search = ref('');
const selected = ref<TrafficDetail | null>(null);
const detailSide = ref<'res' | 'req'>('res');
const savingPreset = ref(false);

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

// ── Simulator routing ──
interface RoutingState { enabled: boolean; service: string | null; host: string | null; port: number | null; caReady?: boolean; trustedSims?: number }
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
    const body = await res.json() as RoutingState & { error?: string; trustedSims?: number };
    if (body.error) msg.value = body.error;
    else {
      routing.value = body;
      msg.value = on
        ? `routed + CA trusted on ${body.trustedSims ?? 0} sims (${body.service}) — RESTART booted simulators once (shut down → boot), then relaunch the app`
        : 'sims back on direct connection — restart booted simulators once';
    }
  } finally { routingBusy.value = false; }
}

async function loadTraffic(): Promise<void> {
  const q = search.value.trim() ? `?q=${encodeURIComponent(search.value.trim())}&limit=200` : '?limit=200';
  const res = await fetch(`/api/forge/traffic${q}`);
  traffic.value = (await res.json() as { traffic: TrafficRow[] }).traffic;
}
let searchTimer: ReturnType<typeof setTimeout> | null = null;
watch(search, () => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void loadTraffic(), 250);
});
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

async function openDetail(t: TrafficRow): Promise<void> {
  selected.value = null;
  const res = await fetch(`/api/forge/traffic/${t.id}`);
  if (res.ok) selected.value = (await res.json()) as TrafficDetail;
}

/** save as preset: freeze the captured response — future hits to this exact
 *  endpoint replay it verbatim (status + content-type + body). */
async function saveAsPreset(): Promise<void> {
  if (!selected.value || savingPreset.value) return;
  savingPreset.value = true;
  try {
    const res = await fetch(`/api/forge/traffic/${selected.value.id}/save-preset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const b = (await res.json()) as { id?: string; error?: string };
    msg.value = b.id ? `preset ${b.id} — this endpoint now replays the captured response` : (b.error ?? 'failed');
    if (b.id) { await loadPresets(); if (selected.value) await openDetail(selected.value); }
  } finally { savingPreset.value = false; }
}
async function deletePreset(id: string): Promise<void> {
  await fetch(`/api/forge/presets/${id}`, { method: 'DELETE' });
  await loadPresets();
}

const detailBody = computed((): BodyInfo | null => {
  if (!selected.value) return null;
  return detailSide.value === 'res' ? selected.value.resBody : selected.value.reqBody;
});

const unwatch = watch(
  () => live.traffic.length,
  () => { void loadTraffic(); },
);

onMounted(() => {
  live.connect();
  void loadTraffic();
  void loadPresets();
  void loadMitm();
  void loadRouting();
});
onUnmounted(() => { unwatch(); live.release(); if (searchTimer) clearTimeout(searchTimer); });
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
      <span v-if="routing.enabled && !mitm.running" style="color: var(--color-ember);">proxy down — internet restored, click start proxy + route sims again</span>
      <span v-else>mode is global — it applies to every request through the proxy</span>
    </div>

    <div v-if="msg" class="meta-row">{{ msg }}</div>

    <div class="card">
      <div class="card-header">
        <span class="card-title">presets · {{ presets.length }}</span>
        <span style="font-size: var(--text-caption); color: var(--color-steel);">a preset fakes one endpoint — 'save as preset' on a request below captures its real response</span>
      </div>
      <div v-if="presets.length === 0" class="empty" style="border: none; padding: var(--s-3);">no presets — open a request below and save as preset</div>
      <div v-else class="table-wrap">
        <table>
          <thead><tr><th>method</th><th>path</th><th>status</th><th>body</th><th>by</th><th></th></tr></thead>
          <tbody>
            <tr v-for="p in presets" :key="p.id" style="cursor: default;">
              <td>{{ p.method }}</td>
              <td style="max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" :title="p.path_pattern">{{ p.path_pattern }}</td>
              <td>{{ p.status }}</td>
              <td style="color: var(--color-steel);">{{ p.body_path ? '✓' : '—' }}</td>
              <td style="color: var(--color-steel);">{{ p.created_by }}</td>
              <td><button class="btn btn-sm btn-ghost" @click="deletePreset(p.id)">✕</button></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <span class="card-title">traffic</span>
        <input
          v-model="search" placeholder="search host or path…" style="margin-left: auto; width: 240px;"
          title="server-side filter on host and path"
        />
      </div>
      <div v-if="traffic.length === 0" class="empty" style="border: none;">
        <div style="margin-bottom: var(--s-2); color: var(--color-fog);">no requests{{ search ? ' matching the filter' : ' yet' }}</div>
        <div v-if="!search" style="text-align: left; display: inline-block; line-height: 1.8;">
          <b>to see traffic here:</b><br />
          1. start the proxy <span v-if="mitm.running">(running — 127.0.0.1:{{ mitm.port }})</span><br />
          2. <b>route sims</b> — sets the Mac's proxy + installs the CA into every sim's trust store; then restart booted simulators (shut down → boot)<br />
          3. use the app on the device — HTTP and HTTPS requests appear here live
        </div>
      </div>
      <div v-else class="table-wrap">
        <table>
          <thead><tr><th>time</th><th>method</th><th>host</th><th>path</th><th>status</th><th>latency</th><th>req</th><th>res</th><th>preset</th></tr></thead>
          <tbody>
            <tr
              v-for="t in traffic" :key="t.id"
              :class="{ 'row-selected': selected?.id === t.id }"
              style="cursor: pointer;"
              @click="openDetail(t)"
            >
              <td style="color: var(--color-steel); white-space: nowrap;">{{ new Date(t.ts).toLocaleTimeString() }}</td>
              <td>{{ t.method }}</td>
              <td style="color: var(--color-steel); max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" :title="t.host ?? ''">{{ t.host }}</td>
              <td style="max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" :title="t.path">{{ t.path }}</td>
              <td>
                <span class="status" :class="t.status >= 500 || t.status === 0 ? 'status-fail' : t.status >= 400 ? 'status-changes-pending' : 'status-passed'">{{ t.status }}</span>
              </td>
              <td style="color: var(--color-ash);">{{ t.latency_ms }}ms</td>
              <td style="color: var(--color-steel); font-size: var(--text-caption);">{{ t.req_sha ? '●' : '' }}</td>
              <td style="color: var(--color-steel); font-size: var(--text-caption);">{{ t.res_sha ? '●' : '' }}</td>
              <td style="color: var(--color-ember); font-size: var(--text-caption);">{{ t.matched_preset_id ?? '' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- detail pane -->
    <div v-if="selected" class="card detail-card">
      <div class="card-header">
        <span class="card-title" style="font-family: var(--font-mono, monospace);">{{ selected.method }} {{ selected.host }}{{ selected.path }}</span>
        <span class="status" :class="selected.status >= 500 || selected.status === 0 ? 'status-fail' : selected.status >= 400 ? 'status-changes-pending' : 'status-passed'">{{ selected.status }}</span>
        <span style="font-size: var(--text-caption); color: var(--color-steel);">{{ selected.latency_ms }}ms · {{ selected.mode }}</span>
        <button
          v-if="!selected.matched_preset_id && selected.res_sha"
          class="btn btn-sm btn-primary" :disabled="savingPreset" style="margin-left: auto;"
          title="future hits to this exact endpoint return this captured response — status, headers, body"
          @click="saveAsPreset"
        >{{ savingPreset ? 'saving…' : 'save as preset' }}</button>
        <span v-else-if="selected.matched_preset_id" style="margin-left: auto; color: var(--color-ember); font-size: var(--text-caption);">served by {{ selected.matched_preset_id }}</span>
        <button class="btn btn-sm btn-ghost" :style="{ marginLeft: selected.matched_preset_id || !selected.res_sha ? 'auto' : undefined }" @click="selected = null">✕</button>
      </div>
      <div class="detail-tabs">
        <button class="btn btn-sm" :class="{ 'btn-primary': detailSide === 'res' }" @click="detailSide = 'res'">response</button>
        <button class="btn btn-sm" :class="{ 'btn-primary': detailSide === 'req' }" @click="detailSide = 'req'">request</button>
        <span v-if="detailBody" style="font-size: var(--text-caption); color: var(--color-steel); align-self: center;">{{ detailBody.contentType }} · {{ detailBody.bytes }}B</span>
      </div>
      <pre v-if="detailBody" class="detail-body">{{ detailBody.pretty ?? detailBody.text }}</pre>
      <div v-else style="color: var(--color-steel); padding: var(--s-3); font-size: var(--text-caption);">
        no {{ detailSide === 'res' ? 'response' : 'request' }} body captured (empty, binary, or over the 256KB capture bound)
      </div>
    </div>
  </div>
</template>

<style scoped>
.row-selected { background: color-mix(in srgb, var(--color-ember) 8%, transparent); }
.detail-card { border-color: var(--color-ash); }
.detail-tabs { display: flex; gap: var(--s-2); padding: var(--s-2) var(--s-3) 0; align-items: center; }
.detail-body {
  margin: var(--s-2) var(--s-3) var(--s-3);
  padding: var(--s-3);
  background: var(--color-void, #000);
  border: 1px solid var(--color-iron);
  border-radius: 4px;
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  line-height: 1.5;
  max-height: 400px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
