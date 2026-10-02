<script setup lang="ts">
/** ToolsDrawer — the drive panel's TOOL panes ported to the cockpit (as a
 *  left SideDrawer with tabs): inspect (tree + overlay + redlines + sample +
 *  tap-this + copy selector/spec), record (steps + assert probe + save as
 *  template), install (artifact picker → install). Same routes and logic as
 *  DeviceSidebar; the STAGE owns the session, this drawer receives it. */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { hitTestNodeAt, parentOf, siblingsOf, type AxNode } from '@crucible/shared/ax-tree';
import { useInspectTree, TreeFetchError, type TreeState } from '../../composables/useInspectTree.ts';
import { useInspectSample } from '../../composables/useInspectSample.ts';
import { canvasPointToLogical } from '../../composables/deviceStream.ts';
import InspectTree from '../InspectTree.vue';
import InspectProps from '../InspectProps.vue';
import InspectOverlay from '../InspectOverlay.vue';
import InspectRedlines from '../InspectRedlines.vue';

const props = defineProps<{
  open: boolean;
  tab: 'inspect' | 'record' | 'install';
  udid: string;
  sessionId: string | null;
}>();
const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'inspect-enabled', on: boolean): void;
  (e: 'screenshot'): void;
  (e: 'screen-state', s: string): void;
  (e: 'update:tab', tab: 'inspect' | 'record' | 'install'): void;
}>();

// drawer-local state survives open/close (v-if on the drawer SHELL content is
// fine — tree lifecycle is session-keyed anyway)

// ───────────────────────── inspect ─────────────────────────
const tree = useInspectTree(async (sid, signal) => {
  const res = await fetch(`/api/manual/${sid}/tree`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal,
  });
  if (!res.ok) {
    let code: string | undefined;
    try { code = ((await res.json()) as { code?: string }).code; } catch { /* non-json */ }
    throw new TreeFetchError(`tree ${res.status}`, res.status, code);
  }
  return (await res.json()) as { nodes: AxNode[]; logicalW: number | null; logicalH: number | null };
});
const inspect = computed((): boolean => tree.state.value !== 'off');
const selNode = ref<AxNode | null>(null);
const hoverNode = ref<AxNode | null>(null);
const selParent = computed((): AxNode | null => (selNode.value ? parentOf(tree.nodes.value, selNode.value) : null));
const selSiblings = computed((): AxNode[] => (selNode.value ? siblingsOf(tree.nodes.value, selNode.value) : []));

const sample = useInspectSample(computed(() => props.sessionId), selNode, tree.logicalW, computed(() => props.tab === 'inspect' && props.open));

watch(() => [props.open, props.tab, props.sessionId] as const, ([open, tab, sid]) => {
  if (open && tab === 'inspect' && sid) { if (!inspect.value) tree.enable(sid); }
  else tree.disable();
  if (!open) selNode.value = null;
});
watch(() => props.sessionId, (sid) => { if (sid && props.tab === 'inspect' && props.open) tree.enable(sid); });

let settleInterval = 0 as unknown as ReturnType<typeof setInterval>;
onMounted(() => {
  settleInterval = setInterval(() => { if (inspect.value) tree.tick(Date.now()); }, 1000);
});
onBeforeUnmount(() => { clearInterval(settleInterval); tree.disable(); });

watch(inspect, (on) => emit('inspect-enabled', on));

// stage canvas access — the drawer must hit-test clicks ON THE STAGE canvas
const stageCanvas = (): HTMLCanvasElement | null => {
  const el = document.querySelector('.cockpit .stage canvas');
  return el instanceof HTMLCanvasElement ? el : null;
};
/** called by the PAGE when the stage canvas is clicked while inspect is on */
function stageClick(e: MouseEvent): void {
  if (!props.open || props.tab !== 'inspect') return;
  const canvas = stageCanvas();
  if (!canvas || tree.state.value !== 'aligned') return;
  const { x, y } = canvasPointToLogical(canvas, e.clientX, e.clientY, tree.logicalW.value, tree.logicalH.value);
  selNode.value = hitTestNodeAt(tree.nodes.value, x, y);
}
defineExpose({ stageClick, tree });

const treeLabel = computed((): string => {
  const s: TreeState = tree.state.value;
  if (s === 'aligned') return tree.animating.value ? 'aligned · animating' : 'aligned';
  return s;
});

