<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { useLiveEvents } from '../stores/live.ts';
import PresetEditorModal from '../components/PresetEditorModal.vue';

interface TrafficRow {
  id: string; ts: number; mode: string; method: string; host: string | null; path: string;
  status: number; latency_ms: number; matched_preset_id: string | null; run_id: string | null;
  req_sha: string | null; res_sha: string | null;
}
interface BodyInfo { sha: string; contentType: string | null; bytes: number; text: string; pretty: string | null }
interface TrafficDetail extends TrafficRow { reqBody: BodyInfo | null; resBody: BodyInfo | null }
interface PresetRow { id: string; method: string; path_pattern: string; match: string; status: number; body_path: string | null; created_by: string | null }
interface ScenarioRow { id: string; name: string; description: string | null; immutable_since: number | null }
interface ScenarioMember { preset_id: string; enabled: number; method: string; path_pattern: string; status: number }

const live = useLiveEvents();
const traffic = ref<TrafficRow[]>([]);
const presets = ref<PresetRow[]>([]);
const scenarios = ref<ScenarioRow[]>([]);
const mode = ref('hybrid');
const msg = ref('');
const search = ref('');
const selected = ref<TrafficDetail | null>(null);
const detailSide = ref<'res' | 'req'>('res');
const savingPreset = ref(false);

// ── M3: preset editor + scenario manager ──
const editingPreset = ref<string | null>(null);
const scnCreating = ref(false);
const scnNewName = ref('');
const scnMembersOpen = ref<string | null>(null);
const scnMembers = ref<ScenarioMember[]>([]);
const scnMemberBusy = ref(false);
const scnRenaming = ref<string | null>(null);
const scnRenameText = ref('');
const scnConfirmDelete = ref<string | null>(null);

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

