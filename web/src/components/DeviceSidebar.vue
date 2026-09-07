<script setup lang="ts">
/** Pushed sidebar: live device stream with two modes.
 *  watch  — read-only canvas (no lease; never blocks automation)
 *  control — full manual session (lease-held; reuses DrivePage interaction model)
 *  The sidebar is the single mount point for the stream on the wall page —
 *  tiles never embed streams inline anymore. */
import { ref, computed, watch, onUnmounted } from 'vue';
import { useDeviceStream, canvasPointToLogical } from '../composables/deviceStream.ts';
import { hitTestNodeAt, selectorPreview, type AxNode } from '@crucible/shared/ax-tree';
import { useInspectTree, TreeFetchError } from '../composables/useInspectTree.ts';
import InspectOverlay from './InspectOverlay.vue';

export interface SidebarDevice { udid: string; name: string | null; os_version: string | null; state: string | null }

const props = defineProps<{
  device: SidebarDevice | null;
  mode: 'watch' | 'control';
}>();
const emit = defineEmits<{ (e: 'close'): void }>();

const stream = useDeviceStream();

// ── INSPECT MODE — element boxes over the live stream (control mode only) ──
// Contract: while inspect is ON, a canvas CLICK selects an element and NEVER
// dispatches to the device; wheel/arrows still scroll (navigation, not interaction).
const inspect = ref(false);
const hoverNode = ref<AxNode | null>(null);
const selNode = ref<AxNode | null>(null);
const hoverXY = ref<{ x: number; y: number } | null>(null);
let rafId = 0;

const tree = useInspectTree(async (sid, signal) => {
  const res = await fetch(`/api/manual/${sid}/tree`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal,
  });
  if (!res.ok) {
    let code: string | undefined;
    try { code = ((await res.json()) as { code?: string }).code; } catch { /* non-json */ }
    throw new TreeFetchError(`tree ${res.status}`, res.status, code);
  }
  return await res.json() as { nodes: AxNode[]; logicalW: number | null; logicalH: number | null };
});

function toggleInspect(): void {
  inspect.value = !inspect.value;
  if (inspect.value && sessionId.value) {
    tree.enable(sessionId.value);
    stream.onFrame(tree.feedFrame);
  } else {
    tree.disable();
    hoverNode.value = null; selNode.value = null;
  }
}

function onKey(e: KeyboardEvent): void {
  if ((e.target as HTMLElement)?.matches?.('input, textarea, select')) return;
  if (e.key === 'i' && sessionId.value && props.mode === 'control') { e.preventDefault(); toggleInspect(); }
  else if (e.key === 'Escape') {
    if (selNode.value) selNode.value = null;
    else if (inspect.value) toggleInspect();
  }
}
window.addEventListener('keydown', onKey);

function onCanvasMove(e: MouseEvent): void {
  if (!inspect.value) return;
  const xy = { x: e.clientX, y: e.clientY };
  if (!rafId) rafId = requestAnimationFrame(() => {
    rafId = 0;
    hoverXY.value = xy;
    const canvas = stream.canvasRef.value;
    if (!canvas || tree.state.value !== 'aligned') { hoverNode.value = null; return; }
    const { x, y } = canvasPointToLogical(canvas, xy.x, xy.y, tree.logicalW.value, tree.logicalH.value);
    hoverNode.value = hitTestNodeAt(tree.nodes.value, x, y);
  });
}

// session-dead watcher: a dead manual session (server restart / lease loss)
// surfaces on /tree as 410 SESSION_NOT_FOUND — tear the sidebar session down so
// the operator lands on the take-control form, not a dead UI.
watch(() => tree.state.value, (st) => {
  if (st === 'failed' && (tree.lastError.value as TreeFetchError | null)?.code === 'SESSION_NOT_FOUND') {
    void endSession();
  }
});

let settleInterval: ReturnType<typeof setInterval> | null = null;
function ensureSettleTicker(): void {
  if (settleInterval) return;
  settleInterval = setInterval(() => { if (inspect.value) tree.tick(Date.now()); }, 1000);
}
ensureSettleTicker();

function onInspectClick(e: MouseEvent): void {
  const canvas = stream.canvasRef.value;
  if (!canvas || tree.state.value !== 'aligned') return;
  const { x, y } = canvasPointToLogical(canvas, e.clientX, e.clientY, tree.logicalW.value, tree.logicalH.value);
  selNode.value = hitTestNodeAt(tree.nodes.value, x, y);
}

async function tapThis(): Promise<void> {
  const n = selNode.value;
  if (!n?.rect || !sessionId.value) return;
  tree.markInteraction();
  busy.value = true;
  try {
    const r = await api(`${sessionId.value}/tap`, { x: n.rect.x + n.rect.width / 2, y: n.rect.y + n.rect.height / 2 });
    if (r['error']) error.value = String(r['error']);
  } finally { busy.value = false; }
}

