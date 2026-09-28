<script setup lang="ts">
/** ForgePage — the network page, rebuilt (plan 20260928T092527Z rev 2, sketch
 *  021-c2). ONE .a2-list box with the TestCasesPage foldered anatomy: sticky
 *  thead, cPanel breadcrumb + folder rows above scenario rows, row click
 *  expands the inline ScenarioDocPanel. Proxy/routing/mode live in a
 *  persistent control strip; traffic stays below as a subordinate feed.
 *  Old page deleted (full-redesign house rule). */
import PageHeader from '../components/PageHeader.vue';
import ScenarioDocPanel from '../components/ScenarioDocPanel.vue';
import PresetEditorModal from '../components/PresetEditorModal.vue';
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
interface ScenarioRow {
  id: string; name: string; folder_id: string | null; launch_arg: string | null; immutable_since: number | null;
  memberCount: number; runCount: number; usedBy: Array<{ label: string }>; changedSincePlay: boolean;
}
interface FolderRow { id: string; name: string; scenarioCount: number; createdBy: string; createdAt: number }
interface ScenarioMember { preset_id: string; enabled: number; method: string; path_pattern: string; status: number }

const live = useLiveEvents();
const traffic = ref<TrafficRow[]>([]);
const presets = ref<PresetRow[]>([]);
const scenarios = ref<ScenarioRow[]>([]);
const folders = ref<FolderRow[]>([]);
const crumbs = ref<Array<{ id: string; name: string }>>([]);
const curFolder = ref<string | null>(null); // null = root
const msg = ref('');
const search = ref('');
const selected = ref<TrafficDetail | null>(null);
const detailSide = ref<'res' | 'req'>('res');
const savingPreset = ref(false);
const editingPreset = ref<string | null>(null);

// document expansion (one at a time, same-row toggle)
const docOpenId = ref<string | null>(null);
const docMembers = ref<ScenarioMember[]>([]);
const scnCreating = ref(false);
const scnNewName = ref('');

// select mode (checkboxes behind a toggle — operator rule)
const selectMode = ref(false);
const selection = ref(new Set<string>());
const moveOpen = ref(false);
const scnConfirmDelete = ref<string | null>(null);
const presetConfirmDelete = ref<string | null>(null);
const folderRename = ref<{ id: string; name: string } | null>(null);
const folderCreating = ref(false);
const folderNewName = ref('');
// preset folders (round 2): same cPanel pattern, plus endpoint grouping inside the view
const preFolders = ref<Array<{ id: string; name: string; presetCount: number; createdBy: string; createdAt: number }>>([]);
const preCrumbs = ref<Array<{ id: string; name: string }>>([]);
const preCurFolder = ref<string | null>(null);
const preFolderCreating = ref(false);
const preFolderNewName = ref('');
const preFolderRename = ref<{ id: string; name: string } | null>(null);
const preSelectMode = ref(false);
const preSelection = ref(new Set<string>());
const preMoveOpen = ref(false);
// move pickers (round 2 follow-up): a small modal with a vertical picker —
// not horizontally stacked buttons (operator direction, test-cases pattern)
const scnMoveTarget = ref('');
const preMoveTarget = ref('');
// flat folder trees for the move pickers (path-labeled, full tree — not just current children)
const scnFolderTree = ref<Array<{ id: string; path: string; scenarioCount: number }>>([]);
const preFolderTree = ref<Array<{ id: string; path: string; presetCount: number }>>([]);
async function loadFolderTrees(): Promise<void> {
  try {
    const s = await (await fetch('/api/scenario-folders?flat=1')).json() as { folders: typeof scnFolderTree.value };
    scnFolderTree.value = s.folders;
  } catch { /* picker falls back to direct children */ }
  try {
    const p = await (await fetch('/api/preset-folders?flat=1')).json() as { folders: typeof preFolderTree.value };
    preFolderTree.value = p.folders;
  } catch { /* ditto */ }
}
// traffic pagination (round 2)
const trafficPage = ref(1);
const trafficTotal = ref(0);
const TRAFFIC_PAGE_SIZE = 25;

const MODE_HELP: Record<string, string> = {
  record: 'watch only — real traffic passes through and is logged',
  hybrid: 'real traffic, matched endpoints faked — default',
  intercept: 'fully fake — unmatched requests get 501',
};
const mode = ref('hybrid');

