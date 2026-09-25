<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import PageHeader from '../components/PageHeader.vue';
import { stateHolds, type SnapNode } from '@crucible/shared/app-screens';

/** Screens page (A2, registry-UI stage 1) — the registry in the house row
 *  idiom: bundle sections (.section-label), screens as hairline-divided
 *  rows (id · entry · refresh · #states · used-by), click to expand the
 *  state list. Data: /api/apps/screens + templates usage join. */

interface ScreenSelector { identifier?: string; label?: string; labelContains?: string; ignoreCase?: boolean; point?: [number, number] }
interface AppScreen {
  id: string;
  entry: { tab?: ScreenSelector & { point?: [number, number] }; deepLink?: string; navigate?: Array<Record<string, unknown>> };
  refresh?: { gesture: string; selector?: ScreenSelector & { point?: [number, number] }; back?: ScreenSelector & { point?: [number, number] }; deepLink?: string };
  states: Record<string, { all?: ScreenSelector[]; any?: ScreenSelector[] }>;
}
type BundleScreens = { bundle: string; screens: AppScreen[] };

const bundles = ref<BundleScreens[]>([]);
const loading = ref(true);
const error = ref('');
const openId = ref<string | null>(null); // expanded screen row
const usage = ref<Record<string, string[]>>({});
const revisions = ref<Record<string, number>>({}); // per-bundle — one registry each
const editing = ref<string | null>(null); // screen id being edited
const newStates = ref<Record<string, { name: string; kind: 'identifier' | 'labelContains' | 'label'; value: string }>>({});
const saveMsg = ref('');
const saveErr = ref('');

// ── stage 3: live probe (B1 dialog) ──
interface ProbeNode { index: number; label?: string; identifier?: string; type?: string; rect?: { x: number; y: number; width: number; height: number } }
const probe = ref<{ open: boolean; bundle: string; screenId: string; sessionId: string | null; nodes: ProbeNode[]; filter: string; sel: ProbeNode | null; busy: string; err: string }>({
  open: false, bundle: '', screenId: '', sessionId: null, nodes: [], filter: '', sel: null, busy: '', err: '',
});
const booted = ref<Array<{ udid: string; name: string | null }>>([]);

// ── stage-2 completion: whole-screen editor (create + edit entry/refresh) ──
type EntryMode = 'tab' | 'deepLink' | 'navigate';
interface EditorForm {
  mode: 'create' | 'edit';
  bundle: string;
  originalId: string | null; // edit: the id being changed (rename support)
  id: string;
  entryMode: EntryMode;
  entryLabel: string;
  entryPoint: string;        // "x,y" for tab; url for deepLink; "n" taps placeholder for navigate
  refreshGesture: string;    // '' = none
  refreshAwayId: string;     // identifier of the away anchor
  refreshBackLabel: string;  // label of the back anchor
  refreshBackPoint: string;  // "x,y"
}
const editor = ref<EditorForm | null>(null);
const editorErr = ref('');

function openCreate(bundle: string): void {
  editor.value = { mode: 'create', bundle, originalId: null, id: '', entryMode: 'tab', entryLabel: '', entryPoint: '', refreshGesture: '', refreshAwayId: '', refreshBackLabel: '', refreshBackPoint: '' };
  editorErr.value = '';
}

// first screen of a brand-new app: the page-level entry. Sections only exist
// for bundles with rows — this breaks the chicken-and-egg without curl.
const newApp = ref<{ open: boolean; bundle: string }>({ open: false, bundle: '' });
const knownApps = ref<string[]>([]);

async function openNewApp(): Promise<void> {
  newApp.value = { open: true, bundle: '' };
  editorErr.value = '';
  // autocomplete source: bundles the server already knows — registry apps,
  // cases' app_bundle_id, installed artifacts. Typo prevention, not a gate.
  try {
    const [reg, tpls] = await Promise.all([
      (await fetch('/api/apps/screens')).json() as Promise<{ registries: Array<{ bundle: string }> }>,
      (await fetch('/api/templates')).json() as Promise<{ templates: Array<{ appBundleId?: string | null }> }>,
    ]);
    const set = new Set<string>();
    for (const r of reg.registries ?? []) set.add(r.bundle);
    for (const t of tpls.templates ?? []) if (t.appBundleId) set.add(t.appBundleId);
    knownApps.value = [...set].sort();
  } catch { knownApps.value = []; }
}

