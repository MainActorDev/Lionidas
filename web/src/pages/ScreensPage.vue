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
const revision = ref<number>(1);
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
  const payload = { screens: b.screens.map((x) => (x.id === s.id ? updated : x)), revision: revision.value };
  const res = await fetch(`/api/apps/${encodeURIComponent(probe.value.bundle)}/screens`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  if (res.ok) {
    const d = (await res.json()) as { revision: number };
    revision.value = d.revision;
    b.screens = payload.screens;
    probe.value.open = false;
    saveMsg.value = `state "${name.trim()}" added from live element`;
  } else if (res.status === 409) {
    const d = (await res.json()) as { screens: AppScreen[]; revision: number };
    b.screens = d.screens;
    revision.value = d.revision;
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
  const payload = { screens: b.screens.map((x) => (x.id === s.id ? updated : x)), revision: revision.value };
  const res = await fetch(`/api/apps/${encodeURIComponent(bundle)}/screens`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  if (res.ok) {
    const d = (await res.json()) as { revision: number };
    revision.value = d.revision;
    b.screens = payload.screens;
    newStates.value[s.id] = { name: '', kind: form.kind, value: '' };
    saveMsg.value = `state "${name}" added`;
    saveErr.value = '';
  } else if (res.status === 409) {
    const d = (await res.json()) as { screens: AppScreen[]; revision: number };
    b.screens = d.screens; // adopt the current registry; the user re-applies
    revision.value = d.revision;
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
  const payload = { screens: b.screens.map((x) => (x.id === s.id ? updated : x)), revision: revision.value };
  const res = await fetch(`/api/apps/${encodeURIComponent(bundle)}/screens`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  if (res.ok) {
    const d = (await res.json()) as { revision: number };
    revision.value = d.revision;
    b.screens = payload.screens;
    saveMsg.value = `state "${name}" removed`;
    saveErr.value = '';
  } else if (res.status === 409) {
    const d = (await res.json()) as { screens: AppScreen[]; revision: number };
    b.screens = d.screens;
    revision.value = d.revision;
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
    if (d.registries[0]) {
      const g = await (await fetch(`/api/apps/${encodeURIComponent(d.registries[0].bundle)}/screens`)).json() as { revision: number };
      revision.value = g.revision;
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
  <PageHeader title="screens" desc="per-app screen registry — entries, refresh gestures, assertion states" />
  <div v-if="loading" class="hint">loading registries…</div>
  <div v-else-if="error" class="hint err">{{ error }}</div>
  <div v-else-if="bundles.length === 0" class="hint">no screens registered yet</div>

  <section v-for="b in bundles" :key="b.bundle" class="bundle">
    <div class="section-label">{{ b.bundle }} · {{ b.screens.length }}</div>
    <article v-for="s in b.screens" :key="s.id" class="scr" :class="{ open: openId === s.id }">
      <button class="scr-row" :title="openId === s.id ? 'collapse states' : 'expand states'" @click="toggle(s)">
        <span class="c-id">{{ s.id }}</span>
        <span class="c-entry" :title="'entry — ' + describeEntry(s)">{{ describeEntry(s) }}</span>
        <span class="c-refresh" :title="'refresh — ' + describeRefresh(s)">{{ describeRefresh(s) }}</span>
        <span class="c-states-n">{{ Object.keys(s.states).length }} st</span>
        <span class="c-used" v-if="usage[s.id]?.length" :title="usage[s.id]!.join(', ')">{{ usage[s.id]!.join(', ') }}</span>
        <span v-if="openId === s.id && editing !== s.id" class="c-edit" title="edit states" @click.stop="beginEdit(s)">edit</span>
        <span class="c-arrow">{{ openId === s.id ? '▾' : '▸' }}</span>
      </button>
      <div v-if="openId === s.id" class="scr-states">
        <div v-for="(def, name) in s.states" :key="name" class="state-row">
          <span class="st-nm">{{ name }}</span>
          <span class="st-def">{{ stateDef(def) }}</span>
          <button v-if="editing === s.id" class="st-verify" title="run this state's selectors against the live tree" @click="verifyState(s, b.bundle, name)">verify live</button>
          <span v-if="verify[`${b.bundle}/${s.id}/${name}`]" class="st-vres" :class="verify[`${b.bundle}/${s.id}/${name}`]!.status">{{ verifyResult(verify[`${b.bundle}/${s.id}/${name}`]!) }}</span>
          <button v-if="editing === s.id" class="st-del" title="delete this state" @click="removeState(s, b.bundle, name)">delete</button>
        </div>
        <!-- add-state form (stage 2): one selector row — the registry editor's
             core loop; probe-sourced selectors land in stage 3 -->
        <div v-if="editing === s.id" class="add-state">
          <select v-model="newStates[s.id]!.kind" class="as-kind" title="selector kind">
            <option value="identifier">identifier</option>
            <option value="labelContains">contains</option>
            <option value="label">label</option>
          </select>
          <input v-model="newStates[s.id]!.value" class="as-val" placeholder="value — e.g. home_check_rates_see_all_button" @keydown.enter="addState(s, b.bundle)">
          <input v-model="newStates[s.id]!.name" class="as-name" placeholder="state name" @keydown.enter="addState(s, b.bundle)">
          <button class="as-add" @click="addState(s, b.bundle)">add state</button>
        </div>
        <div v-if="editing === s.id" class="edit-row">
          <button class="probe-open" title="pick a live element on a booted device" @click="openProbe(s, b.bundle)">probe device…</button>
        </div>
        <div v-if="saveMsg || saveErr" class="save-line" :class="{ err: !!saveErr }">{{ saveErr || saveMsg }}</div>
      </div>
    </article>
  </section>

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
.bundle { margin-bottom: var(--s-5); }

/* screens as hairline-divided rows — the house list idiom (a2-row pattern):
   borderless rows on void, iron hairline between, hover raises the surface */
.scr { border-bottom: 1px solid var(--color-iron); }
.scr:first-of-type { border-top: 1px solid var(--color-iron); }
.scr.open { background: var(--color-carbon); }
.scr-row {
  display: grid;
  grid-template-columns: 140px minmax(0, 1.2fr) minmax(0, 1.4fr) 54px minmax(0, 1fr) 16px;
  gap: var(--s-3);
  align-items: baseline;
  width: 100%;
  padding: var(--s-2) 0;
  font-size: var(--text-label);
  text-align: left;
  transition: background var(--t);
}
.scr-row:hover { background: var(--color-carbon); }
.c-id { color: var(--color-paper); font-weight: var(--weight-bold); }
.c-entry, .c-refresh { color: var(--color-fog); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.c-states-n { color: var(--color-steel); font-size: var(--text-caption); }
.c-used { color: var(--color-steel); font-size: var(--text-caption); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.c-arrow { color: var(--color-pewter); font-size: var(--text-caption); }

/* expanded state list — inset under the row, same column lead */
.scr-states { padding: var(--s-1) 0 var(--s-3); }
.state-row { display: grid; grid-template-columns: 140px minmax(0, 1fr); gap: var(--s-3); padding: 3px 0; font-size: var(--text-label); }
.st-nm { color: var(--color-chalk); }
.st-def { color: var(--color-steel); }
.st-verify { color: var(--color-pewter); font-size: var(--text-caption); transition: color var(--t); }
.st-verify:hover { color: var(--color-chalk); }
.st-vres { font-size: var(--text-caption); }
.st-vres.holds { color: var(--color-fog); }
.st-vres.checking { color: var(--color-pewter); }
.st-vres.fails { color: var(--color-ember); }
.st-del { color: var(--color-pewter); font-size: var(--text-caption); transition: color var(--t); }
.st-del:hover { color: var(--color-ember); }
.c-edit { color: var(--color-pewter); font-size: var(--text-caption); cursor: pointer; transition: color var(--t); }
.c-edit:hover { color: var(--color-chalk); }
.edit-row { display: none; }
.add-state { display: grid; grid-template-columns: 110px minmax(0, 1fr) 140px auto; gap: var(--s-2); margin-top: var(--s-2); align-items: baseline; }
.as-kind, .as-val, .as-name { background: var(--color-void); border: 1px solid var(--color-iron); color: var(--color-paper); font-size: var(--text-label); padding: 4px var(--s-2); }
.as-kind:focus, .as-val:focus, .as-name:focus { outline: none; border-color: var(--color-slate); }
.as-add { border: 1px solid var(--color-ember); color: var(--color-ember); font-size: var(--text-label); padding: 4px var(--s-3); transition: all var(--t); }
.as-add:hover { background: var(--color-ember); color: var(--color-paper); }
.save-line { margin-top: var(--s-2); font-size: var(--text-caption); color: var(--color-fog); }
.save-line.err { color: var(--color-ember); }
.probe-open { border: 1px solid var(--color-iron); color: var(--color-fog); font-size: var(--text-caption); padding: 3px var(--s-2); transition: all var(--t); }
.probe-open:hover { border-color: var(--color-slate); color: var(--color-paper); }
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
</style>
