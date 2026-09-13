<script setup lang="ts">

/** Pushed sidebar: live device stream with two modes.
 *  watch  — read-only canvas (no lease; never blocks automation)
 *  control — full manual session (lease-held; reuses DrivePage interaction model)
 *  The sidebar is the single mount point for the stream on the wall page —
 *  tiles never embed streams inline anymore. */
import { ref, computed, watch, onUnmounted, onMounted, onBeforeUnmount } from 'vue';
import { useDeviceStream, canvasPointToLogical, isControlLost } from '../composables/deviceStream.ts';
import { useDeviceInput } from '../composables/useDeviceInput.ts';
import { loadBezelDefinition, type BezelDefinition } from '../composables/simdeckChrome.ts';
import { hitTestNodeAt, selectorPreview, sameNodeIn, parentOf, siblingsOf, type AxNode } from '@crucible/shared/ax-tree';
import { useInspectTree, TreeFetchError } from '../composables/useInspectTree.ts';
import { useInspectSample } from '../composables/useInspectSample.ts';
import InspectOverlay from './InspectOverlay.vue';
import InspectRedlines from './InspectRedlines.vue';
import DeviceRail from './DeviceRail.vue';
import InspectProps from './InspectProps.vue';

export interface SidebarDevice { udid: string; name: string | null; os_version: string | null; state: string | null }

const props = defineProps<{
  device: SidebarDevice | null;
  /** wall-side lease info for the blocked-state display (held by / run active) */
  leaseDisplay?: string | null;
  runActive?: boolean;
}>();
const emit = defineEmits<{ (e: 'close'): void }>();

const stream = useDeviceStream();

// ── bezel chrome (backend wrap: the child's definition.json adapted to our
//    markup; absent chrome degrades to the bare canvas below) ─────────────
const bezelDef = ref<BezelDefinition | null>(null);
watch(() => props.device?.udid, async (udid) => {
  bezelDef.value = null;
  if (!udid) return;
  bezelDef.value = await loadBezelDefinition(udid);
}, { immediate: true });

// WebKit (Safari 26) collapses the bezel wrap to 0 width: it ignores
// aspect-ratio-derived width for height-capped blocks AND auto-width for
// block images inside zero-width flex content — both Chrome paths fail
// there. Size it explicitly: fit the bezel's aspect into the stage box,
// width first (height-capped) — height = w / ar so a width-clamped stage
// (tall narrow column) shrinks the box instead of distorting it and
// misaligning the percent-positioned canvas.
const bezelWrapEl = ref<HTMLElement | null>(null);
let wrapObs: ResizeObserver | null = null;
function sizeBezelWrap(): void {
  const wrap = bezelWrapEl.value;
  const def = bezelDef.value;
  if (!wrap || !def) return;
  // constraint box = .stream-stage (the flex stage), NOT stage-frame —
  // stage-frame sizes itself from this wrap, so clamping against it is
  // circular and always yields 0 (the Safari black-stream bug's second act)
  const stage = wrap.closest('.stream-stage') ?? wrap.parentElement;
  if (!stage) return;
  const ar = def.bezel.width / def.bezel.height;
  const w = Math.min(stage.clientHeight * ar, stage.clientWidth);
  wrap.style.width = `${Math.max(0, Math.round(w))}px`;
  wrap.style.height = `${Math.max(0, Math.round(w / ar))}px`;
}
onMounted(() => {
  wrapObs = new ResizeObserver(sizeBezelWrap);
  const stage = bezelWrapEl.value?.closest('.stream-stage') ?? bezelWrapEl.value?.parentElement;
  if (stage) wrapObs.observe(stage);
});
onBeforeUnmount(() => { wrapObs?.disconnect(); wrapObs = null; });
watch([bezelDef, bezelWrapEl], () => sizeBezelWrap(), { flush: 'post' });

// ── bezel hardware buttons: hover pop-out + press dispatch, driven by the
// child's own transform strings (hover pops toward the outside edge) ──
const hoverBtn = ref('');
const pressedBtn = ref('');
async function pressBtn(b: BezelBtnDef): Promise<void> {
  if (!sessionId.value) return;
  await api(`${sessionId.value}/button`, { button: b.name }).catch(() => undefined);
}
function buttonState(b: BezelBtnDef): 'rest' | 'hover' | 'pressed' {
  if (pressedBtn.value === b.name) return 'pressed';
  if (hoverBtn.value === b.name) return 'hover';
  return 'rest';
}
function buttonStyle(b: BezelBtnDef): Record<string, string> {
  return {
    left: `${b.boxPct.left}%`, top: `${b.boxPct.top}%`,
    width: `${b.boxPct.width}%`, height: `${b.boxPct.height}%`,
    transform: b.transform[buttonState(b)],
    transition: 'transform 120ms ease',
  };
}
function buttonSrc(b: BezelBtnDef): string {
  return buttonState(b) === 'pressed' ? b.pressedImageUrl : b.imageUrl;
}
interface BezelBtnDef { name: string; onTop: boolean; boxPct: { left: number; top: number; width: number; height: number }; transform: { rest: string; hover: string; pressed: string }; imageUrl: string; pressedImageUrl: string }

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

// Selection/hover snapshots go STALE on every tree refetch (scroll →
// realign). Re-resolve against the fresh array so the orange ring tracks
// the ELEMENT, not the rect it had when clicked (null = element left the
// screen — honest deselect, keeps ring and card consistent).
watch(tree.nodes, (nodes) => {
  if (selNode.value) selNode.value = sameNodeIn(nodes, selNode.value);
  if (hoverNode.value) hoverNode.value = sameNodeIn(nodes, hoverNode.value);
});

let unsubFrames: (() => void) | null = null;
function toggleInspect(): void {
  inspect.value = !inspect.value;
  devInput.setSuspended(inspect.value); // inspect: clicks select, screen must not move
  if (inspect.value && sessionId.value) {
    tree.enable(sessionId.value);
    if (unsubFrames) unsubFrames();
    unsubFrames = stream.onFrame(tree.feedFrame);
  } else {
    if (unsubFrames) { unsubFrames(); unsubFrames = null; }
    tree.disable();
    hoverNode.value = null; selNode.value = null;
  }
}