async function tapThis(): Promise<void> {
  const n = selNode.value;
  if (!n?.rect || !props.sessionId) return;
  tree.markInteraction();
  try {
    const r = await fetch(`/api/manual/${props.sessionId}/tap`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ x: n.rect.x + n.rect.width / 2, y: n.rect.y + n.rect.height / 2 }),
    });
    if (r.status === 410) { emit('close'); return; }
  } catch { /* surfaced by tree realigning */ }
}

async function copy(text: string, what: string): Promise<void> {
  try { await navigator.clipboard.writeText(text); copyMsg.value = `${what} copied`; }
  catch { copyMsg.value = 'clipboard blocked'; }
  setTimeout(() => { copyMsg.value = ''; }, 1600);
}
const copyMsg = ref('');
function selectorText(n: AxNode): string {
  return n.identifier ? `${n.type ?? 'element'}(identifier:"${n.identifier}")` : `${n.type ?? 'element'}(label:"${n.label ?? ''}")`;
}
function copySelector(): void { if (selNode.value) void copy(selectorText(selNode.value), 'selector'); }
function copySpec(): void {
  const n = selNode.value;
  if (!n) return;
  const spec = {
    type: n.type ?? null, identifier: n.identifier ?? null, label: n.label ?? null,
    rect: n.rect ? { x: Math.round(n.rect.x), y: Math.round(n.rect.y), w: Math.round(n.rect.width), h: Math.round(n.rect.height) } : null,
    padding: selParent.value?.rect && n.rect ? {
      top: Math.round(n.rect.y - selParent.value.rect.y),
      left: Math.round(n.rect.x - selParent.value.rect.x),
    } : null,
    text: sample.sample.value?.text ?? null, fill: sample.sample.value?.fill ?? null, radius: sample.sample.value?.radius ?? null,
  };
  void copy(JSON.stringify(spec, null, 2), 'spec');
}

// ───────────────────────── record ─────────────────────────
interface StepRow { idx: number; action: string; label?: string | null; thumb?: string | null; ts?: number }
const recording = ref(false);
const steps = ref<StepRow[]>([]);
const assertText = ref('');
const assertMatched = ref<number | null>(null);
const assertBusy = ref(false);
const assertLabels = ref<string[]>([]);
const saveName = ref('');
const saving = ref(false);
const savedMsg = ref('');
let recordPoll = 0 as unknown as ReturnType<typeof setInterval>;

async function loadSteps(): Promise<void> {
  if (!props.sessionId) return;
  try {
    const r = await fetch(`/api/manual/${props.sessionId}/record`);
    const b = (await r.json()) as { on?: boolean; steps?: StepRow[] };
    recording.value = !!b.on;
    steps.value = b.steps ?? [];
  } catch { /* session ended */ }
}
watch(() => [props.open, props.tab] as const, ([open, tab]) => {
  if (open && tab === 'record') { void loadSteps(); recordPoll = setInterval(() => void loadSteps(), 1200); }
  else { clearInterval(recordPoll); recordPoll = 0 as unknown as ReturnType<typeof setInterval>; }
});
onBeforeUnmount(() => { if (recordPoll) clearInterval(recordPoll); });