function confirmNewApp(): void {
  const b = newApp.value.bundle.trim();
  if (!/^([a-z0-9-]+\.)+[a-z0-9-]+$/i.test(b)) { editorErr.value = 'bundle id looks wrong — reverse-DNS, e.g. com.lionparcel.services.consumer'; return; }
  if (bundles.value.some((x) => x.bundle === b)) { editorErr.value = 'this app already has a registry section below'; return; }
  newApp.value.open = false;
  bundles.value = [...bundles.value, { bundle: b, screens: [] }]; // empty section; register persists it
  openCreate(b);
}
function openEditScreen(s: AppScreen, bundle: string): void {
  const e = s.entry;
  const r = s.refresh;
  editor.value = {
    mode: 'edit', bundle, originalId: s.id, id: s.id,
    entryMode: e.tab ? 'tab' : e.deepLink ? 'deepLink' : 'navigate',
    entryLabel: e.tab?.label ?? '',
    entryPoint: e.tab?.point ? e.tab.point.join(',') : e.deepLink ?? '',
    refreshGesture: r?.gesture ?? '',
    refreshAwayId: r?.selector?.identifier ?? '',
    refreshBackLabel: r?.back?.label ?? '',
    refreshBackPoint: r?.back?.point ? r.back.point.join(',') : '',
  };
  editorErr.value = '';
}
/** parse "x,y" → [x, y]; null when malformed */
function parsePoint(v: string): [number, number] | null {
  const m = /^\s*(\d+)\s*,\s*(\d+)\s*$/.exec(v);
  return m ? [Number(m[1]), Number(m[2])] : null;
}
/** form → AppScreen; returns null + editorErr when invalid (named, inline) */
function formToScreen(f: EditorForm): AppScreen | null {
  if (!/^[a-z][a-z0-9-]*$/.test(f.id)) { editorErr.value = 'screen id must be [a-z][a-z0-9-]*'; return null; }
  let entry: AppScreen['entry'];
  if (f.entryMode === 'tab') {
    if (!f.entryLabel.trim()) { editorErr.value = 'tab entry needs a label'; return null; }
    const pt = f.entryPoint.trim() ? parsePoint(f.entryPoint) : null;
    if (f.entryPoint.trim() && !pt) { editorErr.value = 'entry point must be "x,y"'; return null; }
    entry = { tab: { label: f.entryLabel.trim(), ...(pt ? { point: pt } : {}) } };
  } else if (f.entryMode === 'deepLink') {
    if (!f.entryPoint.trim()) { editorErr.value = 'deep link entry needs a url'; return null; }
    entry = { deepLink: f.entryPoint.trim() };
  } else {
    entry = { navigate: [] };
    editorErr.value = 'navigate entries are recorded, not authored — use the manual recorder'; return null;
  }
  let refresh: AppScreen['refresh'];
  if (f.refreshGesture === 'back-forward') {
    if (!f.refreshAwayId.trim()) { editorErr.value = 'back-forward needs the away anchor identifier'; return null; }
    const bp = f.refreshBackPoint.trim() ? parsePoint(f.refreshBackPoint) : null;
    if (f.refreshBackPoint.trim() && !bp) { editorErr.value = 'back point must be "x,y"'; return null; }
    refresh = { gesture: 'back-forward', selector: { identifier: f.refreshAwayId.trim() }, ...(f.refreshBackLabel.trim() || bp ? { back: { ...(f.refreshBackLabel.trim() ? { label: f.refreshBackLabel.trim() } : {}), ...(bp ? { point: bp } : {}) } } : {}) };
  } else if (f.refreshGesture === 'tab-retap') {
    if (!f.refreshAwayId.trim()) { editorErr.value = 'tab-retap needs a selector identifier'; return null; }
    refresh = { gesture: 'tab-retap', selector: { identifier: f.refreshAwayId.trim() } };
  } else if (f.refreshGesture === 'pull') {
    refresh = { gesture: 'pull' };
  } else if (f.refreshGesture === 'deepLink') {
    if (!f.refreshAwayId.trim()) { editorErr.value = 'deepLink refresh needs the url'; return null; }
    refresh = { gesture: 'deepLink', deepLink: f.refreshAwayId.trim() };
  } else if (f.refreshGesture === 'signal') {
    refresh = { gesture: 'signal' };
  }
  // states ride along: create starts with a loaded placeholder the probe/form replaces
  const existing = bundles.value.find((x) => x.bundle === f.bundle)?.screens.find((s) => s.id === (f.mode === 'edit' ? f.originalId : f.id));
  const states = existing?.states ?? { loaded: { all: [{ label: f.id }] } };
  return { id: f.id, entry, ...(refresh ? { refresh } : {}), states };
}
async function saveScreen(): Promise<void> {
  const f = editor.value;
  if (!f) return;
  const scr = formToScreen(f);
  if (!scr) return;
  const b = bundles.value.find((x) => x.bundle === f.bundle);
  if (!b) return;
  const screens = f.mode === 'create'
    ? [...b.screens, scr]
    : b.screens.map((s) => (s.id === f.originalId ? scr : s));
  const res = await fetch(`/api/apps/${encodeURIComponent(f.bundle)}/screens`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ screens, revision: revisions.value[b.bundle] }) });
  if (res.ok) {
    const d = (await res.json()) as { revision: number };
    revisions.value[b.bundle] = d.revision;
    b.screens = screens;
    editor.value = null;
    saveMsg.value = f.mode === 'create' ? `screen "${scr.id}" registered` : `screen "${scr.id}" saved`;
    saveErr.value = '';
  } else if (res.status === 409) {
    const d = (await res.json()) as { screens: AppScreen[]; revision: number };
    b.screens = d.screens;
    revisions.value[b.bundle] = d.revision;
    editorErr.value = 'registry changed while editing — review and re-save';
  } else {
    const d = (await res.json()) as { errors?: string[]; error?: string };
    editorErr.value = (d.errors ?? [d.error ?? 'save failed']).join(' · ');
  }
}
async function deleteScreen(s: AppScreen, bundle: string): Promise<void> {
  if (!window.confirm(`delete screen "${s.id}" and all its states?`)) return;
  const b = bundles.value.find((x) => x.bundle === bundle);
  if (!b) return;
  const screens = b.screens.filter((x) => x.id !== s.id);
  const res = await fetch(`/api/apps/${encodeURIComponent(bundle)}/screens`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ screens, revision: revisions.value[b.bundle] }) });
  if (res.ok) {
    const d = (await res.json()) as { revision: number };
    revisions.value[b.bundle] = d.revision;
    b.screens = screens;
    saveMsg.value = `screen "${s.id}" deleted`;
  } else if (res.status === 409) {
    const d = (await res.json()) as { screens: AppScreen[]; revision: number };
    b.screens = d.screens;
    revisions.value[b.bundle] = d.revision;
    saveErr.value = 'registry changed — review and retry';
  } else {
    const d = (await res.json()) as { errors?: string[]; error?: string };
    saveErr.value = (d.errors ?? [d.error ?? 'delete failed']).join(' · ');
  }
}