function onKey(e: KeyboardEvent): void {
  if ((e.target as HTMLElement)?.matches?.('input, textarea, select')) return;
  if (e.key === 'i' && sessionId.value) {
    e.preventDefault();
    // i = the inspect menu: on when entering the pane, off when leaving it.
    // Pressing i while the pane is open acts as the explicit off.
    if (activeTool.value === 'inspect' && inspect.value) { toggleInspect(); }
    else selectTool('inspect');
  }
  else if (e.key === 'Escape') {
    if (selNode.value) selNode.value = null;
    else if (inspect.value) toggleInspect();
  }
  // 007-A rail: r opens the record pane — checked BEFORE the inspect-shortcut
  // branch (which would swallow it), and never while the key would dispatch
  // to the device as a typed letter (canvas focused + inspect off)
  else if (e.key.toLowerCase() === 'r' && sessionId.value && !e.metaKey && !e.ctrlKey && !e.altKey
    && !(document.activeElement?.tagName === 'CANVAS' && !inspect.value)) {
    e.preventDefault(); activeTool.value = 'record';
  }
  // A2 tool shortcuts — only meaningful while inspecting
  else if (inspect.value && (e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'c') {
    e.preventDefault(); void copySpec(); activeTool.value = 'copy';
  }
  else if (inspect.value && !e.metaKey && !e.ctrlKey && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === 'm') { e.preventDefault(); toolMode.value = toolMode.value === 'measure' ? 'inspect' : 'measure'; }
    else if (k === 't') { e.preventDefault(); showTree.value = !showTree.value; }
    else if (k === 'e') { e.preventDefault(); showEst.value = !showEst.value; }
    else if (k === 's') { e.preventDefault(); void captureShot(); activeTool.value = 'shot'; }
  }
}
window.addEventListener('keydown', onKey);

/** Copy the node spec (JSON): identifiers + geometry + sampled values. */
async function copySpec(): Promise<void> {
  if (!selNode.value) { actionMsg.value = 'select an element first'; return; }
  const n = selNode.value;
  const spec = {
    type: n.type ?? null, identifier: n.identifier ?? null, label: n.label ?? null,
    rect: n.rect ? { x: Math.round(n.rect.x), y: Math.round(n.rect.y), w: Math.round(n.rect.width), h: Math.round(n.rect.height) } : null,
    padding: selParent.value?.rect && n.rect ? {
      top: Math.round(n.rect.y - selParent.value.rect.y),
      left: Math.round(n.rect.x - selParent.value.rect.x),
    } : null,
    text: sample.value?.text ?? null, fill: sample.value?.fill ?? null, radius: sample.value?.radius ?? null,
  };
  try { await navigator.clipboard.writeText(JSON.stringify(spec, null, 2)); actionMsg.value = 'spec copied'; }
  catch { actionMsg.value = 'copy blocked — select the text manually'; }
}