function parentChain(n: AxNode): string[] {
  const out: string[] = [];
  let cur: AxNode | undefined = n;
  while (cur?.parentIndex !== undefined && cur.parentIndex >= 0 && out.length < 4) {
    const p = tree.nodes.value.find((m) => m.index === cur!.parentIndex);
    if (!p) break;
    out.push(p.identifier ?? p.label ?? p.type ?? '?');
    cur = p;
  }
  return out;
}

const selPreview = computed(() => (selNode.value ? selectorPreview(selNode.value) : null));
const chipName = computed(() => {
  const n = hoverNode.value;
  return n ? (n.identifier ?? n.label ?? n.type ?? 'element') : '';
});
const chipXY = computed(() => {
  const canvas = stream.canvasRef.value;
  if (!canvas || !hoverXY.value) return { x: 0, y: 0 };
  const r = canvas.getBoundingClientRect();
  return {
    x: Math.min(Math.max(hoverXY.value.x - r.left + 10, 4), Math.max(r.width - 150, 4)),
    y: Math.min(Math.max(hoverXY.value.y - r.top - 26, 4), Math.max(r.height - 22, 4)),
  };
});
const treeLabel = computed(() => {
  switch (tree.state.value) {
    case 'aligned': return `${tree.nodes.value.length} nodes${tree.animating.value ? ' · animating' : ''}`;
    case 'fetching': return 'loading tree…';
    case 'realigning': return 're-aligning…';
    case 'failed':
      // SESSION_NOT_FOUND: the manual session is gone (server restart / lost
      // lease) — retrying /tree can NEVER succeed; say what to do instead.
      return (tree.lastError.value as TreeFetchError | null)?.code === 'SESSION_NOT_FOUND'
        ? 'session lost — take control again'
        : 'tree unavailable';
    default: return '';
  }
});

async function copySelector(): Promise<void> {
  if (!selPreview.value) return;
  try { await navigator.clipboard.writeText(selPreview.value.text); actionMsg.value = 'selector copied'; }
  catch { actionMsg.value = 'copy blocked — select the text manually'; }
}

const sessionId = ref<string | null>(null);
const logicalW = ref<number | null>(null);
const logicalH = ref<number | null>(null);
const busy = ref(false);
const error = ref('');
const operator = ref('qa');
// app picker: which app the control session opens on (avoids the
// foreground-hijack when the guess is wrong; snapshot still grounds the
// save-time binding)
const appBundleId = ref('');
const appOptions = ref<Array<{ bundleId: string; name: string; running: boolean }>>([]);
let appOptionsLoaded = false;
async function loadAppOptions(): Promise<void> {
  if (!props.device || appOptionsLoaded) return;
  try {
    const res = await fetch(`/api/devices/${props.device.udid}/apps`);
    const body = await res.json() as { apps?: Array<{ bundleId: string; name: string; running: boolean }> };
    if (body.apps) {
      appOptions.value = body.apps.filter((a) => !a.bundleId.startsWith('com.apple.') && !a.bundleId.endsWith('.xctrunner'));
      const runningGuess = appOptions.value.find((a) => a.running);
      if (runningGuess) appBundleId.value = runningGuess.bundleId;
      appOptionsLoaded = true;
    }
  } catch { /* picker stays on auto */ }
}
watch(() => props.device?.udid, () => { appOptionsLoaded = false; appOptions.value = []; appBundleId.value = ''; }, { immediate: true });