// ── M3 scenario manager ──
async function loadScenarios(): Promise<void> {
  const res = await fetch('/api/forge/scenarios');
  scenarios.value = (await res.json() as { scenarios: ScenarioRow[] }).scenarios;
}
async function createScenario(): Promise<void> {
  const name = scnNewName.value.trim();
  if (!name) return;
  const res = await fetch('/api/forge/scenarios', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const b = (await res.json()) as { id?: string; error?: string };
  if (b.id) {
    scnNewName.value = '';
    scnCreating.value = false;
    await loadScenarios();
    await openMembers(b.id); // straight into membership editing
  } else msg.value = b.error ?? 'create failed';
}
async function renameScenario(id: string): Promise<void> {
  const name = scnRenameText.value.trim();
  if (!name) return;
  const res = await fetch(`/api/forge/scenarios/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
  });
  const b = (await res.json()) as { ok?: boolean; error?: string };
  if (!b.ok) msg.value = b.error ?? 'rename failed';
  scnRenaming.value = null;
  await loadScenarios();
}
async function deleteScenario(id: string): Promise<void> {
  const res = await fetch(`/api/forge/scenarios/${id}`, { method: 'DELETE' });
  const b = (await res.json()) as { ok?: boolean; error?: string };
  if (!b.ok) msg.value = b.error ?? 'delete failed';
  scnConfirmDelete.value = null;
  if (scnMembersOpen.value === id) scnMembersOpen.value = null;
  await loadScenarios();
}
async function openMembers(id: string): Promise<void> {
  scnMembersOpen.value = scnMembersOpen.value === id ? null : id;
  if (scnMembersOpen.value !== id) return;
  const res = await fetch(`/api/forge/scenarios/${id}`);
  if (!res.ok) { msg.value = 'scenario not found'; await loadScenarios(); return; }
  scnMembers.value = ((await res.json()) as { members: ScenarioMember[] }).members;
}
async function saveMembers(id: string): Promise<void> {
  scnMemberBusy.value = true;
  try {
    const members = scnMembers.value.map((m) => ({ presetId: m.preset_id, enabled: m.enabled === 1 }));
    const res = await fetch(`/api/forge/scenarios/${id}/members`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ members }),
    });
    const b = (await res.json()) as { ok?: boolean; error?: string };
    if (!b.ok) msg.value = b.error ?? 'members save failed';
    else msg.value = `scenario saved — ${members.length} member${members.length === 1 ? '' : 's'}`;
  } finally { scnMemberBusy.value = false; }
}
async function toggleMember(m: ScenarioMember): Promise<void> {
  m.enabled = m.enabled === 1 ? 0 : 1;
}
function addPresetToMembers(p: PresetRow): void {
  if (!scnMembers.value.some((m) => m.preset_id === p.id)) {
    scnMembers.value = [{ preset_id: p.id, enabled: 1, method: p.method, path_pattern: p.path_pattern, status: p.status }, ...scnMembers.value];
  }
}
function removeMember(idx: number): void {
  scnMembers.value.splice(idx, 1);
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
  void loadScenarios();
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
        <span style="font-size: var(--text-caption); color: var(--color-steel);">a preset fakes one endpoint — 'save as preset' on a request below captures its real response; edit rewrites what it serves</span>
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
              <td style="white-space: nowrap;">
                <button class="btn btn-sm" @click="editingPreset = p.id">edit</button>
                <button class="btn btn-sm btn-ghost" style="margin-left: 4px;" @click="deletePreset(p.id)">✕</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- M3: scenario manager — named groups of presets picked at run time -->
    <div class="card">
      <div class="card-header">
        <span class="card-title">scenarios · {{ scenarios.length }}</span>
        <span style="font-size: var(--text-caption); color: var(--color-steel);">a scenario is a named set of presets — pick it when running a test case to fake those endpoints for that run only</span>
        <button class="btn btn-sm" style="margin-left: auto;" @click="scnCreating = !scnCreating">+ scenario</button>
      </div>
      <div v-if="scnCreating" class="meta-row" style="padding: var(--s-2) var(--s-3);">
        <span class="k">name</span>
        <input v-model="scnNewName" placeholder="e.g. tariff api down" style="flex: 1;" @keydown.enter="createScenario" />
        <button class="btn btn-sm btn-primary" :disabled="!scnNewName.trim()" @click="createScenario">create</button>
        <button class="btn btn-sm" @click="scnCreating = false">cancel</button>
      </div>
      <div v-if="scenarios.length === 0" class="empty" style="border: none; padding: var(--s-3); text-align: left;">
        no scenarios yet —
        1. create one above,
        2. check presets into it,
        3. pick it on the test cases page when playing
      </div>
      <div v-else>
        <div v-for="s in scenarios" :key="s.id" class="scn-row">
          <template v-if="scnRenaming === s.id">
            <input v-model="scnRenameText" style="flex: 1;" @keydown.enter="renameScenario(s.id)" @keydown.esc="scnRenaming = null" />
            <button class="btn btn-sm btn-primary" @click="renameScenario(s.id)">save</button>
            <button class="btn btn-sm" @click="scnRenaming = null">cancel</button>
          </template>
          <template v-else>
            <span style="color: var(--color-paper);">{{ s.name }}</span>
            <span v-if="s.immutable_since" class="badge" title="used by at least one run before — membership edits apply from the next play">used</span>
            <span style="flex: 1;"></span>
            <span v-if="scnConfirmDelete === s.id" style="font-size: var(--text-caption); color: var(--color-ember);">
              saved plans referencing it fall back to live traffic —
              <a style="text-decoration: underline; cursor: pointer;" @click="deleteScenario(s.id)">delete</a> /
              <a style="text-decoration: underline; cursor: pointer;" @click="scnConfirmDelete = null">keep</a>
            </span>
            <span v-else class="scn-actions">
              <button class="btn btn-sm" @click="openMembers(s.id)">{{ scnMembersOpen === s.id ? 'close' : 'presets' }}</button>
              <button class="btn btn-sm" @click="scnRenaming = s.id; scnRenameText = s.name">rename</button>
              <button class="btn btn-sm btn-danger" @click="scnConfirmDelete = s.id">delete</button>
            </span>
          </template>
          <!-- membership editor -->
          <div v-if="scnMembersOpen === s.id" class="scn-members">
            <div v-if="scnMembers.length === 0" style="font-size: var(--text-caption); color: var(--color-steel); padding: var(--s-2);">no presets checked in — add from the list below</div>
            <div v-for="(m, i) in scnMembers" :key="m.preset_id" class="meta-row">
              <span class="k"><input type="checkbox" :checked="m.enabled === 1" title="enabled presets are served when this scenario runs" @change="toggleMember(m)" /></span>
              <b style="min-width: 44px;">{{ m.method }}</b>
              <span style="flex: 1; font-family: var(--font-mono, monospace); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">{{ m.path_pattern }}</span>
              <span class="status" :class="m.status >= 500 ? 'status-fail' : m.status >= 400 ? 'status-changes-pending' : 'status-passed'">{{ m.status }}</span>
              <button class="btn btn-sm btn-ghost" @click="removeMember(i)">✕</button>
            </div>
            <!-- add: presets not yet members -->
            <div class="meta-row" style="border-top: 1px solid var(--color-iron);">
              <span class="k">add</span>
              <select style="flex: 1;" @change="($event.target as HTMLSelectElement).value && (addPresetToMembers(presets.find((p) => p.id === ($event.target as HTMLSelectElement).value)!), (($event.target as HTMLSelectElement).value = ''))">
                <option value="">pick a preset…</option>
                <option v-for="p in presets.filter((p) => !scnMembers.some((m) => m.preset_id === p.id))" :key="p.id" :value="p.id">{{ p.method }} {{ p.path_pattern }} ({{ p.status }})</option>
              </select>
              <button class="btn btn-sm btn-primary" :disabled="scnMemberBusy" @click="saveMembers(s.id)">{{ scnMemberBusy ? 'saving…' : 'save scenario' }}</button>
            </div>
          </div>
        </div>
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
        <button
          v-else-if="selected.matched_preset_id"
          class="btn btn-sm" style="margin-left: auto;"
          title="edit what this preset serves"
          @click="editingPreset = selected.matched_preset_id"
        >edit preset</button>
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
    <PresetEditorModal v-if="editingPreset" :preset-id="editingPreset" @close="editingPreset = null" @saved="msg = 'preset saved — serving updated'; void loadPresets()" />
  </div>
</template>

<style scoped>
.row-selected { background: color-mix(in srgb, var(--color-ember) 8%, transparent); }
.detail-card { border-color: var(--color-ash); }
.detail-tabs { display: flex; gap: var(--s-2); padding: var(--s-2) var(--s-3) 0; align-items: center; }
.scn-row {
  display: flex; align-items: center; gap: var(--s-2);
  padding: var(--s-2) var(--s-3);
  border-bottom: 1px solid var(--color-iron);
  flex-wrap: wrap;
}
.scn-row:last-child { border-bottom: none; }
.scn-actions { display: flex; gap: 4px; }
.scn-members {
  width: 100%;
  background: var(--color-void);
  border: 1px solid var(--color-iron);
  border-radius: var(--r-sm);
  padding: var(--s-2);
  margin-top: var(--s-2);
}
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