/** Lossless screenshot of the canvas → download (uses the stream's own frame). */
async function captureShot(): Promise<void> {
  const c = stream.canvasRef.value;
  if (!c) { actionMsg.value = 'no canvas'; return; }
  try {
    const url = c.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = `inspect-${selNode.value?.identifier ?? 'screen'}-${Date.now()}.png`;
    a.click();
    actionMsg.value = 'screenshot saved';
  } catch { actionMsg.value = 'capture failed'; }
}

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
// the operator lands on the phase-1 stream, not a dead UI.
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
  // bezel layout insets the canvas inside .stage-frame — chip (absolute in
  // the frame) needs the canvas's frame-space offset added (same class of
  // fix as the tap ripple in onTap)
  const frame = canvas.closest('.stage-frame') as HTMLElement | null;
  const fr = frame ? frame.getBoundingClientRect() : r;
  const ox = r.left - fr.left;
  const oy = r.top - fr.top;
  return {
    x: Math.min(Math.max(ox + hoverXY.value.x - r.left + 10, 4), Math.max(fr.width - 150, 4)),
    y: Math.min(Math.max(oy + hoverXY.value.y - r.top - 26, 4), Math.max(fr.height - 22, 4)),
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

// 007-A rail-swap: which tool panel is shown beside the rail
type DeviceTool = 'session' | 'install' | 'inspect' | 'record' | 'shot' | 'copy';
const activeTool = ref<DeviceTool>('session');
const canInstall = computed(() => phase.value === 'watching');
// A2 inspector tool state: mode drives redlines; tree/estimates are view toggles.
const toolMode = ref<'inspect' | 'measure'>('inspect');
const showTree = ref(false);
const showEst = ref(true);
function selectTool(t: DeviceTool): void {
  // leaving the inspect pane (to any other tool) turns inspect mode OFF —
  // the menu IS the toggle now; entering it (below) is what turns it on
  if (t !== 'inspect' && inspect.value) toggleInspect();
  activeTool.value = t;
  // the inspect pane owns the tree; entering it turns inspect ON
  if (t === 'inspect' && sessionId.value) {
    if (!inspect.value) toggleInspect();
    toolMode.value = 'inspect';       // always land on the inspect section
  }
  // shot/copy are instant actions: run once, the pane shows the outcome
  if (t === 'shot' && sessionId.value) void captureShot();
  if (t === 'copy' && sessionId.value) void copySpec();
}
const selParent = computed<AxNode | null>(() => (selNode.value ? parentOf(tree.nodes.value, selNode.value) : null));
const selSiblings = computed<AxNode[]>(() => (selNode.value ? siblingsOf(tree.nodes.value, selNode.value) : []));
const sampleOn = computed(() => inspect.value && !!selNode.value && tree.state.value === 'aligned');
const { sample, loading: sampleLoading, failed: sampleFailed } = useInspectSample(
  sessionId, selNode, tree.logicalW, sampleOn,
);

// ── device control (engine-direct input) ──
const devInput = useDeviceInput(sessionId, computed(() => ({ w: logicalW.value, h: logicalH.value })), api,
  // any dispatched gesture means the screen may move → the tree must not
  // survive it. 'tap' included: taps that open menus/popovers scroll or
  // shift content, and the tree fetch itself is a couple hundred ms anyway.
  (kind) => { if (kind === 'tap') tree.markInteraction(); else tree.markScroll(); });
// realtime input: gestures ride the stream's own WS when attached
const busy = ref(false);
const error = ref('');
// phase machine: watching (read-only stream) → driving (lease + dispatch)
const phase = ref<'watching' | 'driving'>('watching');
const leaseHeldElsewhere = computed(() => !!props.leaseDisplay && props.leaseDisplay !== meName.value && phase.value === 'watching');
const takeControlBlocked = computed(() => !booted.value || props.runActive === true || leaseHeldElsewhere.value);
const takeControlWhy = computed(() => !booted.value ? 'device not booted' : props.runActive === true ? 'run in progress' : leaseHeldElsewhere.value ? `held by ${props.leaseDisplay}` : '');
// display name of the signed-in user (status line + audit surface) + the
// server's stream format default — avcc (crucible-screenstream is the only engine)
const meName = ref('');
const streamFormat = ref<'avcc' | 'mjpeg' | null>(null);
let startedFormat: 'avcc' | 'mjpeg' | null = null; // set at stream.start
void (async () => {
  try {
    const r = await fetch('/api/auth/me');
    const b = await r.json() as { user?: { name?: string }; streamFormat?: 'avcc' | 'mjpeg' };
    meName.value = b.user?.name ?? '';
    streamFormat.value = b.streamFormat ?? null;
  } catch { /* offline — null lets the server default rule */ }
})();

// late format arrival (sidebar opened before /me resolved): if the server's
// default differs from what we started with, restart in the right mode
watch(streamFormat, (fmt) => {
  if (!fmt || !props.device) return;
  if (startedFormat && startedFormat !== fmt) stream.start(props.device.udid, { format: fmt });
});
const showSystemApps = ref(false);
// app picker: which app the control session opens on (avoids the
// foreground-hijack when the guess is wrong; snapshot still grounds the
// save-time binding)
const appBundleId = ref('');
const appOptions = ref<Array<{ bundleId: string; name: string; running: boolean }>>([]);
let appOptionsLoaded = false;
watch(showSystemApps, () => { appOptionsLoaded = false; loadAppOptions(); });
async function loadAppOptions(): Promise<void> {
  if (!props.device || appOptionsLoaded) return;
  try {
    const res = await fetch(`/api/devices/${props.device.udid}/apps`);
    const body = await res.json() as { apps?: Array<{ bundleId: string; name: string; running: boolean }> };
    if (body.apps) {
      const all = body.apps.filter((a) => !a.bundleId.endsWith('.xctrunner')); // runner stubs never shown
      appOptions.value = all.filter((a) => showSystemApps.value || !a.bundleId.startsWith('com.apple.'));
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
/** deduped picker model: one row per bundle id (newest build as headline),
 *  tiered: build-roots+store = "your apps"; deriveddata = "on this mac" */
interface AppRow { key: string; name: string; bundleId: string; version: string | null; mtimeMs: number; source: string; builds: ArtifactRow[] }
const yourApps = ref<AppRow[]>([]);
const macApps = ref<AppRow[]>([]);
const showMacApps = ref(false);
const expandedRow = ref<string | null>(null);
function buildAppRows(list: ArtifactRow[]): void {
  const byBundle = new Map<string, ArtifactRow[]>();
  for (const a of list) {
    const k = a.bundleId ?? a.path;
    byBundle.set(k, [...(byBundle.get(k) ?? []), a]);
  }
  const row = (builds: ArtifactRow[]): AppRow => {
    const sorted = [...builds].sort((x, y) => y.mtimeMs - x.mtimeMs);
    const head = sorted[0]!;
    // name: prefer the human .app name (LionParcelLogistics), not the store's
    // bundle-timestamped filename — build-source entries carry it
    // store filenames look like <bundle>-<version>-<mtime> (all-lowercase dotted
    // prefix + trailing digit segments); anything else is a human .app name
    const storeName = /^[a-z][a-z0-9]*(\.[a-z0-9-]+)+-\d+(\.\d+)*-\d+$/;
    const humanName = sorted.map((b) => b.path.split('/').pop()?.replace(/\.app$/, '') ?? '')
      .find((n) => n && !storeName.test(n));
    return { key: head.bundleId ?? head.path, name: humanName ?? head.bundleId ?? 'app',
             bundleId: head.bundleId ?? '', version: head.version, mtimeMs: head.mtimeMs, source: head.source, builds: sorted };
  };
  const rows = [...byBundle.values()].map(row).sort((a, b) => b.mtimeMs - a.mtimeMs);
  yourApps.value = rows.filter((r) => r.builds.some((b) => b.source !== 'deriveddata'));
  macApps.value = rows.filter((r) => r.builds.every((b) => b.source === 'deriveddata'));
}
watch(artifacts, (list) => buildAppRows(list));
const ageOf = (ms: number): string => {
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 60 ? `${m}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};
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

// ── stage frame: the canvas sizes by its INTRINSIC bitmap aspect (like watch
// mode) and the frame shrink-wraps it — overlay/chip/ripple span the canvas
// box exactly, so they span the device image. No JS aspect math: the bitmap
// IS the truth; logical dims have lied (320pt squish bug).

// ── lifecycle: device or mode change tears everything down cleanly ──
watch(() => props.device?.udid, () => {
  phase.value = 'watching';
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
  startedFormat = streamFormat.value ?? startedFormat;
  stream.start(props.device.udid, streamFormat.value ? { format: streamFormat.value } : undefined); // every open streams; driving is an escalation
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
  if (udid && booted.value) { startedFormat = streamFormat.value ?? startedFormat; stream.start(udid, streamFormat.value ? { format: streamFormat.value } : undefined); }
}, { immediate: true });

// ── control mode ──
async function startSession(): Promise<void> {
  if (!props.device) return;
  busy.value = true; error.value = '';
  try {
    const res = await fetch('/api/manual/start', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ udid: props.device.udid, ...(appBundleId.value ? { appBundleId: appBundleId.value } : {}) }), // operator = session identity
    });
    const body = await res.json() as { sessionId?: string; logicalW?: number | null; logicalH?: number | null; error?: string };
    if (body.sessionId) {
      sessionId.value = body.sessionId;
      logicalW.value = body.logicalW ?? null;
      logicalH.value = body.logicalH ?? null;
      phase.value = 'driving'; // same canvas, no stream restart
      void loadSteps();
      recordPoll = setInterval(() => void loadSteps(), 1200);
      startHeartbeat();
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
  if (!sessionId.value || !(e.target instanceof HTMLCanvasElement)) return; // taps only dispatch while driving
  if (inspect.value) { onInspectClick(e); return; } // INSPECT: select, never dispatch
  // pointer flow already dispatched this tap (down/up pair) — the click
  // event that follows would double-fire the gesture. Click only carries
  // the ripple + bookkeeping here.
  const canvas = e.target;
  const { x, y } = canvasPointToLogical(canvas, e.clientX, e.clientY, logicalW.value, logicalH.value);
  // ripple position must account for the canvas's offset inside the
  // stage-frame (bezel layout insets the canvas by the screen-rect) —
  // canvas-relative coords painted against the frame land up-left of the
  // cursor by exactly the bezel margin
  const frame = canvas.closest('.stage-frame') as HTMLElement | null;
  const frameRect = frame ? frame.getBoundingClientRect() : canvas.getBoundingClientRect();
  const canvasRect = canvas.getBoundingClientRect();
  ripple.value = {
    x: canvasRect.left - frameRect.left + (e.clientX - canvasRect.left),
    y: canvasRect.top - frameRect.top + (e.clientY - canvasRect.top),
    id: Date.now(),
  };
  if (rippleTimer) clearTimeout(rippleTimer);
  rippleTimer = setTimeout(() => { ripple.value = null; }, 600);
  // the pointer flow (useDeviceInput.onPointerUp) dispatched the tap; keep
  // the click-side bookkeeping only
  lastTap.value = { x, y };
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
  stopHeartbeat();
  if (inspect.value) toggleInspect(); // session-bound tree dies with the session
  phase.value = 'watching';           // release-to-watch: stream keeps flowing
}

// ── driving heartbeat ──
// Direct-WS input bypasses every HTTP route that refreshes last_activity, so
// the server's 5-min idle watchdog would reap the session mid-drive: the
// stream keeps playing while every gesture dies with 'input not granted'.
// One ping a minute keeps the session marked active. 410 = already reaped.
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
function startHeartbeat(): void {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    const id = sessionId.value;
    if (!id || phase.value !== 'driving') return;
    void api(`${id}/heartbeat`).catch(() => undefined);
  }, 60_000);
}
function stopHeartbeat(): void {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

// control-lost: the engine refused input with 'not granted' — the driving
// session died server-side while the stream kept playing. Demote to watching
// (input is inert anyway) and say WHY; silent dead input is the bug this kills.
const controlLostMsg = ref('');
watch(isControlLost(), (lost) => {
  if (!lost || phase.value !== 'driving') return;
  controlLostMsg.value = 'control lost — session ended server-side (idle or restart). take control again to keep driving';
  void endSession();
});
</script>
<template>
  <transition name="sidebar">
    <aside v-if="device" class="sidebar sidebar-wide">
      <header class="sb-head">
        <div>
          <div class="sb-title">{{ device.name ?? device.udid.slice(0, 8) }}</div>
          <div class="sb-sub">
            <span v-if="phase === 'driving'" class="lease-on">● driving{{ meName ? ` · ${meName}` : '' }}</span>
            <span v-else>watching · read-only</span>
            · {{ device.os_version ?? '—' }}
          </div>
        </div>
        <button class="btn btn-sm sb-x" @click="emit('close')">✕</button>
      </header>
      <div v-if="controlLostMsg" class="sb-banner" role="alert">
        ⚠ {{ controlLostMsg }}
        <button class="btn btn-sm" @click="controlLostMsg = ''">dismiss</button>
      </div>

      <!-- ONE cockpit: stream column is persistent across phases (same canvas,
           no teardown flash); only the work column swaps watching vs driving -->
      <div class="sb-body cockpit">
        <div class="devcol">
          <div class="stream-box stream-stage">
            <div class="stage-frame">
              <div v-if="bezelDef" ref="bezelWrapEl" class="bezel-wrap"
                :style="{ aspectRatio: `${bezelDef.bezel.width} / ${bezelDef.bezel.height}` }">
                <img class="bezel-img" :src="bezelDef.bezel.url" :width="bezelDef.bezel.width" :height="bezelDef.bezel.height" alt="" draggable="false" />
                <canvas :ref="stream.setCanvas" class="bezel-screen" tabindex="0"
                  @click="onTap" @mousemove="onCanvasMove"
                  @pointerdown="(e) => devInput.onPointerDown(e, e.target as HTMLCanvasElement)"
                  @pointermove="(e) => devInput.onPointerMove(e, e.target as HTMLCanvasElement)"
                  @pointerup="(e) => devInput.onPointerUp(e, e.target as HTMLCanvasElement)"
                  @pointercancel="(e) => devInput.onPointerUp(e, e.target as HTMLCanvasElement)"
                  @wheel.prevent="(e) => devInput.onWheel(e, e.target as HTMLCanvasElement)"
                  @keydown="devInput.onKeyDown" @blur="devInput.onBlur"
                  :style="{ left: `${bezelDef.screen.xPct}%`, top: `${bezelDef.screen.yPct}%`,
                            width: `${bezelDef.screen.wPct}%`, height: `${bezelDef.screen.hPct}%`,
                            borderRadius: `${bezelDef.screenRadius.pctW}% / ${bezelDef.screenRadius.pctH}%`,
                            cursor: inspect && sessionId ? 'default' : sessionId ? 'crosshair' : 'default', background: 'var(--color-void)', outline: 'none' }"></canvas>
                <!-- overlay rides the SAME pct rect as the canvas, inside the
                     same wrap — aligned by construction (stage-frame-level
                     anchoring spans the bezel image: boxes land on the rails) -->
                <InspectOverlay v-if="inspect && sessionId" :nodes="tree.nodes.value" :logical-w="tree.logicalW.value" :logical-h="tree.logicalH.value"
                  :hover="hoverNode" :selected="selNode" :visible="tree.state.value === 'aligned'"
                  :style="{ left: `${bezelDef.screen.xPct}%`, top: `${bezelDef.screen.yPct}%`,
                            width: `${bezelDef.screen.wPct}%`, height: `${bezelDef.screen.hPct}%` }" />
                <InspectRedlines v-if="inspect && sessionId && selNode" :selected="selNode" :parent="selParent"
                  :siblings="selSiblings" :mode="toolMode" :visible="tree.state.value === 'aligned'"
                  :logical-w="tree.logicalW.value" :logical-h="tree.logicalH.value"
                  :style="{ left: `${bezelDef.screen.xPct}%`, top: `${bezelDef.screen.yPct}%`,
                            width: `${bezelDef.screen.wPct}%`, height: `${bezelDef.screen.hPct}%` }" />
                <!-- bezel hardware buttons: hover pop-out + press dispatch -->
                <img v-for="b in bezelDef.buttons" :key="b.name" class="bezel-btn"
                  :src="buttonSrc(b as BezelBtnDef)" :alt="b.name" draggable="false"
                  :style="buttonStyle(b as BezelBtnDef)"
                  :class="{ 'on-top': b.onTop, armed: !!sessionId }"
                  @pointerenter="hoverBtn = b.name" @pointerleave="hoverBtn = ''"
                  @pointerdown.prevent="pressedBtn = b.name; pressBtn(b as BezelBtnDef)"
                  @pointerup.prevent="pressedBtn = ''; hoverBtn = ''"
                  @pointercancel.prevent="pressedBtn = ''" />
              </div>
              <canvas v-else :ref="stream.setCanvas" tabindex="0"
                @click="onTap" @mousemove="onCanvasMove"
                @pointerdown="(e) => devInput.onPointerDown(e, e.target as HTMLCanvasElement)"
                @pointermove="(e) => devInput.onPointerMove(e, e.target as HTMLCanvasElement)"
                @pointerup="(e) => devInput.onPointerUp(e, e.target as HTMLCanvasElement)"
                @pointercancel="(e) => devInput.onPointerUp(e, e.target as HTMLCanvasElement)"
                @wheel.prevent="(e) => devInput.onWheel(e, e.target as HTMLCanvasElement)"
                @keydown="devInput.onKeyDown" @blur="devInput.onBlur"
                :style="{ display: 'block', cursor: inspect && sessionId ? 'default' : sessionId ? 'crosshair' : 'default', background: 'var(--color-void)', outline: 'none' }"></canvas>
              <!-- chip + ripple: absolutely positioned within .stage-frame —
                   canvas-relative coords need the bezel screen-inset offset
                   (see chipXY / onTap) -->
              <div v-if="inspect && hoverNode && tree.state.value === 'aligned' && sessionId" class="hover-chip"
                :style="{ left: `${chipXY.x}px`, top: `${chipXY.y}px` }">{{ chipName }}</div>
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
          </div>
          <div class="stream-meta">
            <span v-if="stream.state.value === 'live'">{{ stream.fps.value > 0 ? `live · ${stream.fps.value}fps` : 'live · idle (screen unchanged)' }}</span>
            <span v-else>{{ stream.state.value }}</span>
            <span v-if="sessionId && logicalW">{{ logicalW }}pt logical · taps map 1:1</span>
            <span v-else-if="sessionId">connecting dimensions…</span>
          </div>
        </div>

        <!-- tool column (007-A): grouped rail + ONE swap panel -->
        <div class="toolcol">
          <DeviceRail :active="activeTool" :can-install="canInstall" :has-session="!!sessionId" @select="selectTool" />
          <div class="toolpanel">

            <!-- SESSION pane - phase-aware -->
            <div v-if="activeTool === 'session'" class="tpane">
              <template v-if="phase === 'watching'">
                <div class="sect-label"><span>session</span></div>
                <div class="meta-row">
                  <span class="k">app</span>
                  <select v-model="appBundleId" style="flex: 1;">
                    <option value="">auto (best guess)</option>
                    <option v-for="a in appOptions" :key="a.bundleId" :value="a.bundleId">{{ a.name }}</option>
                  </select>
                </div>
                <label class="meta-row" style="cursor: pointer;">
                  <input type="checkbox" v-model="showSystemApps" style="width: auto;" />
                  <span class="k" style="flex: 1;">show system apps</span>
                </label>
                <button class="btn btn-primary" style="width: 100%; margin-top: var(--s-2);" :disabled="busy || takeControlBlocked" @click="startSession">
                  {{ busy ? 'taking control…' : takeControlWhy || 'take control' }}
                </button>
                <div v-if="error" class="form-err" style="margin-top: var(--s-2);">{{ error }}</div>
              </template>
              <template v-else>
                <div class="sect-label"><span>drive</span><span class="sect-state sect-state-on">driving</span></div>
                <div class="row">
                  <div class="dpad">
                    <button :disabled="busy" @click="scroll('up')">↑</button>
                    <button :disabled="busy" @click="scroll('down')">↓</button>
                    <button :disabled="busy" @click="scroll('left')">←</button>
                    <button :disabled="busy" @click="scroll('right')">→</button>
                  </div>
                  <span class="spacer"></span>
                  <button class="btn btn-sm btn-quiet" :disabled="busy" @click="endSession">release</button>
                </div>
                <div class="type-box">
                  <input
                    v-model="typeText"
                    :placeholder="typeArmed ? `type into field @ ${lastTap!.x}, ${lastTap!.y} — enter sends` : 'tap a field on screen, then type here'"
                    :disabled="!typeArmed || busy"
                    @keydown.enter="sendType"
                  />
                  <button class="btn btn-sm" :disabled="!typeArmed || !typeText || busy" @click="sendType">send</button>
                  <button v-if="typeArmed" class="btn btn-sm btn-ghost" @click="lastTap = null; typeText = ''">✕</button>
                </div>
                <div v-if="error" class="form-err" style="margin-top: var(--s-2);">{{ error }}</div>
                <div v-if="busy" class="sect-hint" style="margin-top: var(--s-2);">sending…</div>
              </template>
            </div>

            <!-- INSTALL pane (watching only - rail disables it otherwise) -->
            <div v-else-if="activeTool === 'install'" class="tpane">
              <div class="sect-label"><span>install app</span></div>
              <button v-if="!artifactsLoaded" class="btn btn-sm" @click="loadArtifacts">browse artifacts…</button>
              <template v-else>
                <div v-for="r in yourApps" :key="r.key" class="app-row" :class="{ picked: artifactPick && r.builds.some((b) => b.path === artifactPick) }">
                  <div class="app-row-head" @click="expandedRow = expandedRow === r.key ? null : r.key">
                    <span class="app-name">{{ r.name }}</span>
                    <span class="app-meta">{{ r.version ?? '—' }} · {{ ageOf(r.mtimeMs) }} · {{ r.builds.length > 1 ? `${r.builds.length} builds` : r.source }}</span>
                  </div>
                  <div v-if="expandedRow === r.key" class="app-builds">
                    <div v-for="b in r.builds" :key="b.path" class="app-build" :class="{ picked: artifactPick === b.path }"
                      @click="artifactPick = b.path; appBundleId = r.bundleId">
                      <span>{{ b.path.split('/').pop() }}</span>
                      <span class="app-meta">{{ ageOf(b.mtimeMs) }} · {{ b.source }}</span>
                    </div>
                  </div>
                  <button v-else class="btn btn-sm" style="width: 100%; margin-top: 4px;"
                    @click="artifactPick = r.builds[0]!.path; appBundleId = r.bundleId">use newest</button>
                </div>
                <button v-if="macApps.length" class="btn btn-sm btn-quiet" style="width: 100%; margin-top: var(--s-2);"
                  @click="showMacApps = !showMacApps">{{ showMacApps ? 'hide' : `also on this mac (${macApps.length})` }}</button>
                <template v-if="showMacApps">
                  <div v-for="r in macApps" :key="r.key" class="app-row" :class="{ picked: artifactPick && r.builds.some((b) => b.path === artifactPick) }">
                    <div class="app-row-head" @click="expandedRow = expandedRow === r.key ? null : r.key">
                      <span class="app-name">{{ r.name }}</span>
                      <span class="app-meta">{{ r.version ?? '—' }} · {{ ageOf(r.mtimeMs) }}</span>
                    </div>
                    <div v-if="expandedRow === r.key" class="app-builds">
                      <div v-for="b in r.builds" :key="b.path" class="app-build" :class="{ picked: artifactPick === b.path }"
                        @click="artifactPick = b.path; appBundleId = r.bundleId">
                        <span>{{ b.path.split('/').pop() }}</span>
                        <span class="app-meta">{{ ageOf(b.mtimeMs) }} · {{ b.source }}</span>
                      </div>
                    </div>
                    <button v-else class="btn btn-sm" style="width: 100%; margin-top: 4px;"
                      @click="artifactPick = r.builds[0]!.path; appBundleId = r.bundleId">use newest</button>
                  </div>
                </template>
                <button class="btn" style="width: 100%; margin-top: var(--s-2);" :disabled="installing || !artifactPick" @click="installPicked">
                  {{ installing ? 'installing… (≈12s)' : 'install' }}
                </button>
              </template>
              <div v-if="installMsg" class="sect-hint" style="margin-top: var(--s-2);">{{ installMsg }}</div>
              <div v-if="installErr" class="form-err" style="margin-top: var(--s-2);">{{ installErr }}</div>
            </div>

            <!-- INSPECT pane — the menu IS the inspect toggle; measure lives
                 here as a section, not a separate rail tool -->
            <div v-else-if="activeTool === 'inspect'" class="tpane">
              <div class="sect-label">
                <span>inspect</span>
                <span v-if="inspect" class="sect-state" :class="{ 'sect-state-warn': tree.state.value !== 'aligned' }">{{ treeLabel }}</span>
              </div>
              <div class="row" style="margin-bottom: var(--s-2);">
                <button class="btn btn-sm" :class="{ 'btn-accent': toolMode === 'inspect' }" :disabled="!inspect"
                  title="inspect — click any element on the screen to select it" @click="toolMode = 'inspect'">select</button>
                <button class="btn btn-sm" :class="{ 'btn-accent': toolMode === 'measure' }" :disabled="!inspect"
                  title="measure (m) — spacing redlines: padding to parent, gaps to siblings" @click="toolMode = 'measure'">measure <span class="kbd-hint">m</span></button>
                <span class="spacer"></span>
                <span v-if="inspect" class="sect-state">clicks select, never tap</span>
              </div>
              <div v-if="tree.state.value === 'failed' && (tree.lastError.value as TreeFetchError | null)?.code !== 'SESSION_NOT_FOUND'"
                class="row" style="margin-bottom: var(--s-2);">
                <button class="btn btn-sm" @click="tree.refresh()">retry tree</button>
              </div>
              <div v-if="!selNode" class="sect-hint" style="line-height: 1.8;">
                {{ inspect ? 'click any boxed element on the screen — its card appears here.' : 'toggle inspect, then click any element on the screen.' }}
              </div>
              <template v-else>
                <!-- view toggles that lived in the (removed) inner InspectTools
                     rail — the outer DeviceRail already owns inspect/measure/
                     shot/copy, so a second icon rail here = nested menus -->
                <div class="row" style="margin-bottom: var(--s-2);">
                  <button class="btn btn-sm" :class="{ 'btn-accent': showTree }" :disabled="!inspect"
                    title="tree (t) — show the element hierarchy" @click="showTree = !showTree">tree</button>
                  <button class="btn btn-sm" :class="{ 'btn-accent': showEst }" :disabled="!inspect"
                    title="estimates (e) — show or hide sampled values" @click="showEst = !showEst">estimates</button>
                </div>
                <InspectProps compact :node="selNode" :parent="selParent" :siblings="selSiblings"
                  :sample="sample" :loading="sampleLoading" :failed="sampleFailed" :show-estimates="showEst"
                  :hittable="selNode.hittable ?? false" :path="parentChain(selNode).join(' › ')"
                  :selector-text="selPreview?.text ?? ''" show-actions
                  :tap-disabled="busy || tree.state.value !== 'aligned' || !selNode.hittable"
                  @tap="tapThis" @copy-selector="copySelector" />
              </template>
            </div>

            <!-- RECORD pane -->
            <div v-else-if="activeTool === 'record'" class="tpane">
              <div class="sect-label">
                <span>record</span>
                <span class="sect-state" :class="{ 'sect-state-on': recording }">{{ recording ? '● live' : 'paused' }} · {{ steps.length }} steps</span>
              </div>
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
              <div v-else class="sect-hint" style="margin-top: var(--s-2);">
                {{ recording ? 'every tap / scroll / type will appear here as a step' : 'turn on recording to capture a test config' }}
              </div>
              <div class="row" style="margin-top: var(--s-2); gap: var(--s-2);">
                <button class="btn btn-sm" :class="{ 'btn-danger': recording }" :disabled="busy" @click="toggleRecording">
                  {{ recording ? '● stop recording' : 'record' }}
                </button>
                <template v-if="steps.length > 0">
                  <input v-model="saveName" class="input" placeholder="template name" @keydown.enter="saveAsTemplate" />
                  <button class="btn btn-sm" :disabled="!saveName.trim() || saving" @click="saveAsTemplate">{{ saving ? 'saving…' : 'save as template' }}</button>
                </template>
                <span v-if="savedMsg" class="sect-hint">{{ savedMsg }}</span>
              </div>
            </div>

            <!-- ACTION outcome panes (instant tools) -->
            <div v-else-if="activeTool === 'shot'" class="tpane">
              <div class="sect-label"><span>screenshot</span></div>
              <p class="sect-hint" style="line-height: 1.8;">{{ actionMsg || 'press the camera tool (s) to capture the current screen' }}</p>
              <button class="btn btn-sm" style="margin-top: var(--s-2);" :disabled="!sessionId" @click="captureShot">capture again</button>
            </div>
            <div v-else-if="activeTool === 'copy'" class="tpane">
              <div class="sect-label"><span>copy spec</span></div>
              <p class="sect-hint" style="line-height: 1.8;">{{ actionMsg || 'select an element in inspect, then ⌘⇧C to copy its JSON spec' }}</p>
              <button class="btn btn-sm" style="margin-top: var(--s-2);" :disabled="!selNode" @click="copySpec">copy again</button>
            </div>

          </div>
        </div>
      </div>

    </aside>
  </transition>
</template>

<style scoped>
/* shell */
.sidebar {
  position: fixed;
  top: 0; right: 0; bottom: 0;
  width: min(420px, 92vw);
  background: var(--color-carbon);
  border-left: 1px solid var(--color-iron);
  display: flex; flex-direction: column;
  z-index: 60;
}
.sidebar-wide { width: min(1100px, 96vw); }
.sb-head {
  display: flex; justify-content: space-between; align-items: center;
  padding: 14px 16px 12px;
  border-bottom: 1px solid var(--color-iron);
  flex: 0 0 auto;
}
.sb-title { font-size: 13px; font-weight: 700; letter-spacing: 0.02em; }
.sb-sub { font-size: 10px; color: var(--color-steel); margin-top: 3px; }
.lease-on { color: var(--color-ember); }
.sb-banner {
  display: flex; align-items: center; gap: 8px; justify-content: space-between;
  padding: 7px 16px; font-size: 11px;
  color: var(--color-ember); background: color-mix(in srgb, var(--color-ember) 12%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--color-ember) 30%, transparent);
}
.sb-body { flex: 1; display: flex; flex-direction: column; min-height: 0; overflow-y: auto; padding: 12px; }
.sb-foot {
  flex: 0 0 auto;
  display: flex; justify-content: space-between;
  padding: 9px 16px;
  border-top: 1px solid var(--color-iron);
  background: var(--color-graphite);
  font-size: 9px; color: var(--color-steel);
}
.sb-foot b { color: var(--color-ember); font-weight: 400; }

/* watch mode (unchanged narrow) */
.stream-box { position: relative; }
.stream-overlay {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, 0.55);
  color: var(--color-fog);
  font-size: var(--text-caption);
  line-height: var(--leading-normal); /* stage-frame's line-height:0 inherits here too */
  pointer-events: none;
  flex-direction: column; gap: var(--s-2); padding: var(--s-2); text-align: center;
}
.stream-overlay .stream-retry { pointer-events: auto; }
.stream-meta {
  display: flex; justify-content: space-between;
  font-size: 9px; color: var(--color-steel);
  padding: 6px 2px;
}

/* cockpit */
.cockpit { flex-direction: row; gap: 0; padding: 0; overflow: hidden; }
.devcol {
  flex: 1 1 0; min-width: 0;
  display: flex; flex-direction: column;
  border-right: 1px solid var(--color-iron);
}
.stream-stage { flex: 1 1 auto; min-height: 0; display: flex; align-items: center; justify-content: center; overflow: hidden; }
.stage-frame { position: relative; flex: 0 0 auto; height: 100%; max-width: 100%; line-height: 0; display: flex; align-items: center; justify-content: center; }
/* the bezel IMAGE drives the wrap's box (height-capped, width from its
 * intrinsic aspect) — works in WebKit too, where a bare aspect-ratio on a
 * height:100% block collapses width to 0 (Safari black-stream bug) */
.bezel-wrap { position: relative; height: 100%; max-width: 100%; flex: 0 0 auto; font-size: 0; }
.bezel-img { display: block; height: 100%; width: auto; max-width: 100%; pointer-events: none; user-select: none; -webkit-user-drag: none; }
.bezel-screen { position: absolute; display: block; }
.bezel-btn { position: absolute; z-index: 0; pointer-events: none; user-select: none; -webkit-user-drag: none; }
.bezel-btn.on-top { z-index: 2; }
.bezel-btn.armed { pointer-events: auto; cursor: pointer; }
/* hardware buttons: behind the bezel by default (only the cap past the rail
 * shows); onTop buttons sit in front. Armed = clickable during a session. */
/* canvas: intrinsic aspect (like watch mode), height-capped by the stage;
 * width follows the aspect and can never exceed the stage either */
.stage-frame canvas { height: 100%; width: auto; max-width: 100%; }
.stage-empty {
  width: 100%; height: 100%; min-height: 320px;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  color: var(--color-steel); gap: 8px;
  background: var(--color-void);
}
.stage-empty-title { font-size: 12px; color: var(--color-fog); }
.stage-empty-sub { font-size: 10px; }
.devcol .stream-meta { border-top: 1px solid var(--color-iron); background: var(--color-carbon); padding: 6px 12px; }

.toolcol { flex: 0 0 340px; display: flex; min-height: 0; }
.toolpanel { flex: 1 1 auto; min-width: 0; overflow-y: auto; background: var(--color-carbon); }
.tpane { padding: 12px 14px; }
.sect { padding: 12px 14px; border-bottom: 1px solid var(--color-iron); }
.sect-last { border-bottom: none; }
.sect-label {
  font-size: 9px; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--color-steel); margin-bottom: 9px;
  display: flex; justify-content: space-between; align-items: baseline;
}
.sect-state { color: var(--color-fog); letter-spacing: 0; text-transform: none; font-size: 9px; }
.sect-state-on { color: var(--color-ember); }
.sect-state-warn { color: var(--color-ember); }
.sect-hint { font-size: 9.5px; color: var(--color-steel); }
.form-err { color: var(--color-ember); font-size: 10px; margin-top: var(--s-2); }
.row { display: flex; gap: 8px; align-items: center; }
.spacer { flex: 1; }
.kbd-hint { font-size: 9px; color: var(--color-steel); border: 1px solid var(--color-iron); padding: 2px 6px; border-radius: var(--r-sm); }

.dpad { display: flex; gap: 5px; }
.dpad button {
  width: 36px; height: 32px;
  background: var(--color-void); border: 1px solid var(--color-slate);
  color: var(--color-fog); font-family: inherit; cursor: pointer; font-size: 12px;
}
.dpad button:hover:not(:disabled) { color: var(--color-paper); border-color: var(--color-paper); }
.dpad button:disabled { opacity: 0.4; cursor: default; }
.btn-quiet { border-color: var(--color-pewter); }

.type-box { display: flex; gap: 8px; margin-top: 10px; }
.type-box input { flex: 1; min-width: 0; }

/* element card */
.el-card { border: 1px solid var(--color-iron); background: var(--color-void); padding: 10px 12px; }
.el-name { font-size: 11.5px; font-weight: 700; margin-bottom: 6px; word-break: break-all; }
.krow { display: flex; justify-content: space-between; gap: 10px; padding: 4.5px 0; border-bottom: 1px solid var(--color-iron); font-size: 10.5px; }
.krow:last-of-type { border-bottom: none; }
.krow .k { color: var(--color-steel); font-size: 9px; min-width: 64px; padding-top: 1px; flex: none; }
.krow .v { color: var(--color-paper); text-align: right; word-break: break-all; font-size: 10px; }
.v-dim { color: var(--color-fog); }
.v-ember { color: var(--color-ember); }

/* recorder */
.assert-box { display: flex; gap: 8px; }
.assert-box input { flex: 1; min-width: 0; }
.assert-feedback { font-size: 9.5px; padding: 6px 0 0; }
.steps { margin-top: 8px; }
.step { display: flex; align-items: center; gap: 9px; padding: 7px 0; border-bottom: 1px solid var(--color-iron); }
.step:last-child { border-bottom: none; }
.step-thumb { width: 30px; height: 52px; border-radius: 3px; object-fit: cover; border: 1px solid var(--color-iron); flex: none; }
.step-thumb-empty { display: flex; align-items: center; justify-content: center; color: var(--color-steel); font-size: 9px; }
.step-body { flex: 1; min-width: 0; display: flex; gap: 7px; align-items: baseline; }
.step-idx { color: var(--color-ember); font-size: 10px; flex: none; }
.step-label { font-size: 10px; color: var(--color-fog); word-break: break-word; }
.step-del { flex: none; }

/* hover chip + ripple (inspect) */
.hover-chip {
  position: absolute;
  padding: 2px 8px;
  border-radius: var(--r-sm);
  background: var(--color-void);
  color: var(--color-fog);
  font-size: 10px;
  line-height: 1.4; /* stage-frame sets line-height:0 (inline-canvas kill);
    inherited, it collapses the chip's line box → text paints outside a ~6px box */
  font-family: monospace;
  border: 1px solid var(--color-steel);
  pointer-events: none;
  white-space: nowrap;
  z-index: 2;
}
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

@media (max-width: 860px) {
  .sidebar-wide { width: 96vw; }
  .cockpit { flex-direction: column; }
  .devcol { border-right: none; border-bottom: 1px solid var(--color-iron); flex: 0 0 auto; }
  .stream-stage { min-height: 300px; }
  .toolcol { flex: 1 1 auto; }
}
</style>

<style scoped>
/* deduped app picker rows (install card) */
.app-row { border: 1px solid var(--color-iron); border-radius: var(--r-sm); padding: 6px 8px; margin-bottom: 6px; }
.app-row.picked { border-color: var(--color-fog); }
.app-row-head { display: flex; flex-direction: column; gap: 2px; cursor: pointer; }
.app-name { font-size: var(--text-body); }
.app-meta { font-size: 10px; color: var(--color-steel); }
.app-builds { margin-top: 4px; border-top: 1px solid var(--color-iron); padding-top: 4px; }
.app-build { display: flex; justify-content: space-between; gap: 8px; padding: 3px 4px; cursor: pointer; font-size: 11px; }
.app-build:hover { background: var(--color-iron); }
.app-build.picked { color: var(--color-paper); background: var(--color-iron); }
/* A2 inspector cluster: tool rail beside props, inside the sidebar sect */
</style>