// ── install app card: artifact picker (discovery: build dirs + DerivedData
// + the Crucible store, freshest first) → explicit install → refresh list. ──
interface ArtifactRow { path: string; bundleId: string; version: string | null; mtimeMs: number; source: string }
const artifacts = ref<ArtifactRow[]>([]);
const artifactsLoaded = ref(false);
const artifactPick = ref('');
const installing = ref(false);
const installMsg = ref('');
const installErr = ref('');
let artifactsRequested = false;
async function loadArtifacts(): Promise<void> {
  if (!props.device || artifactsRequested) return;
  artifactsRequested = true;
  try {
    const res = await fetch(`/api/devices/${props.device.udid}/artifacts`);
    const body = await res.json() as { artifacts?: ArtifactRow[] };
    artifacts.value = body.artifacts ?? [];
    // preselect: match the picked app bundle, else the freshest row
    const match = artifacts.value.find((a) => a.bundleId === appBundleId.value);
    artifactPick.value = (match ?? artifacts.value[0])?.path ?? '';
    artifactsLoaded.value = true;
  } catch { artifacts.value = []; }
}
watch(() => props.device?.udid, () => { artifactsRequested = false; artifacts.value = []; artifactsLoaded.value = false; artifactPick.value = ''; installMsg.value = ''; installErr.value = ''; }, { immediate: true });
function relAge(ms: number): string {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}
function artifactLabel(a: ArtifactRow): string {
  const v = a.version ? `v${a.version}` : 'unknown';
  const parts = a.path.split('/').filter(Boolean);
  const job = parts.length >= 3 ? parts[parts.length - 3] : (parts[0] ?? a.path);
  return `${v} · ${job} · ${a.source} · ${relAge(a.mtimeMs)}`;
}
async function installPicked(): Promise<void> {
  if (!props.device || !artifactPick.value || installing.value) return;
  installing.value = true; installMsg.value = ''; installErr.value = '';
  try {
    const r = await fetch(`/api/devices/${props.device.udid}/install`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appPath: artifactPick.value }),
    });
    const b = (await r.json()) as { ok?: boolean; version?: string | null; durationMs?: number; error?: string };
    if (!b.ok) { installErr.value = b.error ?? 'install failed'; return; }
    installMsg.value = `installed v${b.version ?? '?'} in ${((b.durationMs ?? 0) / 1000).toFixed(1)}s`;
    // installed list gains the new app — invalidate the cached picker
    appOptionsLoaded = false;
    await loadAppOptions();
  } catch { installErr.value = 'install failed'; }
  finally { installing.value = false; }
}
// note: no `booted` reference here — it's declared later in setup (TDZ); we
// read state directly and let the udid watch reset on device change
watch(() => [props.device?.udid, props.device?.state] as const, ([udid, state]) => { if (udid && state === 'Booted') void loadAppOptions(); }, { immediate: true });
const actionMsg = ref('');

// ── recorder state (control mode) ──
interface StepRow { idx: number; action: string; x?: number; y?: number; direction?: string; text?: string; ts: number; thumb: string | null; selector?: { identifier?: string; label?: string; type?: string } | null }
const recording = ref(false);
const steps = ref<StepRow[]>([]);
let recordPoll: ReturnType<typeof setInterval> | null = null;

async function toggleRecording(): Promise<void> {
  if (!sessionId.value) return;
  try {
    const r = await fetch(`/api/manual/${sessionId.value}/record`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on: !recording.value }),
    });
    const b = (await r.json()) as { on?: boolean; steps?: StepRow[] };
    recording.value = !!b.on;
    steps.value = b.steps ?? [];
  } catch { /* surfaced via loadSteps on next poll */ }
}

async function loadSteps(): Promise<void> {
  if (!sessionId.value) return;
  try {
    const r = await fetch(`/api/manual/${sessionId.value}/record`);
    const b = (await r.json()) as { on?: boolean; steps?: StepRow[] };
    recording.value = !!b.on;
    steps.value = b.steps ?? [];
  } catch { /* session ended */ }
}

async function removeStep(idx: number): Promise<void> {
  if (!sessionId.value) return;
  try {
    const r = await fetch(`/api/manual/${sessionId.value}/record/steps/${idx}/delete`, { method: 'POST' });
    const b = (await r.json()) as { steps?: StepRow[] };
    steps.value = b.steps ?? [];
  } catch { /* ignore */ }
}

// ── save recording as template ──
const saveName = ref('');
const saveTicket = ref('');
const saving = ref(false);
const savedMsg = ref('');