// ── MITM proxy state ──
interface MitmStatus { running: boolean; port?: number }
const mitm = ref<MitmStatus>({ running: false });
const mitmBusy = ref(false);
async function loadMitm(): Promise<void> {
  try { mitm.value = (await (await fetch('/api/forge/mitm/status')).json()) as MitmStatus; } catch { /* offline */ }
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
interface RoutingState { enabled: boolean; service: string | null; host: string | null; port: number | null; trustedSims?: number }
const routing = ref<RoutingState>({ enabled: false, service: null, host: null, port: null });
const routingBusy = ref(false);
async function loadRouting(): Promise<void> {
  try { routing.value = (await (await fetch('/api/forge/sim-routing')).json()) as RoutingState; } catch { /* ignore */ }
}
async function setRouting(on: boolean): Promise<void> {
  routingBusy.value = true;
  try {
    const res = await fetch('/api/forge/sim-routing', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: on }) });
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
async function setMode(m: string): Promise<void> {
  const res = await fetch('/api/forge/mode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: m }) });
  mode.value = (await res.json() as { mode: string }).mode;
}

// ── traffic (subordinate feed, unchanged contract) ──
async function loadTraffic(): Promise<void> {
  const params = new URLSearchParams({ limit: String(TRAFFIC_PAGE_SIZE), page: String(trafficPage.value) });
  if (search.value.trim()) params.set('q', search.value.trim());
  const res = await fetch(`/api/forge/traffic?${params}`);
  const b = (await res.json()) as { traffic: TrafficRow[]; total: number };
  traffic.value = b.traffic;
  trafficTotal.value = b.total;
}
function trafficPages(): number { return Math.max(1, Math.ceil(trafficTotal.value / TRAFFIC_PAGE_SIZE)); }
function gotoTrafficPage(p: number): void {
  const max = trafficPages();
  trafficPage.value = Math.min(Math.max(1, p), max);
  void loadTraffic();
}
let searchTimer: ReturnType<typeof setTimeout> | null = null;
watch(search, () => {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { trafficPage.value = 1; void loadTraffic(); }, 250); // search resets to page 1
});
async function loadPresets(): Promise<void> {
  // round 2: always folder-scoped ('' = root); the doc picker uses the unscoped list
  const res = await fetch(`/api/forge/presets?folderId=${preCurFolder.value ?? ''}`);
  presets.value = (await res.json() as { presets: PresetRow[] }).presets;
}
const presetGroups = computed(() => {
  const groups = new Map<string, PresetRow[]>();
  for (const p of presets.value) {
    const k = `${p.method} ${p.path_pattern}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(p);
  }
  return [...groups.entries()].map(([key, rows]) => ({ key, method: rows[0]!.method, path: rows[0]!.path_pattern, rows }));
});
async function loadPreFolders(): Promise<void> {
  const q = preCurFolder.value ? `?parentId=${preCurFolder.value}` : '';
  const res = await fetch(`/api/preset-folders${q}`);
  const b = (await res.json()) as { folders: typeof preFolders.value; path: Array<{ id: string; name: string }> };
  preFolders.value = b.folders;
  preCrumbs.value = [{ id: '', name: 'presets' }, ...b.path.map((x) => ({ id: x.id, name: x.name }))];
}
async function openPreFolder(id: string | null): Promise<void> {
  preCurFolder.value = id;
  await Promise.all([loadPreFolders(), loadPresets()]);
}
async function createPreFolder(): Promise<void> {
  const name = preFolderNewName.value.trim();
  if (!name) return;
  const res = await fetch('/api/preset-folders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, parentId: preCurFolder.value }) });
  const b = (await res.json()) as { id?: string; error?: string };
  if (b.id) { preFolderNewName.value = ''; preFolderCreating.value = false; await loadPreFolders(); }
  else msg.value = b.error ?? 'folder create failed';
}
async function renamePreFolder(): Promise<void> {
  if (!preFolderRename.value) return;
  const res = await fetch(`/api/preset-folders/${preFolderRename.value.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: preFolderRename.value.name }) });
  const b = (await res.json()) as { error?: string };
  if (b.error) msg.value = b.error;
  preFolderRename.value = null;
  await loadPreFolders();
}
async function deletePreFolder(id: string): Promise<void> {
  const res = await fetch(`/api/preset-folders/${id}`, { method: 'DELETE' });
  const b = (await res.json()) as { error?: string };
  if (b.error) msg.value = b.error;
  await loadPreFolders();
}
function togglePreSelectMode(): void {
  preSelectMode.value = !preSelectMode.value;
  if (!preSelectMode.value) preSelection.value = new Set();
}
function togglePreSel(id: string): void {
  const n = new Set(preSelection.value);
  if (n.has(id)) n.delete(id); else n.add(id);
  preSelection.value = n;
}
async function movePresets(): Promise<void> {
  const folderId = preMoveTarget.value || null;
  for (const id of preSelection.value) {
    await fetch(`/api/forge/presets/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folderId }) });
  }
  preMoveOpen.value = false;
  preMoveTarget.value = '';
  preSelection.value = new Set();
  preSelectMode.value = false;
  await Promise.all([loadPresets(), loadPreFolders()]);
}
async function openDetail(t: TrafficRow): Promise<void> {
  selected.value = null;
  const res = await fetch(`/api/forge/traffic/${t.id}`);
  if (res.ok) selected.value = (await res.json()) as TrafficDetail;
}
async function saveAsPreset(): Promise<void> {
  if (!selected.value || savingPreset.value) return;
  savingPreset.value = true;
  try {
    const res = await fetch(`/api/forge/traffic/${selected.value.id}/save-preset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const b = (await res.json()) as { id?: string; error?: string };
    msg.value = b.id ? `preset ${b.id} — this endpoint now replays the captured response` : (b.error ?? 'failed');
    if (b.id) {
      if (preCurFolder.value) await fetch(`/api/forge/presets/${b.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folderId: preCurFolder.value }) });
      await loadPresets();
      if (selected.value) await openDetail(selected.value);
    }
  } finally { savingPreset.value = false; }
}
const detailBody = computed((): BodyInfo | null => {
  if (!selected.value) return null;
  return detailSide.value === 'res' ? selected.value.resBody : selected.value.reqBody;
});

// ── scenario list + folders ──
async function loadScenarios(): Promise<void> {
  // fix1 (round 2): ALWAYS filter by folder — '' = root (folder_id IS NULL).
  // The old code sent no param at root, so foldered scenarios leaked into root.
  const res = await fetch(`/api/forge/scenarios?folderId=${curFolder.value ?? ''}`);
  scenarios.value = (await res.json() as { scenarios: ScenarioRow[] }).scenarios;
}
async function loadFolders(): Promise<void> {
  const q = curFolder.value ? `?parentId=${curFolder.value}` : '';
  const res = await fetch(`/api/scenario-folders${q}`);
  const b = (await res.json()) as { folders: FolderRow[]; path: Array<{ id: string; name: string }> };
  folders.value = b.folders;
  crumbs.value = [{ id: '', name: 'scenarios' }, ...b.path.map((p) => ({ id: p.id, name: p.name }))];
}
async function openFolder(id: string | null): Promise<void> {
  curFolder.value = id;
  docOpenId.value = null;
  await Promise.all([loadFolders(), loadScenarios()]);
}
async function createFolder(): Promise<void> {
  const name = folderNewName.value.trim();
  if (!name) return;
  const res = await fetch('/api/scenario-folders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, parentId: curFolder.value }) });
  const b = (await res.json()) as { id?: string; error?: string };
  if (b.id) { folderNewName.value = ''; folderCreating.value = false; await loadFolders(); }
  else msg.value = b.error ?? 'folder create failed';
}
async function renameFolder(): Promise<void> {
  if (!folderRename.value) return;
  const res = await fetch(`/api/scenario-folders/${folderRename.value.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: folderRename.value.name }) });
  const b = (await res.json()) as { ok?: boolean; error?: string };
  if (!b.ok && b.error) msg.value = b.error;
  folderRename.value = null;
  await loadFolders();
}
async function deleteFolder(id: string): Promise<void> {
  const res = await fetch(`/api/scenario-folders/${id}`, { method: 'DELETE' });
  const b = (await res.json()) as { deleted?: string; error?: string };
  if (b.error) msg.value = b.error;
  await loadFolders();
}
async function createScenario(): Promise<void> {
  const name = scnNewName.value.trim();
  if (!name) return;
  const res = await fetch('/api/forge/scenarios', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, createdBy: 'qa' }) });
  const b = (await res.json()) as { id?: string; error?: string };
  if (b.id) {
    if (curFolder.value) await fetch(`/api/forge/scenarios/${b.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folderId: curFolder.value }) });
    scnNewName.value = '';
    scnCreating.value = false;
    await loadScenarios();
    await openDoc(b.id);
  } else msg.value = b.error ?? 'create failed';
}
async function openDoc(id: string): Promise<void> {
  if (docOpenId.value === id) { docOpenId.value = null; return; }
  const scn = scenarios.value.find((s) => s.id === id);
  if (!scn) return;
  const res = await fetch(`/api/forge/scenarios/${id}`);
  if (!res.ok) { msg.value = 'scenario not found'; await loadScenarios(); return; }
  docMembers.value = ((await res.json()) as { members: ScenarioMember[] }).members;
  docOpenId.value = id;
}
async function duplicateScenario(id: string, name: string): Promise<void> {
  const res = await fetch(`/api/forge/scenarios/${id}/duplicate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: `${name} copy` }) });
  const b = (await res.json()) as { id?: string; error?: string };
  if (b.id) await loadScenarios();
  else msg.value = b.error ?? 'duplicate failed';
}
async function deleteScenario(s: ScenarioRow): Promise<void> {
  const res = await fetch(`/api/forge/scenarios/${s.id}`, { method: 'DELETE' });
  const b = (await res.json()) as { ok?: boolean; error?: string; warning?: string };
  if (b.error) msg.value = b.error;
  else if (b.warning) msg.value = `${s.name} deleted — ${b.warning}`;
  else msg.value = `${s.name} deleted`;
  scnConfirmDelete.value = null;
  if (docOpenId.value === s.id) docOpenId.value = null;
  await Promise.all([loadScenarios(), loadFolders()]);
}
async function deletePreset(id: string): Promise<void> {
  const res = await fetch(`/api/forge/presets/${id}`, { method: 'DELETE' });
  const b = (await res.json()) as { ok?: boolean; error?: string };
  if (b.error) msg.value = b.error;
  presetConfirmDelete.value = null;
  await loadPresets();
}