async function toggleRecording(): Promise<void> {
  if (!props.sessionId) return;
  try {
    await fetch(`/api/manual/${props.sessionId}/record`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on: !recording.value }),
    });
    await loadSteps();
  } catch { /* next poll */ }
}
async function removeStep(idx: number): Promise<void> {
  if (!props.sessionId) return;
  try {
    await fetch(`/api/manual/${props.sessionId}/record/steps/${idx}/delete`, { method: 'POST' });
    await loadSteps();
  } catch { /* next poll */ }
}
async function probeAssert(): Promise<void> {
  if (!props.sessionId || !assertText.value.trim() || assertBusy.value) return;
  assertBusy.value = true; assertMatched.value = null;
  try {
    const r = await fetch(`/api/manual/${props.sessionId}/probe-selector`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ selector: { label: assertText.value.trim() } }),
    });
    const b = (await r.json()) as { matched?: number; labels?: string[] };
    assertMatched.value = b.matched ?? 0;
    if (b.labels) assertLabels.value = b.labels;
  } catch { assertMatched.value = null; }
  finally { assertBusy.value = false; }
}
async function commitAssert(): Promise<void> {
  if (!props.sessionId || assertMatched.value !== 1) return;
  try {
    await fetch(`/api/manual/${props.sessionId}/record/expect`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ selector: { label: assertText.value.trim() } }),
    });
    assertText.value = ''; assertMatched.value = null;
    await loadSteps();
  } catch { /* next poll */ }
}
async function saveAsTemplate(): Promise<void> {
  if (!props.sessionId || !saveName.value.trim() || saving.value) return;
  saving.value = true; savedMsg.value = '';
  try {
    const r = await fetch(`/api/templates/from-session/${props.sessionId}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: saveName.value }),
    });
    const b = (await r.json()) as { id?: string; error?: string };
    if (b.id) { savedMsg.value = `saved · ${b.id}`; saveName.value = ''; }
    else savedMsg.value = b.error ?? 'save failed';
  } finally { saving.value = false; }
}
function stepLabel(s: StepRow): string {
  if (s.action === 'tap') return `tap @ ${s.label ?? ''}`;
  if (s.action === 'type') return `type "${s.label ?? ''}"`;
  if (s.action === 'scroll') return `scroll ${s.label ?? ''}`;
  if (s.action === 'expect') return `expect ${s.label ?? ''}`;
  return s.action;
}

// ───────────────────────── install ─────────────────────────
interface ArtifactBuild { path: string; mtimeMs: number; source: string }
interface ArtifactApp { key: string; name: string; bundleId: string; version: string | null; mtimeMs: number; source: string; builds: ArtifactBuild[] }
const artifacts = ref<ArtifactApp[]>([]);
const artifactsLoaded = ref(false);
const artifactPick = ref('');
const installing = ref(false);
const installMsg = ref('');
const installErr = ref('');
const expandedRow = ref<string | null>(null);

async function loadArtifacts(): Promise<void> {
  try {
    const r = await fetch(`/api/devices/${encodeURIComponent(props.udid)}/artifacts`);
    const b = (await r.json()) as { artifacts?: ArtifactApp[] };
    artifacts.value = b.artifacts ?? [];
    artifactsLoaded.value = true;
  } catch { installErr.value = 'artifact discovery failed'; }
}
watch(() => [props.open, props.tab] as const, ([open, tab]) => {
  if (open && tab === 'install' && !artifactsLoaded.value) void loadArtifacts();
});
function ageOf(ms: number): string {
  const h = Math.floor((Date.now() - ms) / 3600_000);
  if (h < 1) return `${Math.max(1, Math.floor((Date.now() - ms) / 60_000))}m ago`;
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
async function installPicked(): Promise<void> {
  if (!artifactPick.value || installing.value) return;
  installing.value = true; installMsg.value = ''; installErr.value = '';
  try {
    const r = await fetch(`/api/devices/${encodeURIComponent(props.udid)}/install`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appPath: artifactPick.value }),
    });
    const b = (await r.json()) as { ok?: boolean; version?: string; error?: string };
    if (b.ok) installMsg.value = `installed${b.version ? ` · ${b.version}` : ''}`;
    else installErr.value = b.error ?? 'install failed';
  } catch { installErr.value = 'install request failed'; }
  finally { installing.value = false; }
}

const TABS = [
  { id: 'inspect', label: 'inspect' },
  { id: 'record', label: 'record' },
  { id: 'install', label: 'install' },
] as const;
const tab = computed((): 'inspect' | 'record' | 'install' => props.tab);
void tab;
</script>

<template>
  <div class="tools" v-if="open">
    <div class="tabs">
      <button v-for="t in TABS" :key="t.id" type="button" :class="{ on: tab === t.id }" :disabled="t.id !== 'install' && !sessionId"
        @click="emit('update:tab', t.id)">{{ t.label }}</button>
      <span class="spacer" />
      <button type="button" class="x" title="close" @click="emit('close')">✕</button>
    </div>

    <!-- INSPECT -->
    <div v-if="tab === 'inspect'" class="tpane">
      <div class="sect-label"><span>inspect</span><span v-if="inspect" class="badge" :data-state="tree.state.value">{{ treeLabel }}</span></div>
      <p v-if="!sessionId" class="hint">take control first — inspect needs a live session</p>
      <p v-else-if="inspect && !selNode" class="hint">click any element on the device screen</p>
      <div v-if="tree.state.value === 'failed' && (tree.lastError.value as TreeFetchError | null)?.code !== 'SESSION_NOT_FOUND'" class="row">
        <button class="btn" @click="tree.refresh()">retry snapshot</button>
      </div>
      <InspectTree v-if="inspect && tree.nodes.value.length" class="tree" :nodes="tree.nodes.value" :selected="selNode" @pick="(n) => { selNode = n; }" />
      <template v-if="selNode">
        <InspectProps compact :node="selNode" :parent="selParent" :siblings="selSiblings"
          :sample="sample.sample.value" :loading="sample.loading.value" :failed="sample.failed.value"
          :hittable="selNode.hittable ?? false" :selector-text="selectorText(selNode)" show-actions
          :tap-disabled="tree.state.value !== 'aligned' || !selNode.hittable"
          @tap="tapThis" @copy-selector="copySelector" />
        <div class="row" style="gap: 6px; margin-top: 8px;">
          <button class="btn" :disabled="!selNode" @click="copySpec">copy spec (⌘⇧C)</button>
        </div>
      </template>
      <div v-if="copyMsg" class="hint">{{ copyMsg }}</div>
    </div>

    <!-- RECORD -->
    <div v-else-if="tab === 'record'" class="tpane">
      <div class="sect-label">
        <span>record</span>
        <span class="badge" :class="{ on: recording }">{{ recording ? '● live' : 'paused' }} · {{ steps.length }} steps</span>
      </div>
      <div v-if="!sessionId" class="hint">take control first — recording needs a live session</div>
      <template v-else>
        <div class="assert">
          <input v-model="assertText" list="assert-labels" placeholder="assert screen contains…" :disabled="assertBusy"
            @keydown.enter="assertMatched === 1 ? commitAssert() : probeAssert()" />
          <datalist id="assert-labels">
            <option v-for="l in assertLabels" :key="l" :value="l" />
          </datalist>
          <button class="btn" :disabled="assertBusy || !assertText.trim()" @click="probeAssert" title="check how many elements on the CURRENT screen match this label">check</button>
          <button class="btn primary" :disabled="assertMatched !== 1" @click="commitAssert" title="add as an assertion step — replay fails red if this element disappears">assert</button>
        </div>
        <div v-if="assertMatched !== null" class="hint" :style="{ color: assertMatched === 1 ? 'var(--color-paper)' : 'var(--color-steel)' }">
          {{ assertMatched === 1 ? '✓ 1 match — assertion will check for this' : assertMatched === 0 ? '✕ 0 matches — nothing to assert yet' : `? ${assertMatched} matches — ambiguous, pick a more specific label` }}
        </div>
        <div v-if="steps.length" class="steps">
          <div v-for="s in steps" :key="s.idx" class="step">
            <img v-if="s.thumb" :src="`/api/manual-thumb?path=${encodeURIComponent(s.thumb)}&v=${s.ts}`" class="thumb" loading="lazy" />
            <div v-else class="thumb empty-thumb">—</div>
            <span class="sidx">{{ s.idx + 1 }}</span>
            <span class="slabel">{{ stepLabel(s) }}</span>
            <button class="btn ghost" @click="removeStep(s.idx)">✕</button>
          </div>
        </div>
        <div v-else class="hint">{{ recording ? 'every tap / scroll / type will appear here as a step' : 'turn on recording to capture a test case' }}</div>
        <div class="row" style="gap: 6px; margin-top: 8px;">
          <button class="btn" :class="{ danger: recording }" @click="toggleRecording">{{ recording ? '● stop recording' : 'record' }}</button>
          <template v-if="steps.length">
            <input v-model="saveName" class="input" placeholder="template name" @keydown.enter="saveAsTemplate" />
            <button class="btn" :disabled="!saveName.trim() || saving" @click="saveAsTemplate">{{ saving ? 'saving…' : 'save as template' }}</button>
          </template>
        </div>
        <div v-if="savedMsg" class="hint">{{ savedMsg }}</div>
      </template>
    </div>

    <!-- INSTALL -->
    <div v-else class="tpane">
      <div class="sect-label"><span>install app</span></div>
      <button v-if="!artifactsLoaded" class="btn" @click="loadArtifacts">browse artifacts…</button>
      <template v-else>
        <div v-for="r in artifacts" :key="r.key" class="app-row" :class="{ picked: artifactPick && r.builds.some((b) => b.path === artifactPick) }">
          <div class="app-head" @click="expandedRow = expandedRow === r.key ? null : r.key">
            <span class="app-name">{{ r.name }}</span>
            <span class="app-meta">{{ r.version ?? '—' }} · {{ ageOf(r.mtimeMs) }} · {{ r.builds.length > 1 ? `${r.builds.length} builds` : r.source }}</span>
          </div>
          <div v-if="expandedRow === r.key" class="app-builds">
            <div v-for="b in r.builds" :key="b.path" class="app-build" :class="{ picked: artifactPick === b.path }"
              @click="artifactPick = b.path">
              <span>{{ b.path.split('/').pop() }}</span>
              <span class="app-meta">{{ ageOf(b.mtimeMs) }} · {{ b.source }}</span>
            </div>
          </div>
          <button v-else class="btn" style="width: 100%; margin-top: 4px;"
            @click="artifactPick = r.builds[0]!.path">use newest</button>
        </div>
        <button class="btn primary" style="width: 100%; margin-top: 8px;" :disabled="installing || !artifactPick" @click="installPicked">
          {{ installing ? 'installing… (≈12s)' : 'install' }}
        </button>
      </template>
      <div v-if="installMsg" class="hint">{{ installMsg }}</div>
      <div v-if="installErr" class="err">{{ installErr }}</div>
    </div>
  </div>
</template>

<style scoped>
.tools { position: absolute; top: 40px; left: 0; bottom: 0; width: 340px; z-index: 25; background: var(--color-carbon); border-right: 1px solid var(--color-iron); display: flex; flex-direction: column; }
.tabs { display: flex; gap: 2px; padding: 6px; border-bottom: 1px solid var(--color-iron); }
.tabs button { font-family: inherit; background: none; border: 1px solid transparent; color: var(--color-fog); padding: 3px 12px; cursor: pointer; font-size: var(--text-caption); border-radius: var(--r); }
.tabs button.on { border-color: var(--color-slate); color: var(--color-paper); }
.tabs button:disabled { opacity: .4; cursor: default; }
.tabs .spacer { flex: 1; }
.tabs .x { color: var(--color-fog); }
.tpane { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.sect-label { font-size: 9px; letter-spacing: .14em; text-transform: uppercase; color: var(--color-steel); display: flex; justify-content: space-between; align-items: baseline; }
.badge { border: 1px solid var(--color-iron); color: var(--color-fog); padding: 0 6px; font-size: 9px; }
.badge.on { border-color: var(--color-ember); color: var(--color-ember); }
.hint { color: var(--color-steel); font-size: var(--text-caption); line-height: 1.6; }
.row { display: flex; align-items: center; }
.btn { font-family: inherit; background: none; border: 1px solid var(--color-iron); color: var(--color-fog); padding: 3px 10px; cursor: pointer; font-size: var(--text-caption); border-radius: var(--r); }
.btn:hover:not(:disabled) { border-color: var(--color-slate); color: var(--color-paper); }
.btn:disabled { opacity: .5; cursor: default; }
.btn.primary { background: var(--color-ember); border-color: var(--color-ember); color: #000; font-weight: var(--weight-bold); }
.btn.danger { border-color: var(--color-paper); color: var(--color-paper); }
.btn.ghost { border: none; color: var(--color-steel); padding: 0 4px; }
.input, .assert input { background: var(--color-void); border: 1px solid var(--color-slate); color: var(--color-paper); font-family: inherit; font-size: var(--text-caption); padding: 4px 8px; border-radius: var(--r); outline: none; min-width: 0; }
.assert { display: flex; gap: 4px; }
.assert input { flex: 1; }
.steps { display: flex; flex-direction: column; gap: 4px; }
.step { display: flex; align-items: center; gap: 6px; border: 1px solid var(--color-iron); border-radius: var(--r); padding: 3px 6px; }
.thumb { width: 28px; height: 46px; object-fit: cover; border-radius: 2px; }
.empty-thumb { display: grid; place-items: center; color: var(--color-steel); background: var(--color-void); }
.sidx { color: var(--color-ember); font-size: 10px; min-width: 12px; }
.slabel { flex: 1; color: var(--color-fog); font-size: var(--text-caption); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.app-row { border: 1px solid var(--color-iron); border-radius: var(--r); padding: 6px; }
.app-row.picked { border-color: var(--color-ember); }
.app-head { display: flex; justify-content: space-between; gap: 8px; cursor: pointer; }
.app-name { color: var(--color-paper); font-size: var(--text-caption); }
.app-meta { color: var(--color-steel); font-size: 10px; }
.app-builds { margin-top: 4px; display: flex; flex-direction: column; gap: 2px; }
.app-build { display: flex; justify-content: space-between; gap: 8px; padding: 3px 6px; border-radius: var(--r); cursor: pointer; font-size: 10px; color: var(--color-fog); }
.app-build.picked { border: 1px solid var(--color-ember); color: var(--color-paper); }
.err { color: var(--color-paper); font-size: var(--text-caption); }
.tree { max-height: 40vh; overflow-y: auto; }
</style>