// yaml import/export modal (plan 2c) — rides the server round-trip
const yamlModal = ref<{ bundle: string; text: string } | null>(null);
const yamlErr = ref('');
async function openYaml(bundle: string): Promise<void> {
  const res = await fetch(`/api/apps/${encodeURIComponent(bundle)}/screens.yaml`);
  yamlModal.value = { bundle, text: await res.text() };
  yamlErr.value = '';
}
async function importYaml(): Promise<void> {
  const y = yamlModal.value;
  if (!y) return;
  const res = await fetch(`/api/apps/${encodeURIComponent(y.bundle)}/screens.yaml`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ yaml: y.text }) });
  if (res.ok) {
    // re-fetch the registry + revision (yaml path is revisionless by design)
    const g = await (await fetch(`/api/apps/${encodeURIComponent(y.bundle)}/screens`)).json() as { screens: AppScreen[]; revision: number };
    const b = bundles.value.find((x) => x.bundle === y.bundle);
    if (b) b.screens = g.screens;
    revisions.value[y.bundle] = g.revision;
    yamlModal.value = null;
    saveMsg.value = 'registry imported from yaml';
  } else {
    const d = (await res.json()) as { errors?: string[] };
    yamlErr.value = (d.errors ?? ['import failed']).join(' · ');
  }
}

// stage 3b: verify-against-live — run a state's selector-set against the
// probe tree using the SAME stateHolds the runner asserts with (one
// definition of "holds"; F1 moved it to shared for exactly this)
const verify = ref<Record<string, { status: 'checking' | 'holds' | 'fails'; at: number }>>({});

async function verifyState(s: AppScreen, bundle: string, name: string): Promise<void> {
  const key = `${bundle}/${s.id}/${name}`;
  verify.value[key] = { status: 'checking', at: Date.now() };
  try {
    if (booted.value.length === 0) {
      try {
        const d = await (await fetch('/api/devices')).json() as { devices: Array<{ udid: string; state: string; name: string | null }> };
        booted.value = (d.devices ?? []).filter((x) => x.state === 'Booted').map((x) => ({ udid: x.udid, name: x.name }));
      } catch { booted.value = []; }
    }
    if (booted.value.length === 0) { verify.value[key] = { status: 'fails', at: Date.now() }; saveErr.value = 'no booted device to verify against'; return; }
    const res = await fetch(`/api/probe/${encodeURIComponent(booted.value[0]!.udid)}/tree`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: probe.value.sessionId, bundle }) });
    if (!res.ok) { verify.value[key] = { status: 'fails', at: Date.now() }; saveErr.value = ((await res.json()) as { error?: string }).error ?? 'probe failed'; return; }
    const d = (await res.json()) as { sessionId: string; nodes: SnapNode[] };
    probe.value.sessionId = d.sessionId;
    const def = s.states[name];
    if (!def) { verify.value[key] = { status: 'fails', at: Date.now() }; return; }
    verify.value[key] = { status: stateHolds(d.nodes, def) ? 'holds' : 'fails', at: Date.now() };
    saveErr.value = '';
  } catch (e) {
    verify.value[key] = { status: 'fails', at: Date.now() };
    saveErr.value = e instanceof Error ? e.message : String(e);
  }
}

async function openProbe(s: AppScreen, bundle: string): Promise<void> {
  saveErr.value = '';
  try {
    const d = await (await fetch('/api/devices')).json() as { devices: Array<{ udid: string; state: string; name: string | null }> };
    booted.value = (d.devices ?? []).filter((x) => x.state === 'Booted').map((x) => ({ udid: x.udid, name: x.name }));
  } catch { booted.value = []; }
  probe.value = { open: true, bundle, screenId: s.id, sessionId: null, nodes: [], filter: '', sel: null, busy: '', err: '' };
  if (booted.value.length > 0) await fetchTree(booted.value[0]!.udid);
}
async function fetchTree(udid: string): Promise<void> {
  probe.value.busy = 'fetching tree…';
  probe.value.err = '';
  try {
    const res = await fetch(`/api/probe/${encodeURIComponent(udid)}/tree`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: probe.value.sessionId, bundle: probe.value.bundle }) });
    if (res.status === 410) { // session expired — retry fresh (F5)
      probe.value.sessionId = null;
      return fetchTree(udid);
    }
    if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? `probe failed (${res.status})`);
    const d = (await res.json()) as { sessionId: string; nodes: ProbeNode[] };
    probe.value.sessionId = d.sessionId;
    probe.value.nodes = d.nodes.filter((n) => (n.label ?? '') !== '' || (n.identifier ?? '') !== '');
    probe.value.sel = null;
  } catch (e) {
    probe.value.err = e instanceof Error ? e.message : String(e);
  } finally {
    probe.value.busy = '';
  }
}
const filteredNodes = computed(() => {
  const f = probe.value.filter.trim().toLowerCase();
  const list = probe.value.nodes;
  if (!f) return list.slice(0, 200);
  return list.filter((n) => (n.label ?? '').toLowerCase().includes(f) || (n.identifier ?? '').toLowerCase().includes(f)).slice(0, 200);
});
/** identifier preferred, label fallback — selectorMatches' own order (F6) */
function proposeSelector(n: ProbeNode): { kind: 'identifier' | 'label'; value: string } | null {
  if (n.identifier) return { kind: 'identifier', value: n.identifier };
  if (n.label) return { kind: 'label', value: n.label };
  return null;
}
/** add the picked element as a state on the probe's screen (reuses addState's
 *  PUT path by injecting into the form + submitting) */