async function saveAsTemplate(): Promise<void> {
  if (!sessionId.value || !saveName.value.trim() || saving.value) return;
  saving.value = true;
  savedMsg.value = '';
  try {
    const r = await fetch(`/api/templates/from-session/${sessionId.value}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: saveName.value, ticketKey: saveTicket.value || undefined }),
    });
    const b = (await r.json()) as { id?: string; error?: string };
    if (b.id) {
      savedMsg.value = `saved · ${b.id}`;
      saveName.value = '';
      saveTicket.value = '';
    } else savedMsg.value = b.error ?? 'failed';
  } catch {
    savedMsg.value = 'failed';
  } finally { saving.value = false; }
}

function stepLabel(s: StepRow): string {
  if (s.action === 'expect') return `expect ${s.selector?.label ?? s.selector?.identifier ?? '?'}`;
  if (s.action === 'tap') return `tap ${s.x},${s.y}`;
  if (s.action === 'scroll') return `scroll ${s.direction}`;
  if (s.action === 'type') return `type "${(s.text ?? '').slice(0, 14)}${(s.text ?? '').length > 14 ? '…' : ''}"`;
  return s.action;
}

// ── A7 assertion authoring: probe the live screen before committing ──
const assertText = ref('');
const assertLabels = ref<string[]>([]);
const assertMatched = ref<number | null>(null);
const assertBusy = ref(false);

async function probeAssert(): Promise<void> {
  if (!sessionId.value || !assertText.value.trim() || assertBusy.value) return;
  assertBusy.value = true;
  assertMatched.value = null;
  try {
    const r = await fetch(`/api/manual/${sessionId.value}/probe-selector`, {
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
  if (!sessionId.value || !assertText.value.trim()) return;
  if (assertMatched.value !== 1) return; // must probe to exactly 1 first
  try {
    const r = await fetch(`/api/manual/${sessionId.value}/record/expect`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ selector: { label: assertText.value.trim() } }),
    });
    const b = (await r.json()) as { steps?: StepRow[] };
    steps.value = b.steps ?? steps.value;
    assertText.value = '';
    assertMatched.value = null;
  } catch { /* ignore — steps poll refreshes */ }
}

const booted = computed(() => props.device?.state === 'Booted');

// ── lifecycle: device or mode change tears everything down cleanly ──
watch(() => [props.device?.udid, props.mode] as const, () => {
  void reset();
});
onUnmounted(() => {
  window.removeEventListener('keydown', onKey);
  if (settleInterval) { clearInterval(settleInterval); settleInterval = null; }
  if (rafId) cancelAnimationFrame(rafId);
  void teardownSession(); stream.stop();
});

async function reset(): Promise<void> {
  await teardownSession();
  stream.stop();
  error.value = '';
  if (!props.device) return;
  if (props.mode === 'watch') {
    stream.start(props.device.udid);
  }
  // control mode: session starts on explicit "take control" (lease acquisition)
}

async function teardownSession(): Promise<void> {
  const id = sessionId.value;
  sessionId.value = null;
  if (recordPoll) { clearInterval(recordPoll); recordPoll = null; }
  recording.value = false;
  steps.value = [];
  if (id) {
    try { await fetch(`/api/manual/${id}/finish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note: 'sidebar:closed' }) }); } catch { /* idempotent server-side */ }
  }
}

// ── watch mode ──
watch(() => props.device?.udid, (udid) => {
  if (udid && props.mode === 'watch' && booted.value) stream.start(udid);
}, { immediate: true });

// ── control mode ──
async function startSession(): Promise<void> {
  if (!props.device) return;
  busy.value = true; error.value = '';
  try {
    const res = await fetch('/api/manual/start', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ udid: props.device.udid, operator: operator.value, ...(appBundleId.value ? { appBundleId: appBundleId.value } : {}) }),
    });
    const body = await res.json() as { sessionId?: string; logicalW?: number | null; logicalH?: number | null; error?: string };
    if (body.sessionId) {
      sessionId.value = body.sessionId;
      logicalW.value = body.logicalW ?? null;
      logicalH.value = body.logicalH ?? null;
      stream.start(props.device.udid);
      void loadSteps();
      recordPoll = setInterval(() => void loadSteps(), 1200);
    } else error.value = body.error ?? 'failed to start';
  } finally { busy.value = false; }
}