// ── select mode ──
function toggleSelectMode(): void {
  selectMode.value = !selectMode.value;
  if (!selectMode.value) selection.value = new Set();
}
function toggleSel(id: string): void {
  const n = new Set(selection.value);
  if (n.has(id)) n.delete(id); else n.add(id);
  selection.value = n;
}
async function moveSelected(): Promise<void> {
  const folderId = scnMoveTarget.value || null;
  for (const id of selection.value) {
    await fetch(`/api/forge/scenarios/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folderId }) });
  }
  moveOpen.value = false;
  scnMoveTarget.value = '';
  selection.value = new Set();
  selectMode.value = false;
  await Promise.all([loadScenarios(), loadFolders()]);
}

const unwatch = watch(() => live.traffic.length, () => { void loadTraffic(); });

// fix6 (round 2): Esc collapses the open scenario document — same pattern as
// the test-cases yaml panel. Scoped: no modal open (preset editor), no input
// or select focused (typing Esc into a field must do its normal job).
function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || !docOpenId.value) return;
  if (editingPreset.value) return;
  const el = document.activeElement;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || (el as HTMLElement).isContentEditable)) return;
  docOpenId.value = null;
}

// the single fixed tooltip element for .ibtn (delegated — never clipped)
const rowtip = document.createElement('div');
rowtip.id = 'rowtip';
rowtip.style.display = 'none';
document.body.appendChild(rowtip);
function onRowOver(e: MouseEvent): void {
  const t = (e.target as HTMLElement).closest?.('.ibtn') as HTMLElement | null;
  if (!t) return;
  rowtip.textContent = t.dataset.tip ?? '';
  const r = t.getBoundingClientRect();
  rowtip.style.display = '';
  rowtip.style.left = `${r.left + r.width / 2}px`;
  rowtip.style.top = `${r.bottom + 5}px`;
}
function onRowOut(e: MouseEvent): void {
  if ((e.target as HTMLElement).closest?.('.ibtn')) rowtip.style.display = 'none';
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown);
  document.addEventListener('mouseover', onRowOver);
  document.addEventListener('mouseout', onRowOut);
  live.connect();
  void loadTraffic();
  void loadPresets();
  void loadPreFolders();
  void loadScenarios();
  void loadFolders();
  void loadMitm();
  void loadRouting();
});
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown);
  document.removeEventListener('mouseover', onRowOver);
  document.removeEventListener('mouseout', onRowOut);
  rowtip.remove();
  unwatch(); live.release(); if (searchTimer) clearTimeout(searchTimer);
});
</script>

<template>
  <div>
    <PageHeader title="network · scenarios">
      <span class="ph-desc">{{ scenarios.length }} scenario{{ scenarios.length === 1 ? '' : 's' }} · {{ folders.length }} folder{{ folders.length === 1 ? '' : 's' }} · {{ traffic.length }} requests{{ !live.connected ? ' · live offline' : '' }}</span>
      <template #actions>
        <button class="btn" @click="scnCreating = !scnCreating">+ scenario</button>
      </template>
    </PageHeader>

    <!-- persistent control strip: proxy · routing · mode (never inside a panel) -->
    <div class="ctl">
      <span class="dot" :class="{ off: !mitm.running }" :title="mitm.running ? 'proxy running' : 'proxy down'"></span>
      <button v-if="!mitm.running" class="btn btn-sm" :disabled="mitmBusy" @click="startMitm">{{ mitmBusy ? 'starting…' : 'start proxy' }}</button>
      <span v-else>proxy 127.0.0.1:{{ mitm.port }}</span>
      <span class="sep">·</span>
      <button class="btn btn-sm" :class="{ 'btn-primary': routing.enabled }" :disabled="routingBusy || (!routing.enabled && !mitm.running)"
        :title="routing.enabled ? 'sims route through the proxy (restart sims to change)' : 'route all simulator traffic through the proxy'"
        @click="setRouting(!routing.enabled)">{{ routingBusy ? '…' : routing.enabled ? `sims routed${routing.service ? ` · ${routing.service}` : ''}` : 'route sims' }}</button>
      <span class="sep">·</span>
      <span class="a2-tabs">
        <button v-for="m in ['record', 'hybrid', 'intercept']" :key="m" class="a2-tab" :class="{ on: mode === m }" :title="MODE_HELP[m]" @click="setMode(m)">{{ m }}</button>
      </span>
      <span class="ctl-hint">{{ routing.enabled && !mitm.running ? 'proxy down — internet restored; start proxy + route sims again' : MODE_HELP[mode] }}</span>
    </div>

    <div v-if="msg" class="meta-row">{{ msg }}</div>

    <!-- scenario list: ONE box, sticky thead, breadcrumb + folder rows + rows -->
    <div class="a2-list scn-list">
      <div class="a2-thead">
        <span class="col-sel"></span>
        <span>scenario</span>
        <span title="member presets serving this scenario">presets</span>
        <span title="runs stamped with this scenario (id or name)">runs</span>
        <span>used</span>
        <span></span>
      </div>
      <div class="a2-crumbs">
        <template v-for="(c, ci) in crumbs" :key="ci">
          <span v-if="ci > 0" class="crumb-sep">/</span>
          <button class="crumb" :class="{ cur: ci === crumbs.length - 1 }" @click="openFolder(ci === 0 ? null : c.id)">{{ c.name }}</button>
        </template>
        <span class="crumb-acts">
          <button class="btn btn-sm" @click="folderCreating = !folderCreating">+ folder</button>
          <button class="btn btn-sm" :class="{ on: selectMode }" :title="selectMode ? 'leave selection mode' : 'select scenarios for bulk move'" @click="toggleSelectMode">{{ selectMode ? '✕ select' : 'select' }}</button>
          <template v-if="selectMode && selection.size > 0">
            <span class="mono mut">{{ selection.size }} picked</span>
            <button class="btn btn-sm" @click="moveOpen = true; void loadFolderTrees()">move to…</button>
          </template>
        </span>
      </div>
      <div v-if="folderCreating" class="meta-row">
        <span class="k">name</span>
        <input v-model="folderNewName" placeholder="e.g. tariff worlds" style="flex: 1;" @keydown.enter="createFolder" />
        <button class="btn btn-sm btn-primary" :disabled="!folderNewName.trim()" @click="createFolder">create</button>
        <button class="btn btn-sm" @click="folderCreating = false">cancel</button>
      </div>
      <div v-for="f in folders" :key="f.id" class="a2-folder-row" :title="`open ${f.name} — ${f.scenarioCount} scenario(s) in subtree`" @click="openFolder(f.id)">
        <span class="f-spacer"><svg class="f-glyph" viewBox="0 0 20 20" aria-hidden="true"><path d="M2.5 4.5A1.5 1.5 0 014 3h3.6a1.5 1.5 0 011.1.5l1.1 1.2H16A1.5 1.5 0 0117.5 6.2v9.3A1.5 1.5 0 0116 17H4a1.5 1.5 0 01-1.5-1.5V4.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg></span>
        <template v-if="folderRename?.id === f.id">
          <input v-model="folderRename.name" style="flex: 1;" @keydown.enter="renameFolder" @keydown.esc="folderRename = null" @click.stop />
          <button class="btn btn-sm btn-primary" @click.stop="renameFolder">save</button>
          <button class="btn btn-sm" @click.stop="folderRename = null">cancel</button>
        </template>
        <template v-else>
          <span class="f-name">{{ f.name }}</span>
          <span class="f-n">{{ f.scenarioCount }}</span>
          <span class="f-fill"></span>
          <span class="f-meta" :title="`created by ${f.createdBy} · ${new Date(f.createdAt).toLocaleString()}`">{{ f.createdBy }} · {{ new Date(f.createdAt).toLocaleDateString() }}</span>
          <span class="f-sep"></span>
          <span class="f-acts" @click.stop>
            <button class="btn btn-sm" @click="folderRename = { id: f.id, name: f.name }">rename</button>
            <button class="btn btn-sm f-del" :class="{ ghosted: f.scenarioCount > 0 }" :disabled="f.scenarioCount > 0"
              :title="f.scenarioCount > 0 ? 'move or delete its scenarios first — the guard refuses non-empty folders' : 'delete this empty folder'"
              @click="deleteFolder(f.id)">delete</button>
          </span>
        </template>
      </div>
      <div v-if="scnCreating" class="meta-row">
        <span class="k">name</span>
        <input v-model="scnNewName" placeholder="e.g. tariff api down" style="flex: 1;" @keydown.enter="createScenario" />
        <button class="btn btn-sm btn-primary" :disabled="!scnNewName.trim()" @click="createScenario">create</button>
        <button class="btn btn-sm" @click="scnCreating = false">cancel</button>
      </div>

      <template v-for="s in scenarios" :key="s.id">
        <div class="scn-row" :class="{ sel: docOpenId === s.id }" @click="openDoc(s.id)" :title="`open the scenario document — ${s.id}`">
          <span class="col-sel">
            <input v-if="selectMode" type="checkbox" :checked="selection.has(s.id)" @click.stop @change="toggleSel(s.id)" title="select for bulk move" />
            <svg v-else class="doc-glyph" viewBox="0 0 20 20" aria-hidden="true"><path d="M5 2.5h7l3 3v12H5v-15z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M11.5 2.7V6h3.3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>
          </span>
          <span class="scn-name-w"><span class="scn-name">{{ s.name }}</span><span class="scn-id">{{ s.id }}</span></span>
          <span class="mono">{{ s.memberCount }}</span>
          <span class="mono">{{ s.runCount }}</span>
          <span class="mono mut">{{ s.immutable_since ? new Date(s.immutable_since).toLocaleDateString() : '—' }}</span>
          <span class="row-acts">
            <span v-if="s.changedSincePlay" class="chip changed" title="membership or preset bodies changed since the newest stamped run — applies from the next play">changed</span>
            <span v-if="s.usedBy.length > 0" class="chip used" :title="s.usedBy.map((u) => u.label).join('\n')">used</span>
            <button v-if="scnConfirmDelete === s.id" class="btn btn-sm btn-danger" @click.stop="deleteScenario(s)">confirm</button>
            <button v-else class="ibtn" data-tip="delete — blocked while variants/case versions pin it" @click.stop="scnConfirmDelete = s.id"><svg viewBox="0 0 20 20"><path d="M4 6h12M8 6V4h4v2m-7 0l1 11h8l1-11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
            <button class="ibtn" data-tip="duplicate — copy membership + launch_arg" @click.stop="duplicateScenario(s.id, s.name)"><svg viewBox="0 0 20 20"><rect x="7" y="7" width="10" height="10" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M13 4.5V3H3v10h1.5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg></button>
          </span>
        </div>
        <ScenarioDocPanel
          v-if="docOpenId === s.id"
          :scenario-id="s.id" :name="s.name" :launch-arg="s.launch_arg" :members="docMembers"
          :all-presets="presets" :used-by="s.usedBy" :run-count="s.runCount" :changed-since-play="s.changedSincePlay"
          @close="docOpenId = null" @saved="void loadScenarios()"
        />
      </template>
      <div v-if="scenarios.length === 0 && folders.length === 0" class="empty">
        no scenarios here — create one above, or capture traffic below and save a preset
      </div>
    </div>

    <!-- presets: foldered (manual organization) + grouped by endpoint inside the view -->
    <div class="sec-label">presets <span class="n">{{ presets.length }}</span></div>
    <div class="a2-list">
      <div class="a2-thead pre-thead">
        <span class="col-sel"></span><span>endpoint / preset</span><span>status</span><span>body</span><span></span>
      </div>
      <div class="a2-crumbs">
        <template v-for="(c, ci) in preCrumbs" :key="ci">
          <span v-if="ci > 0" class="crumb-sep">/</span>
          <button class="crumb" :class="{ cur: ci === preCrumbs.length - 1 }" @click="openPreFolder(ci === 0 ? null : c.id)">{{ c.name }}</button>
        </template>
        <span class="crumb-acts">
          <button class="btn btn-sm" @click="preFolderCreating = !preFolderCreating">+ folder</button>
          <button class="btn btn-sm" :class="{ on: preSelectMode }" :title="preSelectMode ? 'leave selection mode' : 'select presets for bulk move'" @click="togglePreSelectMode">{{ preSelectMode ? '✕ select' : 'select' }}</button>
          <template v-if="preSelectMode && preSelection.size > 0">
            <span class="mono mut">{{ preSelection.size }} picked</span>
            <button class="btn btn-sm" @click="preMoveOpen = true; void loadFolderTrees()">move to…</button>
          </template>
        </span>
      </div>
      <div v-if="preFolderCreating" class="meta-row">
        <span class="k">name</span>
        <input v-model="preFolderNewName" placeholder="e.g. consumer app" style="flex: 1;" @keydown.enter="createPreFolder" />
        <button class="btn btn-sm btn-primary" :disabled="!preFolderNewName.trim()" @click="createPreFolder">create</button>
        <button class="btn btn-sm" @click="preFolderCreating = false">cancel</button>
      </div>
      <div v-for="f in preFolders" :key="f.id" class="a2-folder-row" :title="`open ${f.name} — ${f.presetCount} preset(s) in subtree`" @click="openPreFolder(f.id)">
        <span class="f-spacer"><svg class="f-glyph" viewBox="0 0 20 20" aria-hidden="true"><path d="M2.5 4.5A1.5 1.5 0 014 3h3.6a1.5 1.5 0 011.1.5l1.1 1.2H16A1.5 1.5 0 0117.5 6.2v9.3A1.5 1.5 0 0116 17H4a1.5 1.5 0 01-1.5-1.5V4.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg></span>
        <template v-if="preFolderRename?.id === f.id">
          <input v-model="preFolderRename.name" style="flex: 1;" @keydown.enter="renamePreFolder" @keydown.esc="preFolderRename = null" @click.stop />
          <button class="btn btn-sm btn-primary" @click.stop="renamePreFolder">save</button>
          <button class="btn btn-sm" @click.stop="preFolderRename = null">cancel</button>
        </template>
        <template v-else>
          <span class="f-name">{{ f.name }}</span>
          <span class="f-n">{{ f.presetCount }}</span>
          <span class="f-fill"></span>
          <span class="f-meta" :title="`created by ${f.createdBy} · ${new Date(f.createdAt).toLocaleString()}`">{{ f.createdBy }} · {{ new Date(f.createdAt).toLocaleDateString() }}</span>
          <span class="f-sep"></span>
          <span class="f-acts" @click.stop>
            <button class="btn btn-sm" @click="preFolderRename = { id: f.id, name: f.name }">rename</button>
            <button class="btn btn-sm f-del" :class="{ ghosted: f.presetCount > 0 }" :disabled="f.presetCount > 0" :title="f.presetCount > 0 ? 'move or delete its presets first' : 'delete this empty folder'" @click="deletePreFolder(f.id)">delete</button>
          </span>
        </template>
      </div>
      <template v-for="g in presetGroups" :key="g.key">
        <div class="ep-group mono" :title="`${g.rows.length} preset(s) serve this endpoint`">{{ g.method }} {{ g.path }} <span class="f-n">{{ g.rows.length }}</span></div>
        <div v-for="p in g.rows" :key="p.id" class="pre-row" :title="p.id">
          <span class="col-sel">
            <input v-if="preSelectMode" type="checkbox" :checked="preSelection.has(p.id)" @click.stop @change="togglePreSel(p.id)" title="select for bulk move" />
            <svg v-else class="doc-glyph" viewBox="0 0 20 20" aria-hidden="true"><path d="M5 2.5h7l3 3v12H5v-15z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M11.5 2.7V6h3.3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>
          </span>
          <span class="mono pre-name" :title="p.id">{{ p.id }}</span>
          <span class="mono">{{ p.status }}</span>
          <span class="mono mut">{{ p.body_path ? '✓' : '—' }}</span>
          <span class="row-acts">
            <button v-if="presetConfirmDelete === p.id" class="btn btn-sm btn-danger" title="deletes the preset — refused while a scenario includes it" @click="deletePreset(p.id)">confirm</button>
            <button v-else class="ibtn" data-tip="delete — refused while a scenario includes it" @click="presetConfirmDelete = p.id"><svg viewBox="0 0 20 20"><path d="M4 6h12M8 6V4h4v2m-7 0l1 11h8l1-11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
            <button class="ibtn" data-tip="edit what this preset serves" @click="editingPreset = p.id"><svg viewBox="0 0 20 20"><path d="M13.5 2.5l4 4L8 16H4v-4l9.5-9.5zm-2.8 3.7l1.6-1.6-1.2-1.2-1.6 1.6 1.2 1.2zM12.9 8.4l1.6-1.6-1.2-1.2-1.6 1.6 1.2 1.2zM5 13v2h2l1-1-2-2-1 1z" fill="currentColor"/></svg></button>
          </span>
        </div>
      </template>
      <div v-if="presets.length === 0 && preFolders.length === 0" class="empty">no presets here — capture traffic below and save as preset</div>
    </div>

    <!-- traffic: subordinate live feed -->
    <div class="sec-label">traffic <span class="n">live</span> <input v-model="search" class="a2-search" placeholder="search host or path…" /></div>
    <div class="a2-list">
      <div class="a2-thead trf-thead">
        <span>time</span><span>method</span><span>host</span><span>path</span><span>status</span><span>latency</span><span>preset</span>
      </div>
      <div v-for="t in traffic" :key="t.id" class="trf-row" :class="{ 'row-selected': selected?.id === t.id }" @click="openDetail(t)">
        <span class="mono mut nowrap">{{ new Date(t.ts).toLocaleTimeString() }}</span>
        <span class="mono">{{ t.method }}</span>
        <span class="mono mut">{{ t.host }}</span>
        <span class="mono path">{{ t.path }}</span>
        <span class="mono">{{ t.status }}</span>
        <span class="mut nowrap">{{ t.latency_ms }}ms</span>
        <span class="mono pre-hit">{{ t.matched_preset_id ?? '' }}</span>
      </div>
      <div v-if="traffic.length === 0 && trafficTotal === 0" class="empty">
        <div>no requests{{ search ? ' matching the filter' : ' yet' }}</div>
        <div v-if="!search" class="empty-steps">
          <b>to see traffic here:</b><br />
          1. start the proxy<br />
          2. <b>route sims</b> — then restart booted simulators (shut down → boot)<br />
          3. use the app on the device
        </div>
      </div>
      <div class="pager mono" v-if="trafficTotal > 0">
        <span class="mut">{{ trafficTotal }} requests</span>
        <button class="btn btn-sm" :disabled="trafficPage <= 1" @click="gotoTrafficPage(trafficPage - 1)">‹</button>
        <span>page {{ trafficPage }} / {{ trafficPages() }}</span>
        <button class="btn btn-sm" :disabled="trafficPage >= trafficPages()" @click="gotoTrafficPage(trafficPage + 1)">›</button>
      </div>
    </div>

    <!-- traffic detail -->
    <div v-if="selected" class="detail-card a2-list">
      <div class="det-head">
        <span class="mono det-title">{{ selected.method }} {{ selected.host }}{{ selected.path }}</span>
        <span class="mono">{{ selected.status }} · {{ selected.latency_ms }}ms · {{ selected.mode }}</span>
        <button v-if="!selected.matched_preset_id && selected.res_sha" class="btn btn-sm btn-primary" :disabled="savingPreset" style="margin-left: auto;" title="future hits to this exact endpoint return this captured response" @click="saveAsPreset">{{ savingPreset ? 'saving…' : 'save as preset' }}</button>
        <button v-else-if="selected.matched_preset_id" class="btn btn-sm" style="margin-left: auto;" title="edit what this preset serves" @click="editingPreset = selected.matched_preset_id">edit preset</button>
        <button class="btn btn-sm btn-ghost" @click="selected = null">✕</button>
      </div>
      <div class="det-tabs">
        <button class="btn btn-sm" :class="{ 'btn-primary': detailSide === 'res' }" @click="detailSide = 'res'">response</button>
        <button class="btn btn-sm" :class="{ 'btn-primary': detailSide === 'req' }" @click="detailSide = 'req'">request</button>
        <span v-if="detailBody" class="mono mut">{{ detailBody.contentType }} · {{ detailBody.bytes }}B</span>
      </div>
      <pre v-if="detailBody" class="detail-body">{{ detailBody.pretty ?? detailBody.text }}</pre>
      <div v-else class="mut det-none">no {{ detailSide === 'res' ? 'response' : 'request' }} body captured</div>
    </div>

    <!-- move pickers: vertical select in a small modal (not stacked buttons) -->
    <div v-if="moveOpen" class="mv-modal" @click.self="moveOpen = false">
      <div class="mv-card">
        <div class="mv-h">move {{ selection.size }} scenario(s)</div>
        <select v-model="scnMoveTarget" class="a2-select-like">
          <option value="">— root (no folder) —</option>
          <option v-for="f in scnFolderTree" :key="f.id" :value="f.id">{{ f.path }} ({{ f.scenarioCount }})</option>
        </select>
        <div class="mv-acts">
          <button class="btn btn-sm" @click="moveOpen = false">cancel</button>
          <button class="btn btn-sm btn-primary" @click="moveSelected">move</button>
        </div>
      </div>
    </div>
    <div v-if="preMoveOpen" class="mv-modal" @click.self="preMoveOpen = false">
      <div class="mv-card">
        <div class="mv-h">move {{ preSelection.size }} preset(s)</div>
        <select v-model="preMoveTarget" class="a2-select-like">
          <option value="">— root (no folder) —</option>
          <option v-for="f in preFolderTree" :key="f.id" :value="f.id">{{ f.path }} ({{ f.presetCount }})</option>
        </select>
        <div class="mv-acts">
          <button class="btn btn-sm" @click="preMoveOpen = false">cancel</button>
          <button class="btn btn-sm btn-primary" @click="movePresets">move</button>
        </div>
      </div>
    </div>

    <PresetEditorModal v-if="editingPreset" :preset-id="editingPreset" @close="editingPreset = null" @saved="msg = 'preset saved — serving updated'; void loadPresets()" />
  </div>
</template>

<script lang="ts">
export default { name: 'ForgePage' };
</script>

<style scoped>
@reference '../styles/tokens.css';
/* control strip */
.ctl { display: flex; align-items: center; gap: var(--s-2); border: 1px solid var(--color-iron); border-radius: var(--r-sm); background: var(--color-carbon); padding: 6px 10px; margin-bottom: var(--s-4); font-family: var(--font-mono); font-size: 11px; color: var(--color-fog); flex-wrap: wrap; }
.ctl .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--color-ok); flex: none; }
.ctl .dot.off { background: var(--color-steel); }
.ctl .sep { color: var(--color-pewter); margin: 0 var(--s-1); }
.ctl-hint { color: var(--color-steel); margin-left: auto; }
/* scenario list rows (grid mirrors the thead tracks) */
.a2-thead { display: grid; grid-template-columns: 26px minmax(0, 2.2fr) minmax(0, 70px) minmax(0, 70px) minmax(0, 90px) minmax(0, 260px); align-items: center; background: var(--color-graphite); border-bottom: 1px solid var(--color-iron); font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--color-steel); }
.a2-thead > span { padding: 7px 8px; }
.scn-row { display: grid; grid-template-columns: 26px minmax(0, 2.2fr) minmax(0, 70px) minmax(0, 70px) minmax(0, 90px) minmax(0, 260px); align-items: center; border-bottom: 1px solid var(--color-iron); cursor: pointer; font-size: var(--text-caption); }
.scn-row:hover { background: var(--color-graphite); }
.scn-row.sel { background: var(--color-graphite); }
.scn-row > span { padding: 9px 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.col-sel { display: flex; align-items: center; }
.scn-name-w { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.scn-name { font-weight: 600; color: var(--color-paper); overflow: hidden; text-overflow: ellipsis; }
.scn-id { font-family: var(--font-mono); font-size: 10px; color: var(--color-steel); }
.row-acts { display: flex; gap: 4px; justify-content: flex-end; align-items: center; }
.chip { border: 1px solid var(--color-iron); border-radius: var(--r-sm); padding: 1px 6px; font-family: var(--font-mono); font-size: 10px; color: var(--color-ash); }
.chip.used { color: var(--color-ember); border-color: color-mix(in srgb, var(--color-ember) 40%, transparent); }
.chip.changed { color: var(--color-ember); border-color: color-mix(in srgb, var(--color-ember) 40%, transparent); }
/* icon buttons (test-cases .ibtn idiom) + the single fixed tooltip */
.ibtn { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border: none; background: none; color: var(--color-pewter); cursor: pointer; border-radius: var(--r-sm); }
.ibtn:hover { color: var(--color-paper); background: var(--color-graphite); }
.ibtn svg { width: 16px; height: 16px; pointer-events: none; }
#rowtip { position: fixed; z-index: 300; background: var(--color-graphite); border: 1px solid var(--color-slate); color: var(--color-fog); font-family: var(--font-mono); font-size: 10px; padding: 3px 7px; border-radius: var(--r-sm); pointer-events: none; white-space: nowrap; transform: translateX(-50%); }
/* endpoint group head */
.ep-group { display: flex; align-items: center; gap: 6px; padding: 7px 12px; border-bottom: 1px solid var(--color-iron); font-family: var(--font-mono); font-size: 11px; color: var(--color-pewter); background: var(--color-void); }
.ep-group .f-n { color: var(--color-steel); margin-left: auto; }
.pre-name { color: var(--color-fog); font-size: 11px; }
/* pager */
.pager { display: flex; align-items: center; gap: var(--s-2); padding: 7px 12px; border-top: 1px solid var(--color-iron); font-size: 11px; color: var(--color-fog); }
.mono { font-family: var(--font-mono); }
.mut { color: var(--color-steel); }
.nowrap { white-space: nowrap; }
.path { font-size: 11px; }
/* crumbs + folder rows: page-local mirrors of the house classes (the global
   set is scoped to the pages that defined them; same values, one source of
   truth pending a components.css hoist) */
.a2-crumbs { display: flex; align-items: center; gap: 6px; padding: 8px 12px; border-bottom: 1px solid var(--color-iron); font-family: var(--font-mono); font-size: 11px; flex-wrap: wrap; }
.a2-crumbs .crumb { background: none; border: none; color: var(--color-pewter); cursor: pointer; padding: 2px 4px; font: inherit; }
.a2-crumbs .crumb:hover { color: var(--color-paper); text-decoration: underline; }
.a2-crumbs .crumb.cur { color: var(--color-ember); cursor: default; }
.a2-crumbs .crumb-sep { color: var(--color-steel); }
.crumb-acts { margin-left: auto; display: flex; gap: 6px; align-items: center; }
.a2-folder-row { display: flex; align-items: center; gap: var(--s-2); padding: 8px 12px; border-bottom: 1px solid var(--color-iron); cursor: pointer; font-family: var(--font-mono); font-size: 12px; color: var(--color-paper); }
.a2-folder-row:hover { background: var(--color-graphite); }
.f-glyph { color: var(--color-ember); width: 16px; height: 16px; flex: none; }
.f-spacer { width: 26px; flex: none; display: flex; align-items: center; }
.f-n { color: var(--color-steel); margin-left: 6px; }
.f-fill { flex: 1; }
.f-meta { font-size: 10px; color: var(--color-steel); white-space: nowrap; }
.f-sep { flex: none; width: 1px; height: 14px; background: var(--color-iron); margin: 0 14px; }
.f-name { color: var(--color-paper); }
.f-acts { margin-left: auto; display: flex; gap: 4px; }
.f-del.ghosted { visibility: hidden; }
.doc-glyph { width: 14px; height: 14px; color: var(--color-pewter); margin-left: 6px; }
.btn.on { border-color: var(--color-ember); color: var(--color-ember); }
.mv { display: inline-flex; gap: 4px; }
.mv-modal { position: fixed; inset: 0; background: rgba(0,0,0,0.55); display: flex; align-items: center; justify-content: center; z-index: 60; }
.mv-card { background: var(--color-graphite); border: 1px solid var(--color-iron); border-radius: var(--r-sm); padding: var(--s-4); min-width: 340px; max-width: 440px; }
.mv-h { font-family: var(--font-mono); font-weight: var(--weight-bold); font-size: var(--text-caption); margin-bottom: var(--s-3); color: var(--color-paper); }
.mv-card select { width: 100%; }
.mv-acts { display: flex; gap: var(--s-2); justify-content: flex-end; margin-top: var(--s-3); }
/* presets library */
.pre-thead { grid-template-columns: 26px minmax(0, 1fr) minmax(0, 60px) minmax(0, 50px) minmax(0, 120px); }
.pre-row { display: grid; grid-template-columns: 26px minmax(0, 1fr) minmax(0, 60px) minmax(0, 50px) minmax(0, 120px); align-items: center; border-bottom: 1px solid var(--color-iron); font-size: var(--text-caption); cursor: default; }
.pre-row:hover { background: var(--color-graphite); }
.pre-row > span { padding: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
/* traffic */
.trf-thead { grid-template-columns: minmax(0, 80px) minmax(0, 50px) minmax(0, 150px) minmax(0, 1fr) minmax(0, 50px) minmax(0, 70px) minmax(0, 90px); }
.trf-row { display: grid; grid-template-columns: minmax(0, 80px) minmax(0, 50px) minmax(0, 150px) minmax(0, 1fr) minmax(0, 50px) minmax(0, 70px) minmax(0, 90px); align-items: center; border-bottom: 1px solid var(--color-iron); font-size: var(--text-caption); cursor: pointer; }
.trf-row:hover { background: var(--color-graphite); }
.trf-row > span { padding: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.pre-hit { color: var(--color-ember); font-size: 10px; }
.row-selected { background: color-mix(in srgb, var(--color-ember) 8%, transparent); }
/* detail */
.detail-card { margin-top: var(--s-4); }
.det-head { display: flex; align-items: center; gap: var(--s-3); padding: var(--s-2) var(--s-3); border-bottom: 1px solid var(--color-iron); }
.det-title { font-size: var(--text-caption); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.det-tabs { display: flex; gap: var(--s-2); padding: var(--s-2) var(--s-3) 0; align-items: center; }
.det-none { padding: var(--s-3); font-size: var(--text-caption); color: var(--color-steel); }
.detail-body { margin: var(--s-2) var(--s-3) var(--s-3); padding: var(--s-3); background: var(--color-void); border: 1px solid var(--color-iron); border-radius: 4px; font-family: var(--font-mono); font-size: 11px; line-height: 1.5; max-height: 400px; overflow: auto; white-space: pre-wrap; word-break: break-all; }
/* section labels + empties */
.sec-label { font-family: var(--font-mono); font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--color-pewter); margin: var(--s-4) 0 var(--s-2); display: flex; gap: var(--s-2); align-items: center; }
.sec-label .n { color: var(--color-steel); }
.empty { padding: var(--s-4); color: var(--color-steel); font-size: var(--text-caption); font-family: var(--font-mono); }
.empty-steps { text-align: left; display: inline-block; line-height: 1.8; }
.meta-row { display: flex; gap: var(--s-2); align-items: center; padding: var(--s-2) var(--s-3); border-bottom: 1px solid var(--color-iron); font-family: var(--font-mono); font-size: 12px; }
.a2-search { margin-left: auto; }
</style>
