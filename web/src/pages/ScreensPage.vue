<script setup lang="ts">
import { onMounted, ref } from 'vue';
import PageHeader from '../components/PageHeader.vue';

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
          <button class="st-edit" @click="beginEdit(s)">{{ editing === s.id ? 'editing…' : '' }}</button>
        </div>
        <div v-if="saveMsg || saveErr" class="save-line" :class="{ err: !!saveErr }">{{ saveErr || saveMsg }}</div>
      </div>
    </article>
  </section>
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
</style>