async function addPickedAsState(): Promise<void> {
  const n = probe.value.sel;
  if (!n) return;
  const prop = proposeSelector(n);
  if (!prop) { probe.value.err = 'element has neither identifier nor label'; return; }
  const b = bundles.value.find((x) => x.bundle === probe.value.bundle);
  const s = b?.screens.find((x) => x.id === probe.value.screenId);
  if (!b || !s) return;
  const name = window.prompt(`state name for ${prop.kind} "${prop.value}"`) ?? '';
  if (!name.trim()) return;
  const sel = prop.kind === 'identifier' ? { identifier: prop.value } : { label: prop.value };
  const updated: AppScreen = { ...s, states: { ...s.states, [name.trim()]: { all: [sel] } } };
  const payload = { screens: b.screens.map((x) => (x.id === s.id ? updated : x)), revision: revisions.value[b.bundle] };
  const res = await fetch(`/api/apps/${encodeURIComponent(probe.value.bundle)}/screens`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  if (res.ok) {
    const d = (await res.json()) as { revision: number };
    revisions.value[b.bundle] = d.revision;
    b.screens = payload.screens;
    probe.value.open = false;
    saveMsg.value = `state "${name.trim()}" added from live element`;
  } else if (res.status === 409) {
    const d = (await res.json()) as { screens: AppScreen[]; revision: number };
    b.screens = d.screens;
    revisions.value[b.bundle] = d.revision;
    probe.value.err = 'registry changed while editing — review the screen and re-pick';
  } else {
    const d = (await res.json()) as { errors?: string[]; error?: string };
    probe.value.err = (d.errors ?? [d.error ?? 'save failed']).join(' · ');
  }
}

function toggle(s: AppScreen): void {
  openId.value = openId.value === s.id ? null : s.id;
  if (openId.value === s.id) {
    editing.value = null;
    saveMsg.value = '';
    saveErr.value = '';
  }
}
function beginEdit(s: AppScreen): void {
  editing.value = s.id;
  newStates.value[s.id] = { name: '', kind: 'identifier', value: '' };
  saveMsg.value = '';
  saveErr.value = '';
}
/** add one state from the inline form → PUT the whole registry (revision-
 *  guarded); 422 errors render verbatim; 409 offers the current registry */
async function addState(s: AppScreen, bundle: string): Promise<void> {
  const form = newStates.value[s.id]!;
  const name = form.name.trim();
  const value = form.value.trim();
  if (!name || !value) { saveErr.value = 'state name and value required'; return; }
  const sel = form.kind === 'identifier' ? { identifier: value } : form.kind === 'labelContains' ? { labelContains: value } : { label: value };
  const updated: AppScreen = { ...s, states: { ...s.states, [name]: { all: [sel] } } };
  const b = bundles.value.find((x) => x.bundle === bundle);
  if (!b) return;
  const payload = { screens: b.screens.map((x) => (x.id === s.id ? updated : x)), revision: revisions.value[b.bundle] };
  const res = await fetch(`/api/apps/${encodeURIComponent(bundle)}/screens`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  if (res.ok) {
    const d = (await res.json()) as { revision: number };
    revisions.value[b.bundle] = d.revision;
    b.screens = payload.screens;
    newStates.value[s.id] = { name: '', kind: form.kind, value: '' };
    saveMsg.value = `state "${name}" added`;
    saveErr.value = '';
  } else if (res.status === 409) {
    const d = (await res.json()) as { screens: AppScreen[]; revision: number };
    b.screens = d.screens; // adopt the current registry; the user re-applies
    revisions.value[b.bundle] = d.revision;
    saveErr.value = 'registry changed while you were editing — your form is kept; re-apply to retry';
  } else {
    const d = (await res.json()) as { errors?: string[]; error?: string };
    saveErr.value = (d.errors ?? [d.error ?? 'save failed']).join(' · ');
  }
}
/** delete a state → PUT the registry without it (confirm per house pattern) */
async function removeState(s: AppScreen, bundle: string, name: string): Promise<void> {
  if (!window.confirm(`delete state "${name}" from ${s.id}?`)) return;
  const b = bundles.value.find((x) => x.bundle === bundle);
  if (!b) return;
  const states = { ...s.states };
  delete states[name];
  const updated: AppScreen = { ...s, states };
  const payload = { screens: b.screens.map((x) => (x.id === s.id ? updated : x)), revision: revisions.value[b.bundle] };
  const res = await fetch(`/api/apps/${encodeURIComponent(bundle)}/screens`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  if (res.ok) {
    const d = (await res.json()) as { revision: number };
    revisions.value[b.bundle] = d.revision;
    b.screens = payload.screens;
    saveMsg.value = `state "${name}" removed`;
    saveErr.value = '';
  } else if (res.status === 409) {
    const d = (await res.json()) as { screens: AppScreen[]; revision: number };
    b.screens = d.screens;
    revisions.value[b.bundle] = d.revision;
    saveErr.value = 'registry changed while you were editing — review and retry';
  } else {
    const d = (await res.json()) as { errors?: string[]; error?: string };
    saveErr.value = (d.errors ?? [d.error ?? 'save failed']).join(' · ');
  }
}

onMounted(async () => {
  try {
    const res = await fetch('/api/apps/screens');
    if (res.status === 404) { bundles.value = []; return; }
    if (!res.ok) throw new Error(`registry fetch failed (${res.status})`);
    const d = (await res.json()) as { registries: Array<{ bundle: string; screens: AppScreen[] }> };
    bundles.value = d.registries.map((r) => ({ bundle: r.bundle, screens: r.screens }));
    const t = await (await fetch('/api/templates')).json() as { templates: Array<{ name: string; steps: Array<{ action: string; screen?: string; expectScreen?: { screen: string } }> }> };
    const use: Record<string, string[]> = {};
    for (const tpl of t.templates ?? []) {
      for (const s of tpl.steps ?? []) {
        const target = s.action === 'arrive' || s.action === 'refresh' ? s.screen : s.action === 'expectScreen' ? s.expectScreen?.screen : undefined;
        if (!target) continue;
        const list = (use[target] ??= []);
        if (!list.includes(tpl.name)) list.push(tpl.name); // once per case, not per step
      }
    }
    usage.value = use;
    for (const r of d.registries) {
      const g = await (await fetch(`/api/apps/${encodeURIComponent(r.bundle)}/screens`)).json() as { revision: number };
      revisions.value[r.bundle] = g.revision;
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
});

/** selector → compact reading (expanded rows carry the detail; row cells
 *  stay terse — the full sentence was the old page's noise) */
function describeSelector(sel: ScreenSelector): string {
  if (sel.identifier) return sel.identifier;
  if (sel.label) return `"${sel.label}"${sel.ignoreCase ? ' ·ci' : ''}`;
  if (sel.labelContains) return `~"${sel.labelContains}"${sel.ignoreCase ? '' : ''}`;
  return '?';
}
function describeEntry(s: AppScreen): string {
  if (s.entry.tab) return `tab ${s.entry.tab.label ?? s.entry.tab.identifier ?? '?'}${s.entry.tab.point ? ` @${s.entry.tab.point.join(',')}` : ''}`;
  if (s.entry.deepLink) return s.entry.deepLink;
  if (s.entry.navigate) return `${s.entry.navigate.length} taps`;
  return '?';
}
function describeRefresh(s: AppScreen): string {
  const r = s.refresh;
  if (!r) return '—';
  const nm = (sel?: ScreenSelector & { point?: [number, number] }) => sel ? (sel.label ?? sel.identifier ?? (sel.point ? `${sel.point.join(',')}` : '?')) : null;
  if (r.gesture === 'back-forward') return `back-fwd · ${nm(r.selector) ?? '?'} → ${nm(r.back) ?? 'entry'}`;
  if (r.gesture === 'tab-retap') return `retap ${nm(r.selector) ?? ''}`.trim();
  if (r.gesture === 'deepLink') return r.deepLink ?? '?';
  return r.gesture;
}
function verifyResult(v: { status: 'checking' | 'holds' | 'fails'; at: number }): string {
  if (v.status === 'checking') return '…';
  if (v.status === 'holds') return '✓ holds';
  return '✗ not on screen';
}

function stateDef(def: { all?: ScreenSelector[]; any?: ScreenSelector[] }): string {
  const parts: string[] = [];
  if (def.all?.length) parts.push(`all: ${def.all.map(describeSelector).join(' + ')}`);
  if (def.any?.length) parts.push(`any: ${def.any.map(describeSelector).join(' / ')}`);
  return parts.join(' · ') || '—';
}
</script>

<template>
  <PageHeader title="screens" desc="per-app screen registry — what each screen is, how to enter and refresh it, the states cases assert on">
    <template #actions>
      <button class="mini-act" title="register the first screen of a new app" @click="openNewApp">+ app</button>
    </template>
  </PageHeader>
  <div v-if="loading" class="hint">loading registries…</div>
  <div v-else-if="error" class="hint err">{{ error }}</div>
  <div v-else-if="bundles.length === 0" class="hint">no screens registered yet — register one below</div>

  <div v-for="b in bundles" :key="b.bundle" class="registry">
    <div class="section-label bundle-row">
      <span>{{ b.bundle }}</span>
      <span class="bundle-acts">
        <button class="mini-act" title="register a new screen" @click="openCreate(b.bundle)">+ screen</button>
        <button class="mini-act" title="import/export the registry as yaml" @click="openYaml(b.bundle)">yaml</button>
      </span>
    </div>

    <div class="scr-thead">
      <span class="col-id">screen</span>
      <span class="col-entry">entry</span>
      <span class="col-refresh">refresh</span>
      <span class="col-states">states</span>
      <span class="col-used">used by</span>
      <span class="col-acts"></span>
    </div>

    <div v-if="b.screens.length === 0" class="hint inset">no screens yet — <button class="inline-link" @click="openCreate(b.bundle)">register the first one</button></div>

    <article v-for="s in b.screens" :key="s.id" class="scr-card" :class="{ editing: editing === s.id }">
      <div class="scr-row" :title="openId === s.id ? 'collapse' : 'expand states'" @click="toggle(s)">
        <span class="col-id"><span class="scr-id">{{ s.id }}</span></span>
        <span class="col-entry">{{ describeEntry(s) }}</span>
        <span class="col-refresh">{{ describeRefresh(s) }}</span>
        <span class="col-states">{{ Object.keys(s.states).length }}</span>
        <span class="col-used" :title="usage[s.id]?.join(', ')">{{ usage[s.id]?.length ? usage[s.id]!.join(', ') : '—' }}</span>
        <span class="col-acts" @click.stop>
          <button class="c-act" title="edit entry/refresh" @click="openEditScreen(s, b.bundle)">edit</button>
          <button class="c-act" title="add/remove states, probe a live device" @click="beginEdit(s)">states</button>
          <button class="c-act danger" title="delete this screen" @click="deleteScreen(s, b.bundle)">delete</button>
        </span>
      </div>

      <!-- expanded: states as a sub-table of the same idiom -->
      <div v-if="openId === s.id" class="scr-body">
        <div class="st-thead">
          <span class="st-col-nm">state</span>
          <span class="st-col-def">asserts</span>
          <span class="st-col-acts"></span>
        </div>
        <div v-for="(def, name) in s.states" :key="name" class="st-row">
          <span class="st-col-nm">{{ name }}</span>
          <span class="st-col-def">{{ stateDef(def) }}</span>
          <span class="st-col-acts">
            <button v-if="editing === s.id" class="st-verify" title="run this state's selectors against the live tree" @click="verifyState(s, b.bundle, name)">verify live</button>
            <span v-if="verify[b.bundle + '/' + s.id + '/' + name]" class="st-vres" :class="verify[b.bundle + '/' + s.id + '/' + name]!.status">{{ verifyResult(verify[b.bundle + '/' + s.id + '/' + name]!) }}</span>
            <button v-if="editing === s.id" class="st-del" title="delete this state" @click="removeState(s, b.bundle, name)">delete</button>
          </span>
        </div>
        <div v-if="editing === s.id" class="add-state">
          <select v-model="newStates[s.id]!.kind" class="as-kind" title="selector kind">
            <option value="identifier">identifier</option>
            <option value="labelContains">contains</option>
            <option value="label">label</option>
          </select>
          <input v-model="newStates[s.id]!.value" class="as-val" placeholder="value — e.g. home_check_rates_see_all_button" @keydown.enter="addState(s, b.bundle)">
          <input v-model="newStates[s.id]!.name" class="as-name" placeholder="state name" @keydown.enter="addState(s, b.bundle)">
          <button class="as-add" @click="addState(s, b.bundle)">add state</button>
          <button class="probe-open" title="pick a live element on a booted device" @click="openProbe(s, b.bundle)">probe device…</button>
        </div>
        <div v-if="saveMsg || saveErr" class="save-line" :class="{ err: !!saveErr }">{{ saveErr || saveMsg }}</div>
      </div>
    </article>
  </div>

  <!-- new-app prompt: first screen of a brand-new bundle -->
  <div v-if="newApp.open" class="probe-overlay" @click.self="newApp.open = false">
    <div class="probe narrow">
      <div class="probe-head">
        <span class="probe-title">register a new app</span>
        <span class="probe-meta">the bundle id its cases will name in app:</span>
        <button class="probe-x" @click="newApp.open = false">×</button>
      </div>
      <div class="ed-form">
        <label class="ed-row">
          <span class="ed-k">bundle</span>
          <input v-model="newApp.bundle" class="ed-in" list="known-apps" placeholder="com.example.app" @keydown.enter="confirmNewApp">
        </label>
        <datalist id="known-apps">
          <option v-for="a in knownApps" :key="a" :value="a" />
        </datalist>
        <div v-if="editorErr" class="ed-err">{{ editorErr }}</div>
        <div class="ed-acts">
          <span class="ed-hint">creates an empty registry section, then opens the screen form</span>
          <span style="flex:1"></span>
          <button class="pp-add" @click="confirmNewApp">continue →</button>
        </div>
      </div>
    </div>
  </div>

  <!-- screen editor: create + edit entry/refresh -->
  <div v-if="editor" class="probe-overlay" @click.self="editor = null">
    <div class="probe">
      <div class="probe-head">
        <span class="probe-title">{{ editor.mode === 'create' ? 'register screen' : `edit ${editor.originalId}` }}</span>
        <span class="probe-meta">{{ editor.bundle }}</span>
        <button class="probe-x" @click="editor = null">×</button>
      </div>
      <div class="ed-form">
        <label class="ed-row"><span class="ed-k">id</span><input v-model="editor.id" class="ed-in" placeholder="home"></label>
        <label class="ed-row"><span class="ed-k">entry</span>
          <select v-model="editor.entryMode" class="ed-in ed-sel">
            <option value="tab">tab</option>
            <option value="deepLink">deep link</option>
          </select>
        </label>
        <label v-if="editor.entryMode === 'tab'" class="ed-row"><span class="ed-k">tab label</span><input v-model="editor.entryLabel" class="ed-in" placeholder="Home"></label>
        <label v-if="editor.entryMode === 'tab'" class="ed-row"><span class="ed-k">point</span><input v-model="editor.entryPoint" class="ed-in" placeholder="71,870 (optional)"></label>
        <label v-else class="ed-row"><span class="ed-k">url</span><input v-model="editor.entryPoint" class="ed-in" placeholder="lionparcel://tarif"></label>
        <label class="ed-row"><span class="ed-k">refresh</span>
          <select v-model="editor.refreshGesture" class="ed-in ed-sel">
            <option value="">none</option>
            <option value="pull">pull</option>
            <option value="tab-retap">tab-retap</option>
            <option value="back-forward">back-forward</option>
            <option value="deepLink">deepLink</option>
            <option value="signal">signal</option>
          </select>
        </label>
        <label v-if="editor.refreshGesture === 'back-forward' || editor.refreshGesture === 'tab-retap'" class="ed-row">
          <span class="ed-k">{{ editor.refreshGesture === 'back-forward' ? 'away id' : 'selector id' }}</span>
          <input v-model="editor.refreshAwayId" class="ed-in" placeholder="home_check_rates_see_all_button">
        </label>
        <template v-if="editor.refreshGesture === 'back-forward'">
          <label class="ed-row"><span class="ed-k">back label</span><input v-model="editor.refreshBackLabel" class="ed-in" placeholder="Left"></label>
          <label class="ed-row"><span class="ed-k">back point</span><input v-model="editor.refreshBackPoint" class="ed-in" placeholder="28,71 (optional)"></label>
        </template>
        <div v-if="editorErr" class="ed-err">{{ editorErr }}</div>
        <div class="ed-acts">
          <span style="flex:1"></span>
          <button class="pp-add" @click="saveScreen">{{ editor.mode === 'create' ? 'register' : 'save' }}</button>
        </div>
      </div>
    </div>
  </div>

  <div v-if="yamlModal" class="probe-overlay" @click.self="yamlModal = null">
    <div class="probe">
      <div class="probe-head">
        <span class="probe-title">registry yaml</span>
        <span class="probe-meta">{{ yamlModal.bundle }}</span>
        <button class="probe-x" @click="yamlModal = null">×</button>
      </div>
      <div class="ed-form">
        <textarea v-model="yamlModal.text" class="ed-yaml" spellcheck="false"></textarea>
        <div v-if="yamlErr" class="ed-err">{{ yamlErr }}</div>
        <div class="ed-acts">
          <span class="ed-hint">edit + import replaces the registry (validators run server-side)</span>
          <span style="flex:1"></span>
          <button class="pp-add" @click="importYaml">import</button>
        </div>
      </div>
    </div>
  </div>

  <!-- B1 probe dialog: searchable live element list → selector proposal → add -->
  <div v-if="probe.open" class="probe-overlay" @click.self="probe.open = false">
    <div class="probe">
      <div class="probe-head">
        <span class="probe-title">{{ probe.screenId }} · pick an element</span>
        <span class="probe-meta">{{ booted[0]?.name ?? booted[0]?.udid.slice(0, 8) ?? 'no device' }}<template v-if="probe.sessionId"> · {{ probe.sessionId }}</template></span>
        <button class="probe-x" @click="probe.open = false">×</button>
      </div>
      <div v-if="booted.length === 0" class="probe-empty">
        no booted device — boot one on the devices page, then probe here
      </div>
      <template v-else>
        <div class="probe-bar">
          <input v-model="probe.filter" class="probe-filter" placeholder="filter by label or identifier…">
          <button class="probe-refresh" title="re-fetch the live tree" @click="fetchTree(booted[0]!.udid)">refresh</button>
        </div>
        <div v-if="probe.busy" class="probe-empty">{{ probe.busy }}</div>
        <div v-else-if="probe.err" class="probe-empty err">{{ probe.err }}</div>
        <div v-else class="probe-list">
          <button v-for="n in filteredNodes" :key="n.index" class="probe-node" :class="{ sel: probe.sel?.index === n.index }" @click="probe.sel = n">
            <span class="pn-dot"></span>
            <span class="pn-main">
              <span class="pn-label">{{ n.label || '—' }}</span>
              <span class="pn-id">{{ n.identifier || '' }}</span>
            </span>
            <span class="pn-type">{{ n.type || '' }}</span>
          </button>
          <div v-if="filteredNodes.length === 0" class="probe-empty">no elements match "{{ probe.filter }}"</div>
        </div>
        <div v-if="probe.sel" class="probe-prop">
          <div class="pp-h">proposed selector — identifier preferred</div>
          <code class="pp-sel">{{ JSON.stringify(proposeSelector(probe.sel) ? (proposeSelector(probe.sel)!.kind === 'identifier' ? { identifier: proposeSelector(probe.sel)!.value } : { label: proposeSelector(probe.sel)!.value }) : null) }}</code>
          <div class="pp-acts">
            <span style="flex:1"></span>
            <button class="pp-add" @click="addPickedAsState">add as state</button>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
<style scoped>
.hint { color: var(--color-steel); font-size: var(--text-label); padding: var(--s-4) 0; }
.hint.err { color: var(--color-ember); }
.registry { margin-bottom: var(--s-5); }

/* ── house list idiom (su-thead/a2-thead pattern): sticky uppercase thead,
   hairline rows, graphite hover, actions right ── */
.bundle-row { display: flex; align-items: baseline; gap: var(--s-2); }
.bundle-row > span:first-child { flex: 1; }
.bundle-acts { display: flex; gap: var(--s-1); }
.inline-link { color: var(--color-fog); text-decoration: underline; text-underline-offset: 2px; }
.inline-link:hover { color: var(--color-paper); }
.hint.inset { padding: var(--s-3) 12px; }
.probe.narrow { width: min(480px, 92vw); }
.mini-act { border: 1px solid var(--color-iron); color: var(--color-pewter); font-size: var(--text-caption); padding: 1px var(--s-2); transition: all var(--t); }
.mini-act:hover { border-color: var(--color-slate); color: var(--color-paper); }

.scr-thead, .scr-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr) minmax(0, 1.4fr) minmax(0, 56px) minmax(0, 1.2fr) minmax(0, 150px);
  gap: var(--s-2); align-items: center;
}
.scr-thead {
  position: sticky; top: 0; z-index: 2; background: var(--color-graphite);
  padding: 8px 12px; font-size: 10px; color: var(--color-steel);
  text-transform: uppercase; letter-spacing: 0.08em;
}
.scr-card { border-bottom: 1px solid var(--color-iron); }
.scr-card.editing { border-color: var(--color-ember); }
.scr-card.editing .scr-row { background: color-mix(in srgb, var(--color-ember) 6%, transparent); }
.scr-row { padding: 8px 12px; min-height: 44px; cursor: pointer; }
.scr-row:hover { background: var(--color-graphite); }
.scr-id { color: var(--color-paper); font-weight: var(--weight-bold); font-size: var(--text-label); }
.col-entry, .col-refresh, .col-used { color: var(--color-fog); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.col-states { color: var(--color-fog); font-size: 12px; }
.col-acts { display: flex; gap: var(--s-2); justify-content: flex-end; }
.c-act { color: var(--color-pewter); font-size: var(--text-caption); transition: color var(--t); }
.c-act:hover { color: var(--color-chalk); }
.c-act.danger:hover { color: var(--color-ember); }

/* expanded states: the same idiom inset one level */
.scr-body { background: var(--color-carbon); border-top: 1px solid var(--color-iron); padding: var(--s-2) 0 var(--s-3); }
.st-thead, .st-row {
  display: grid;
  grid-template-columns: minmax(0, 160px) minmax(0, 1fr) minmax(0, 220px);
  gap: var(--s-2); align-items: center; padding: 4px 12px;
}
.st-thead { font-size: 10px; color: var(--color-steel); text-transform: uppercase; letter-spacing: 0.08em; padding-top: var(--s-2); }
.st-row { border-bottom: 1px solid var(--color-iron); }
.st-row:last-of-type { border-bottom: none; }
.st-col-nm { color: var(--color-chalk); font-size: 12px; }
.st-col-def { color: var(--color-steel); font-size: 12px; font-family: var(--font-mono); }
.st-col-acts { display: flex; gap: var(--s-2); justify-content: flex-end; align-items: baseline; }
.st-verify { color: var(--color-pewter); font-size: var(--text-caption); transition: color var(--t); }
.st-verify:hover { color: var(--color-chalk); }
.st-vres { font-size: var(--text-caption); }
.st-vres.holds { color: var(--color-fog); }
.st-vres.checking { color: var(--color-pewter); }
.st-vres.fails { color: var(--color-ember); }
.st-del { color: var(--color-pewter); font-size: var(--text-caption); transition: color var(--t); }
.st-del:hover { color: var(--color-ember); }
.add-state { display: grid; grid-template-columns: 110px minmax(0, 1fr) 140px auto auto; gap: var(--s-2); padding: var(--s-2) 12px 0; align-items: baseline; }
.as-kind, .as-val, .as-name { background: var(--color-void); border: 1px solid var(--color-iron); color: var(--color-paper); font-size: var(--text-label); padding: 4px var(--s-2); }
.as-kind:focus, .as-val:focus, .as-name:focus { outline: none; border-color: var(--color-slate); }
.as-add { border: 1px solid var(--color-ember); color: var(--color-ember); font-size: var(--text-label); padding: 4px var(--s-3); transition: all var(--t); }
.as-add:hover { background: var(--color-ember); color: var(--color-paper); }
.probe-open { border: 1px solid var(--color-iron); color: var(--color-fog); font-size: var(--text-caption); padding: 3px var(--s-2); transition: all var(--t); }
.probe-open:hover { border-color: var(--color-slate); color: var(--color-paper); }
.save-line { margin: var(--s-2) 12px 0; font-size: var(--text-caption); color: var(--color-fog); }
.save-line.err { color: var(--color-ember); }

/* dialogs (shared chrome) */
.probe-overlay { position: fixed; inset: 0; z-index: 200; background: color-mix(in srgb, var(--color-void) 80%, transparent); display: grid; place-items: center; }
.probe { width: min(640px, 92vw); max-height: 84vh; display: grid; grid-template-rows: auto auto auto 1fr auto; border: 1px solid var(--color-slate); background: var(--color-graphite); overflow: hidden; }
.probe-head { display: flex; gap: var(--s-3); align-items: baseline; padding: var(--s-3) var(--s-4); border-bottom: 1px solid var(--color-iron); }
.probe-title { font-weight: var(--weight-bold); font-size: var(--text-label); }
.probe-meta { color: var(--color-steel); font-size: var(--text-caption); }
.probe-x { margin-left: auto; color: var(--color-pewter); font-size: var(--text-label); }
.probe-x:hover { color: var(--color-paper); }
.probe-empty { color: var(--color-steel); font-size: var(--text-label); padding: var(--s-4); }
.probe-empty.err { color: var(--color-ember); }
.probe-bar { display: flex; gap: var(--s-2); padding: var(--s-3) var(--s-4) var(--s-2); }
.probe-filter { flex: 1; background: var(--color-void); border: 1px solid var(--color-iron); color: var(--color-paper); font-size: var(--text-label); padding: 5px var(--s-2); }
.probe-filter:focus { outline: none; border-color: var(--color-slate); }
.probe-refresh { border: 1px solid var(--color-iron); color: var(--color-fog); font-size: var(--text-caption); padding: 4px var(--s-2); }
.probe-refresh:hover { border-color: var(--color-slate); color: var(--color-paper); }
.probe-list { overflow-y: auto; margin: 0 var(--s-2) var(--s-2); }
.probe-node { display: grid; grid-template-columns: 18px minmax(0, 1fr) auto; gap: var(--s-2); width: 100%; padding: 5px var(--s-2); align-items: baseline; text-align: left; transition: background var(--t); }
.probe-node:hover { background: var(--color-carbon); }
.probe-node.sel { background: var(--color-carbon); border-left: 2px solid var(--color-ember); padding-left: calc(var(--s-2) - 2px); }
.pn-dot { width: 6px; height: 6px; border: 1px solid var(--color-pewter); align-self: center; }
.probe-node.sel .pn-dot { background: var(--color-ember); border-color: var(--color-ember); }
.pn-main { min-width: 0; display: grid; }
.pn-label { color: var(--color-paper); font-size: var(--text-label); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pn-id { color: var(--color-steel); font-size: var(--text-caption); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pn-type { color: var(--color-pewter); font-size: var(--text-caption); }
.probe-prop { border-top: 1px solid var(--color-iron); padding: var(--s-3) var(--s-4); background: var(--color-carbon); }
.pp-h { font-size: var(--text-caption); color: var(--color-steel); text-transform: uppercase; letter-spacing: .08em; font-weight: var(--weight-bold); margin-bottom: var(--s-1); }
.pp-sel { font-size: var(--text-label); color: var(--color-chalk); background: var(--color-void); border: 1px solid var(--color-iron); padding: var(--s-1) var(--s-3); display: inline-block; margin-bottom: var(--s-2); }
.pp-acts { display: flex; gap: var(--s-2); align-items: center; }
.pp-add { border: 1px solid var(--color-ember); color: var(--color-ember); font-size: var(--text-label); padding: 4px var(--s-3); transition: all var(--t); }
.pp-add:hover { background: var(--color-ember); color: var(--color-paper); }
.ed-form { display: grid; gap: var(--s-2); padding: var(--s-3) var(--s-4); }
.ed-row { display: grid; grid-template-columns: 90px 1fr; gap: var(--s-2); align-items: baseline; }
.ed-k { color: var(--color-steel); font-size: var(--text-caption); text-transform: uppercase; letter-spacing: .06em; }
.ed-in { background: var(--color-void); border: 1px solid var(--color-iron); color: var(--color-paper); font-size: var(--text-label); padding: 4px var(--s-2); }
.ed-in:focus { outline: none; border-color: var(--color-slate); }
.ed-sel { width: 200px; }
.ed-err { color: var(--color-ember); font-size: var(--text-caption); }
.ed-acts { display: flex; gap: var(--s-2); align-items: center; }
.ed-hint { color: var(--color-pewter); font-size: var(--text-caption); }
.ed-yaml { width: 100%; min-height: 320px; background: var(--color-void); border: 1px solid var(--color-iron); color: var(--color-paper); font-family: var(--font-mono); font-size: var(--text-label); padding: var(--s-2); resize: vertical; }
.ed-yaml:focus { outline: none; border-color: var(--color-slate); }
</style>