async function api(path: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`/api/manual/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
  });
  return (await res.json()) as Record<string, unknown>;
}

/** After a tap/scroll the engine's screen-change detector decides when the next
 *  MJPEG frame ships (~0.5fps idle). Pull ONE screenshot so the operator sees
 *  the effect immediately; the live stream then resumes. */
async function fastPathFrame(): Promise<void> {
  if (!sessionId.value) return;
  try {
    const r = await api(`${sessionId.value}/snapshot`);
    const path = r['path'] as string | undefined;
    if (path && stream.canvasRef.value) {
      const img = new Image();
      img.onload = () => {
        const canvas = stream.canvasRef.value;
        if (canvas) {
          const ctx = canvas.getContext('2d');
          if (ctx) { canvas.width = img.naturalWidth; canvas.height = img.naturalHeight; ctx.drawImage(img, 0, 0); }
        }
      };
      img.src = `/api/manual-frame?path=${encodeURIComponent(path)}&t=${Date.now()}`;
    }
  } catch { /* fast-path only */ }
}

// ── tap: send → ripple → snapshot fast-path ──
const ripple = ref<{ x: number; y: number; id: number } | null>(null);
let rippleTimer: ReturnType<typeof setTimeout> | null = null;
// last tap (logical coords) arms the type target — "tap a field, then type"
const lastTap = ref<{ x: number; y: number } | null>(null);
const typeText = ref('');
const typeArmed = computed(() => lastTap.value !== null);

async function onTap(e: MouseEvent): Promise<void> {
  if (props.mode !== 'control' || !sessionId.value || !(e.target instanceof HTMLCanvasElement)) return;
  if (inspect.value) { onInspectClick(e); return; } // INSPECT: select, never dispatch
  const canvas = e.target;
  const { x, y } = canvasPointToLogical(canvas, e.clientX, e.clientY, logicalW.value, logicalH.value);
  ripple.value = { x: e.clientX - canvas.getBoundingClientRect().left, y: e.clientY - canvas.getBoundingClientRect().top, id: Date.now() };
  if (rippleTimer) clearTimeout(rippleTimer);
  rippleTimer = setTimeout(() => { ripple.value = null; }, 600);
  busy.value = true;
  actionMsg.value = '';
  try {
    const r = await api(`${sessionId.value}/tap`, { x, y });
    if (r['error']) {
      error.value = String(r['error']);
      if (String(r['code']) === 'LEASE_LOST' || String(r['code']) === 'SESSION_NOT_FOUND') void endSession();
    } else {
      lastTap.value = { x, y }; // arm typing at this field
      await fastPathFrame();
    }
  } finally { busy.value = false; }
}

async function sendType(): Promise<void> {
  if (!sessionId.value || !lastTap.value || !typeText.value) return;
  busy.value = true;
  try {
    const r = await api(`${sessionId.value}/type`, { x: lastTap.value.x, y: lastTap.value.y, text: typeText.value });
    if (r['error']) {
      error.value = String(r['error']);
      if (String(r['code']) === 'LEASE_LOST' || String(r['code']) === 'SESSION_NOT_FOUND') void endSession();
    } else {
      typeText.value = '';
      await fastPathFrame();
    }
  } finally { busy.value = false; }
}

async function scroll(direction: string): Promise<void> {
  if (!sessionId.value) return;
  if (inspect.value) tree.markScroll();
  busy.value = true;
  try {
    const r = await api(`${sessionId.value}/scroll`, { direction });
    if (r['error']) {
      error.value = String(r['error']);
      if (String(r['code']) === 'LEASE_LOST' || String(r['code']) === 'SESSION_NOT_FOUND') void endSession();
    } else await fastPathFrame();
  } finally { busy.value = false; }
}

async function endSession(): Promise<void> {
  await teardownSession();
  stream.stop();
}
</script>

<template>
  <transition name="sidebar">
    <aside v-if="device" class="sidebar">
      <header class="sidebar-head">
        <div>
          <div class="sidebar-title">{{ device.name ?? device.udid.slice(0, 8) }}</div>
          <div class="sidebar-sub">
            {{ device.os_version ?? '—' }} · {{ mode === 'watch' ? 'read-only' : 'manual control' }}
          </div>
        </div>
        <button class="btn btn-sm" @click="emit('close')">✕</button>
      </header>

      <!-- watch: stream only -->
      <div v-if="mode === 'watch'" class="sidebar-body">
        <div class="stream-box">
          <canvas :ref="stream.setCanvas" style="width: 100%; display: block; background: var(--color-void); min-height: 160px;"></canvas>
          <div v-if="stream.state.value !== 'live'" class="stream-overlay">
            <span v-if="stream.state.value === 'connecting'">connecting to device stream…</span>
            <span v-else-if="stream.state.value === 'paused'">run in progress — stream paused</span>
            <span v-else-if="stream.state.value === 'reconnecting'">stream reconnecting…</span>
            <template v-else-if="stream.state.value === 'failed'">
              <span>{{ stream.failure.value || 'stream unavailable' }}</span>
              <button v-if="stream.retryable.value" class="btn btn-sm stream-retry" @click="stream.retry()">retry stream</button>
            </template>
          </div>
        </div>
        <div class="stream-meta">
          <span v-if="stream.state.value === 'live'">{{ stream.fps.value > 0 ? `live · ${stream.fps.value}fps` : 'live · idle (screen unchanged)' }}</span>
          <span v-else>{{ stream.state.value }}</span>
          <span>read-only · does not hold the device</span>
        </div>
        <button class="btn" style="width: 100%; margin-top: var(--s-3);" @click="emit('close')">close</button>
      </div>

      <!-- control: lease + interactions -->
      <div v-else class="sidebar-body">
        <div v-if="!sessionId" class="card" style="padding: var(--s-3);">
          <div class="meta-row"><span class="k">operator</span><input v-model="operator" style="width: 140px; " /></div>
          <div class="meta-row">
            <span class="k">app</span>
            <select v-model="appBundleId" style="flex: 1;">
              <option value="">auto (best guess)</option>
              <option v-for="a in appOptions" :key="a.bundleId" :value="a.bundleId">{{ a.name }}</option>
            </select>
          </div>
          <button class="btn btn-primary" style="width: 100%; margin-top: var(--s-3);" :disabled="busy || !booted" @click="startSession">
            {{ busy ? 'starting…' : booted ? 'acquire & take control' : 'device not booted' }}
          </button>
          <div v-if="error" class="meta-row" style="color: var(--color-ember); margin-top: var(--s-2);">{{ error }}</div>
        </div>

        <!-- install app: discovery picker → explicit install (repo/DerivedData
             are pick sources only; the server clones into its own store) -->
        <div v-if="booted && !sessionId" class="card" style="padding: var(--s-3); margin-top: var(--s-2);">
          <div class="card-header" style="margin-bottom: var(--s-2);">
            <span class="card-title">install app</span>
          </div>
          <button v-if="!artifactsLoaded" class="btn btn-sm" @click="loadArtifacts">browse artifacts…</button>
          <template v-else-if="artifacts.length > 0">
            <div class="meta-row">
              <span class="k">artifact</span>
              <select v-model="artifactPick" style="flex: 1;">
                <option v-for="a in artifacts" :key="a.path" :value="a.path">
                  {{ a.bundleId === appBundleId || !appBundleId ? artifactLabel(a) : `${artifactLabel(a)} (${a.bundleId})` }}
                </option>
              </select>
            </div>
            <button class="btn" style="width: 100%; margin-top: var(--s-2);" :disabled="installing || !artifactPick" @click="installPicked">
              {{ installing ? 'installing… (≈12s)' : 'install' }}
            </button>
          </template>
          <div v-else class="meta-row" style="color: var(--color-steel);">no artifacts found on disk — build the app first</div>
          <div v-if="installMsg" class="meta-row" style="margin-top: var(--s-2);">{{ installMsg }}</div>
          <div v-if="installErr" class="meta-row" style="color: var(--color-ember); margin-top: var(--s-2);">{{ installErr }}</div>
        </div>

        <template v-else>
          <div class="stream-box">
            <canvas :ref="stream.setCanvas" @click="onTap"
              style="width: 100%; display: block; cursor: crosshair; background: var(--color-void); min-height: 200px;"></canvas>
            <div v-if="ripple" class="tap-ripple" :style="{ left: `${ripple.x}px`, top: `${ripple.y}px` }" />
            <div v-if="stream.state.value !== 'live'" class="stream-overlay">
              <span v-if="stream.state.value === 'connecting'">connecting to device stream…</span>
              <span v-else-if="stream.state.value === 'paused'">run in progress — stream paused</span>
            <span v-else-if="stream.state.value === 'reconnecting'">stream reconnecting…</span>
              <template v-else-if="stream.state.value === 'failed'">
                <span>{{ stream.failure.value || 'stream unavailable' }}</span>
                <button v-if="stream.retryable.value" class="btn btn-sm stream-retry" @click="stream.retry()">retry stream</button>
              </template>
            </div>
          </div>
          <div class="stream-meta">
            <span v-if="stream.state.value === 'live'">{{ stream.fps.value > 0 ? `live · ${stream.fps.value}fps` : 'live · idle (screen unchanged)' }}</span>
            <span v-else>{{ stream.state.value }}</span>
            <span>{{ logicalW ? `${logicalW}pt logical · taps map 1:1` : 'tap anywhere on screen' }}</span>
          </div>
          <div v-if="error" class="meta-row" style="color: var(--color-ember); margin-top: var(--s-2);">{{ error }}</div>
          <div class="type-box">
            <input
              v-model="typeText"
              :placeholder="typeArmed ? `type into field @ ${lastTap!.x},${lastTap!.y} — enter to send` : 'tap a field on screen first, then type here'"
              :disabled="!typeArmed || busy"
              @keydown.enter="sendType"
            />
            <button class="btn btn-sm" :disabled="!typeArmed || !typeText || busy" @click="sendType">send</button>
            <button v-if="typeArmed" class="btn btn-sm btn-ghost" @click="lastTap = null; typeText = ''">✕</button>
          </div>
          <div style="display: flex; gap: var(--s-2); margin-top: var(--s-2); align-items: center;">
            <button class="btn btn-sm" :class="{ 'btn-accent': inspect }" @click="toggleInspect"
              :title="'inspect (i) — ' + (inspect ? 'clicks select, never tap' : 'show element boxes')">◎ inspect</button>
            <template v-if="inspect">
              <span class="badge" :class="tree.state.value === 'aligned' ? 'badge-accent' : ''">{{ treeLabel }}</span>
              <button v-if="tree.state.value === 'failed' && (tree.lastError.value as TreeFetchError | null)?.code !== 'SESSION_NOT_FOUND'" class="btn btn-sm" @click="tree.refresh()">retry tree</button>
            </template>
            <span style="flex: 1;"></span>
            <button class="btn btn-sm" :disabled="busy" @click="scroll('up')">↑</button>
            <button class="btn btn-sm" :disabled="busy" @click="scroll('down')">↓</button>
            <button class="btn btn-sm" :disabled="busy" @click="scroll('left')">←</button>
            <button class="btn btn-sm" :disabled="busy" @click="scroll('right')">→</button>
            <button class="btn btn-sm btn-danger" :disabled="busy" @click="endSession">release</button>
          </div>
          <div v-if="busy" class="meta-row" style="margin-top: var(--s-2); color: var(--color-ash);">sending…</div>

          <div v-if="inspect && selNode" class="card inspect-drawer">
            <div style="font-size: 13px; font-weight: 600;">{{ selNode.identifier || selNode.label || selNode.type || 'element' }}</div>
            <div class="meta-row"><span class="k">type</span><span>{{ selNode.type ?? '—' }}</span></div>
            <div class="meta-row"><span class="k">identifier</span><span style="font-family: monospace;">{{ selNode.identifier ?? '—' }}</span></div>
            <div class="meta-row"><span class="k">label</span><span>{{ selNode.label ?? '—' }}</span></div>
            <div class="meta-row" v-if="selNode.rect"><span class="k">rect</span><span style="font-family: monospace;">x{{ Math.round(selNode.rect.x) }} y{{ Math.round(selNode.rect.y) }} · {{ Math.round(selNode.rect.width) }}×{{ Math.round(selNode.rect.height) }}pt</span></div>
            <div class="meta-row"><span class="k">hittable</span><span>{{ selNode.hittable ? 'yes' : 'no' }}</span></div>
            <div class="meta-row" v-if="parentChain(selNode).length"><span class="k">path</span><span style="font-family: monospace; font-size: 10px;">{{ parentChain(selNode).join(' › ') }}</span></div>
            <div class="meta-row"><span class="k">selector</span><span style="font-family: monospace; color: var(--color-accent);">on: {{ selPreview?.text }}</span></div>
            <div style="display: flex; gap: var(--s-2); margin-top: var(--s-2);">
              <button class="btn btn-sm" @click="copySelector">copy selector</button>
              <button class="btn btn-sm btn-primary" :disabled="busy || tree.state.value !== 'aligned' || !selNode.hittable" @click="tapThis">tap this</button>
            </div>
          </div>

          <!-- recorder: live config preview -->
          <div class="recorder">
            <div class="recorder-head">
              <button class="btn btn-sm" :class="{ 'btn-danger': recording }" :disabled="busy" @click="toggleRecording">
                {{ recording ? '● recording' : 'record' }}
              </button>
              <span style="font-size: 10px; color: var(--color-steel);">{{ steps.length }} steps</span>
            </div>
            <!-- A7: assertion authoring — probe the live screen, commit on exactly-1 match -->
            <div class="assert-box">
              <input
                v-model="assertText"
                list="assert-labels"
                placeholder="assert screen contains…"
                :disabled="assertBusy"
                @keydown.enter="assertMatched === 1 ? commitAssert() : probeAssert()"
              />
              <datalist id="assert-labels">
                <option v-for="l in assertLabels" :key="l" :value="l" />
              </datalist>
              <button class="btn btn-sm" :disabled="assertBusy || !assertText.trim()" @click="probeAssert" title="check how many elements on the CURRENT screen match this label">check</button>
              <button class="btn btn-sm btn-primary" :disabled="assertMatched !== 1" @click="commitAssert" title="add as an assertion step — replay fails red if this element disappears">assert</button>
            </div>
            <div v-if="assertMatched !== null" class="assert-feedback" :style="{ color: assertMatched === 1 ? 'var(--color-paper)' : 'var(--color-ash)' }">
              {{ assertMatched === 1 ? '✓ 1 match — assertion will check for this' : assertMatched === 0 ? '✕ 0 matches — nothing to assert yet' : `? ${assertMatched} matches — ambiguous, pick a more specific label` }}
            </div>
            <div v-if="steps.length > 0" class="steps">
              <div v-for="s in steps" :key="s.idx" class="step">
                <img v-if="s.thumb" :src="`/api/manual-thumb?path=${encodeURIComponent(s.thumb)}&v=${s.ts}`" class="step-thumb" loading="lazy" />
                <div v-else class="step-thumb step-thumb-empty">—</div>
                <div class="step-body">
                  <span class="step-idx">{{ s.idx + 1 }}</span>
                  <span class="step-label">{{ stepLabel(s) }}</span>
                </div>
                <button class="btn btn-sm btn-ghost step-del" @click="removeStep(s.idx)">✕</button>
              </div>
            </div>
            <div v-else style="font-size: 10px; color: var(--color-steel); margin-top: var(--s-2);">
              {{ recording ? 'every tap / scroll / type will appear here as a step' : 'turn on recording to capture a test config' }}
            </div>
            <div v-if="steps.length > 0" class="save-tpl">
              <input v-model="saveName" class="input" placeholder="template name" @keydown.enter="saveAsTemplate" />
              <input v-model="saveTicket" class="input" placeholder="ticket (LP-123, optional)" />
              <button class="btn btn-sm" :disabled="!saveName.trim() || saving" @click="saveAsTemplate">{{ saving ? 'saving…' : 'save as template' }}</button>
              <span v-if="savedMsg" style="font-size: 10px; color: var(--color-steel);">{{ savedMsg }}</span>
            </div>
          </div>
        </template>
      </div>
    </aside>
  </transition>
</template>

<style scoped>
.hover-chip {
  position: absolute;
  padding: 2px 8px;
  border-radius: var(--r-sm);
  background: var(--color-void);
  color: var(--color-fog);
  font-size: 10px;
  font-family: monospace;
  border: 1px solid var(--color-steel);
  pointer-events: none;
  white-space: nowrap;
  z-index: 2;
}
.inspect-drawer { margin-top: var(--s-2); padding: var(--s-2); }
.sidebar {
  position: fixed;
  top: 0; right: 0; bottom: 0;
  width: min(420px, 92vw);
  background: var(--color-ink, #101014);
  border-left: 1px solid var(--color-iron);
  box-shadow: -18px 0 48px rgba(0, 0, 0, 0.5);
  z-index: 60;
  display: flex;
  flex-direction: column;
}
.sidebar-head {
  display: flex; justify-content: space-between; align-items: center;
  padding: var(--s-3) var(--s-4);
  border-bottom: 1px solid var(--color-iron);
}
.sidebar-title { font-size: var(--text-h3, 15px); color: var(--color-paper); }
.sidebar-sub { font-size: var(--text-caption); color: var(--color-steel); }
.sidebar-body { padding: var(--s-3) var(--s-4); overflow-y: auto; flex: 1; }
.stream-box { position: relative; border: 1px solid var(--color-iron); border-radius: var(--r-sm); overflow: hidden; }
.stream-meta {
  display: flex; justify-content: space-between;
  font-size: 10px; color: var(--color-steel); margin-top: 4px;
}
.type-box {
  display: flex; gap: var(--s-2); margin-top: var(--s-2);
}
.type-box input { flex: 1; }
.recorder { margin-top: var(--s-4); border-top: 1px solid var(--color-iron); padding-top: var(--s-3); }
.assert-box { display: flex; gap: var(--s-2); margin-top: var(--s-2); }
.assert-box input { flex: 1; min-width: 0; }
.assert-feedback { font-size: 10px; margin-top: 4px; }
.recorder-head { display: flex; align-items: center; gap: var(--s-2); }
.steps { margin-top: var(--s-2); display: flex; flex-direction: column; gap: var(--s-2); max-height: 300px; overflow-y: auto; }
.step { display: flex; align-items: center; gap: var(--s-2); }
.step-thumb {
  width: 36px; height: 64px; object-fit: cover; border-radius: 3px;
  border: 1px solid var(--color-iron); background: var(--color-void); flex: none;
}
.step-thumb-empty { display: flex; align-items: center; justify-content: center; color: var(--color-steel); font-size: 10px; }
.step-body { flex: 1; min-width: 0; font-size: 11px; }
.step-idx { color: var(--color-steel); margin-right: 6px; }
.step-label { color: var(--color-fog); }
.step-del { opacity: 0; }
.step:hover .step-del { opacity: 1; }
.save-tpl { display: flex; gap: var(--s-2); margin-top: var(--s-3); align-items: center; flex-wrap: wrap; }
.save-tpl .input { flex: 1; min-width: 100px; }
.stream-overlay {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, 0.55);
  color: var(--color-fog);
  font-size: var(--text-caption);
  pointer-events: none;
}
/* failed state with a retry button: stack message + action, make ONLY the
 * button clickable (canvas interactions stay dead while the stream is down) */
.stream-overlay:has(.stream-retry) { flex-direction: column; gap: var(--s-2); padding: var(--s-2); text-align: center; }
.stream-overlay .stream-retry { pointer-events: auto; }
.tap-ripple {
  position: absolute;
  width: 28px; height: 28px;
  border: 2px solid var(--color-ember);
  border-radius: 50%;
  transform: translate(-50%, -50%);
  pointer-events: none;
  animation: ripple-out 0.6s ease-out forwards;
}
@keyframes ripple-out {
  from { opacity: 0.9; scale: 0.4; }
  to { opacity: 0; scale: 1.6; }
}
.sidebar-enter-active, .sidebar-leave-active { transition: transform 0.22s ease, opacity 0.22s ease; }
.sidebar-enter-from, .sidebar-leave-to { transform: translateX(100%); opacity: 0; }
</style>
