<script setup lang="ts">
/** /env — managed env vars (plan rev 2 Stage 5, sketch 005 D2 picked).
 *  Scope sections (global / per-app / per-plan) in the house list idiom,
 *  gaps strip for keys cases reference but nothing sets, an effective mode
 *  that resolves the chain for a target app+plan, blank-keeps-secret
 *  editing, and usage badges from the case scan. */
import { computed, onMounted, ref } from 'vue';
import PageHeader from '../components/PageHeader.vue';

interface EnvVar {
  id: string;
  scope: 'global' | 'app' | 'plan';
  appBundleId: string | null;
  planId: string | null;
  key: string;
  value: string | null;
  secret: boolean;
  status: string;
  note: string | null;
  updatedBy: string;
  updatedAt: number;
}

const vars = ref<EnvVar[]>([]);
const plans = ref<Array<{ id: string; name: string }>>([]);
const usage = ref<Record<string, number>>({});
const me = ref<{ role: string } | null>(null);
const canWrite = computed(() => me.value?.role === 'admin' || me.value?.role === 'operator' || me.value?.role === 'bot');
const q = ref('');
const mode = ref<'manage' | 'eff'>('manage');
const effApp = ref('');
const effPlan = ref('');
const openSections = ref<Set<string>>(new Set());
const addOpen = ref<string | null>(null);
const addKey = ref('');
const addVal = ref('');
const addSecret = ref(false);
const dlg = ref<null | { v: EnvVar }>(null);
const dlgVal = ref('');
const dlgNote = ref('');
const toast = ref('');

const apps = computed(() => Array.from(new Set(vars.value.filter(v => v.scope === 'app' && v.appBundleId).map(v => v.appBundleId!))).sort());
const globalVars = computed(() => vars.value.filter(v => v.scope === 'global' && matches(v)));
const appGroups = computed(() => apps.value.filter(b => vars.value.some(v => v.scope === 'app' && v.appBundleId === b && matches(v))).map(b => ({ bundle: b, vars: vars.value.filter(v => v.scope === 'app' && v.appBundleId === b && matches(v)) })));
const planGroups = computed(() => plans.value.filter(p => p.id === effPlan.value || vars.value.some(v => v.scope === 'plan' && v.planId === p.id && matches(v))).map(p => ({ plan: p, vars: vars.value.filter(v => v.scope === 'plan' && v.planId === p.id && matches(v)) })));
function matches(v: EnvVar): boolean { return !q.value || v.key.toLowerCase().includes(q.value.toLowerCase()); }
function gaps(): Array<{ key: string; uses: number }> {
  const set = new Set(vars.value.map(v => v.key));
  return Object.entries(usage.value).filter(([k, n]) => n > 0 && !set.has(k)).map(([key, uses]) => ({ key, uses }));
}
const counts = computed(() => `${vars.value.length} vars · ${gaps().length} missing`);

interface EffRow { key: string; v: EnvVar; src: string }
const effRows = computed<EffRow[]>(() => {
  if (mode.value !== 'eff' || !effApp.value) return [];
  const layers: Array<[string, EnvVar[]]> = [
    ['global', vars.value.filter(v => v.scope === 'global')],
    ['app', vars.value.filter(v => v.scope === 'app' && v.appBundleId === effApp.value)],
  ];
  if (effPlan.value) layers.push(['plan', vars.value.filter(v => v.scope === 'plan' && v.planId === effPlan.value)]);
  const eff = new Map<string, EffRow>();
  for (const [src, rows] of layers) for (const v of rows) eff.set(v.key, { key: v.key, v, src });
  return Array.from(eff.values());
});

const fmt = (ms: number): string => {
  const d = new Date(ms);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const badges = (v: EnvVar, isOvr: boolean): string => {
  const u = usage.value[v.key];
  return (v.secret ? '<span class="badge set">set</span>' : '') + (u ? `<span class="badge" title="${u} cases reference this key">×${u}</span>` : '') + (isOvr ? '<span class="badge ovr">ovr</span>' : '');
};
const isOverride = (v: EnvVar): boolean => v.scope === 'app' && vars.value.some(g => g.scope === 'global' && g.key === v.key);

function toggleSec(id: string): void { const s = new Set(openSections.value); if (s.has(id)) s.delete(id); else s.add(id); openSections.value = s; }
function toggleAdd(id: string): void { addOpen.value = addOpen.value === id ? null : id; addKey.value = ''; addVal.value = ''; addSecret.value = false; }

async function load(): Promise<void> {
  const [v, p, u, m] = await Promise.all([
    fetch('/api/env-vars').then(r => r.json()) as Promise<{ vars: EnvVar[] }>,
    fetch('/api/plans').then(r => r.json()).catch(() => ({ plans: [] })) as Promise<{ plans?: Array<{ id: string; name: string }> }>,
    fetch('/api/env-vars/usage').then(r => r.json()).catch(() => ({ usage: {} })) as Promise<{ usage: Record<string, number> }>,
    fetch('/api/auth/me').then(r => r.json()).catch(() => null) as Promise<{ user?: { role: string } } | null>,
  ]);
  vars.value = v.vars ?? [];
  plans.value = p.plans ?? [];
  usage.value = u.usage ?? {};
  me.value = m?.user ?? null;
  // default: open scopes that have vars
  openSections.value = new Set(vars.value.length ? ['g'] : []);
  for (const b of apps.value) if (vars.value.some(x => x.scope === 'app' && x.appBundleId === b)) openSections.value.add(`a:${b}`);
}

async function doAdd(scope: 'global' | 'app' | 'plan', appBundleId?: string, planId?: string): Promise<void> {
  if (!addKey.value.trim() || addVal.value === '') { flash('key and value required'); return; }
  const body = { scope, ...(appBundleId ? { appBundleId } : {}), ...(planId ? { planId } : {}), key: addKey.value.trim(), value: addVal.value, secret: addSecret.value };
  const r = await fetch('/api/env-vars', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const d = (await r.json()) as { error?: string };
  if (!r.ok) { flash(d.error ?? 'save failed'); return; }
  addOpen.value = null; flash(`added ${body.key}`); await load();
  openSections.value = new Set([...openSections.value, scope === 'global' ? 'g' : scope === 'app' ? `a:${appBundleId}` : `p:${planId}`]);
}

function openEdit(v: EnvVar): void { dlg.value = { v }; dlgVal.value = ''; dlgNote.value = v.note ?? ''; }

async function saveEdit(): Promise<void> {
  if (!dlg.value) return;
  const v = dlg.value.v;
  const body: Record<string, unknown> = { note: dlgNote.value };
  if (dlgVal.value !== '') body.value = dlgVal.value;
  const r = await fetch(`/api/env-vars/${v.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const d = (await r.json()) as { error?: string };
  if (!r.ok) { flash(d.error ?? 'save failed'); return; }
  dlg.value = null; flash(`saved ${v.key}`); await load();
}

async function del(v: EnvVar): Promise<void> {
  const u = usage.value[v.key];
  if (u && !window.confirm(`${v.key} is referenced by ${u} case(s). Delete anyway?`)) return;
  const r = await fetch(`/api/env-vars/${v.id}`, { method: 'DELETE' });
  if (!r.ok) { flash('delete failed'); return; }
  flash(`deleted ${v.key}`); await load();
}

async function fixGap(key: string): Promise<void> {
  const b = apps.value[0];
  if (!b) { flash('no app scope yet — add one first'); return; }
  const r = await fetch('/api/env-vars', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scope: 'app', appBundleId: b, key, value: 'CHANGEME', secret: false, note: 'from gaps strip' }) });
  const d = (await r.json()) as { id?: string; error?: string };
  if (!r.ok) { flash(d.error ?? 'save failed'); return; }
  await load();
  openSections.value = new Set([...openSections.value, `a:${b}`]);
  const created = vars.value.find(x => x.key === key && x.scope === 'app' && x.appBundleId === b);
  if (created) openEdit(created);
}

function flash(m: string): void { toast.value = m; setTimeout(() => { toast.value = ''; }, 1800); }

onMounted(load);
</script>

<template>
  <div class="env-page">
    <PageHeader title="env">
      <span class="ph-desc">global &lt; app &lt; plan &lt; request &lt; variant</span>
      <span class="ph-syms">{{ counts }}</span>
      <template #actions>
        <div class="seg">
          <button :class="{ on: mode === 'manage' }" @click="mode = 'manage'">manage</button>
          <button :class="{ on: mode === 'eff' }" @click="mode = 'eff'">effective</button>
        </div>
      </template>
    </PageHeader>

    <div class="toolbar" v-if="mode === 'manage'">
      <input v-model="q" type="text" placeholder="search key…">
    </div>

    <div class="gaps" :class="{ has: gaps().length > 0 && mode === 'manage' }">
      <span class="lbl">missing</span>
      <span v-for="g in gaps()" :key="g.key" class="gap-chip">
        <span class="k">{{ g.key }}</span>
        <span class="u">×{{ g.uses }} · set nowhere</span>
        <button v-if="canWrite" class="btn btn-sm" @click="fixGap(g.key)">set in app…</button>
      </span>
    </div>

    <div v-if="mode === 'eff'" class="eff-bar">
      <span class="lbl">app</span>
      <select v-model="effApp">
        <option value="">—</option>
        <option v-for="a in apps" :key="a" :value="a">{{ a }}</option>
      </select>
      <span class="lbl">plan</span>
      <select v-model="effPlan">
        <option value="">—</option>
        <option v-for="p in plans" :key="p.id" :value="p.id">{{ p.name }}</option>
      </select>
    </div>
    <div v-if="mode === 'eff'" class="eff-wrap">
      <div class="env-thead"><span>key</span><span>resolved value</span><span>note</span><span>source</span><span>used by</span></div>
      <div v-for="r in effRows" :key="r.key" class="env-card">
        <div class="env-row">
          <span class="env-key">{{ r.key }}<span v-if="r.v.secret" class="badge set">set</span><span v-if="usage[r.key]" class="badge">×{{ usage[r.key] }}</span></span>
          <span class="env-val" :class="{ masked: r.v.secret }">{{ r.v.secret ? '•••••' : r.v.value }}</span>
          <span class="env-note">{{ r.v.note || '—' }}</span>
          <span class="env-meta src" :class="{ ovr: r.src !== 'global' }">{{ r.src }}</span>
          <span class="env-meta">{{ usage[r.key] ? '×' + usage[r.key] : '—' }}</span>
        </div>
      </div>
      <div v-if="!effApp" class="env-row empty">pick an app to resolve</div>
    </div>

    <div v-if="mode === 'manage'" id="scopes">
      <!-- global -->
      <div class="scope-block" :class="{ open: openSections.has('g') }">
        <div class="scope-head" @click="toggleSec('g')">
          <span class="caret">{{ openSections.has('g') ? '▾' : '▸' }}</span>
          <span class="tag">global</span>
          <span class="owner">every app · every plan</span>
          <span class="cnt">{{ globalVars.length }}</span>
          <span class="grow"></span>
          <button v-if="canWrite" class="btn btn-sm" @click.stop="toggleAdd('g')">+ var</button>
        </div>
        <div class="scope-body">
          <div class="env-thead"><span>key</span><span>value</span><span>note</span><span>updated</span><span></span></div>
          <div v-for="v in globalVars" :key="v.id" class="env-card">
            <div class="env-row">
              <span class="env-key" v-html="`${v.key}${badges(v, false)}`"></span>
              <span class="env-val" :class="{ masked: v.secret }">{{ v.secret ? '•••••' : v.value }}</span>
              <span class="env-note" :title="v.note ?? ''">{{ v.note || '—' }}</span>
              <span class="env-meta">{{ v.updatedBy }} {{ fmt(v.updatedAt) }}</span>
              <span class="env-acts">
                <button v-if="canWrite" @click="openEdit(v)">edit</button>
                <button v-if="canWrite" class="danger" @click="del(v)">delete</button>
              </span>
            </div>
          </div>
          <div v-if="addOpen === 'g'" class="inline-add">
            <input v-model="addKey" class="k" placeholder="KEY_NAME">
            <input v-model="addVal" class="v" placeholder="value">
            <label class="sec-l"><input v-model="addSecret" type="checkbox"> secret</label>
            <button class="btn btn-sm" @click="doAdd('global')">add</button>
          </div>
        </div>
      </div>

      <!-- per-app -->
      <div v-for="g in appGroups" :key="g.bundle" class="scope-block" :class="{ open: openSections.has(`a:${g.bundle}`) }">
        <div class="scope-head" @click="toggleSec(`a:${g.bundle}`)">
          <span class="caret">{{ openSections.has(`a:${g.bundle}`) ? '▾' : '▸' }}</span>
          <span class="tag">app</span>
          <span class="owner" :title="g.bundle">{{ g.bundle }}</span>
          <span class="cnt">{{ g.vars.length }}</span>
          <span class="grow"></span>
          <button v-if="canWrite" class="btn btn-sm" @click.stop="toggleAdd(`a:${g.bundle}`)">+ var</button>
        </div>
        <div class="scope-body">
          <div class="env-thead"><span>key</span><span>value</span><span>note</span><span>updated</span><span></span></div>
          <div v-for="v in g.vars" :key="v.id" class="env-card">
            <div class="env-row">
              <span class="env-key" v-html="`${v.key}${badges(v, isOverride(v))}`"></span>
              <span class="env-val" :class="{ masked: v.secret }">{{ v.secret ? '•••••' : v.value }}</span>
              <span class="env-note" :title="v.note ?? ''">{{ v.note || '—' }}</span>
              <span class="env-meta">{{ v.updatedBy }} {{ fmt(v.updatedAt) }}</span>
              <span class="env-acts">
                <button v-if="canWrite" @click="openEdit(v)">edit</button>
                <button v-if="canWrite" class="danger" @click="del(v)">delete</button>
              </span>
            </div>
          </div>
          <div v-if="g.vars.length === 0" class="env-row empty">no vars — falls back to global</div>
          <div v-if="addOpen === `a:${g.bundle}`" class="inline-add">
            <input v-model="addKey" class="k" placeholder="KEY_NAME">
            <input v-model="addVal" class="v" placeholder="value">
            <label class="sec-l"><input v-model="addSecret" type="checkbox"> secret</label>
            <button class="btn btn-sm" @click="doAdd('app', g.bundle)">add</button>
          </div>
        </div>
      </div>

      <!-- per-plan -->
      <div v-for="g in planGroups" :key="g.plan.id" class="scope-block" :class="{ open: openSections.has(`p:${g.plan.id}`) }">
        <div class="scope-head" @click="toggleSec(`p:${g.plan.id}`)">
          <span class="caret">{{ openSections.has(`p:${g.plan.id}`) ? '▾' : '▸' }}</span>
          <span class="tag">plan</span>
          <span class="owner" :title="g.plan.id">{{ g.plan.name }}</span>
          <span class="cnt">{{ g.vars.length }}</span>
          <span class="grow"></span>
          <button v-if="canWrite" class="btn btn-sm" @click.stop="toggleAdd(`p:${g.plan.id}`)">+ var</button>
        </div>
        <div class="scope-body">
          <div class="env-thead"><span>key</span><span>value</span><span>note</span><span>updated</span><span></span></div>
          <div v-for="v in g.vars" :key="v.id" class="env-card">
            <div class="env-row">
              <span class="env-key" v-html="`${v.key}${badges(v, false)}`"></span>
              <span class="env-val" :class="{ masked: v.secret }">{{ v.secret ? '•••••' : v.value }}</span>
              <span class="env-note" :title="v.note ?? ''">{{ v.note || '—' }}</span>
              <span class="env-meta">{{ v.updatedBy }} {{ fmt(v.updatedAt) }}</span>
              <span class="env-acts">
                <button v-if="canWrite" @click="openEdit(v)">edit</button>
                <button v-if="canWrite" class="danger" @click="del(v)">delete</button>
              </span>
            </div>
          </div>
          <div v-if="g.vars.length === 0" class="env-row empty">no vars</div>
          <div v-if="addOpen === `p:${g.plan.id}`" class="inline-add">
            <input v-model="addKey" class="k" placeholder="KEY_NAME">
            <input v-model="addVal" class="v" placeholder="value">
            <label class="sec-l"><input v-model="addSecret" type="checkbox"> secret</label>
            <button class="btn btn-sm" @click="doAdd('plan', undefined, g.plan.id)">add</button>
          </div>
        </div>
      </div>
      <div v-if="q && appGroups.length === 0 && planGroups.length === 0 && globalVars.length === 0" class="env-row empty">no vars match</div>
    </div>

    <!-- edit modal -->
    <div class="dlg-wrap" :class="{ open: dlg }" @click.self="dlg = null">
      <div v-if="dlg" class="dlg">
        <h3>edit {{ dlg.v.key }}</h3>
        <label>value <span v-if="dlg.v.secret" class="keep">(blank keeps current secret)</span></label>
        <input v-model="dlgVal" type="text">
        <label>note</label>
        <input v-model="dlgNote" type="text">
        <div class="row">
          <button class="btn" @click="dlg = null">cancel</button>
          <button class="btn btn-primary" @click="saveEdit">save</button>
        </div>
      </div>
    </div>

    <div class="toast" :class="{ show: toast }">{{ toast }}</div>
  </div>
</template>

<style scoped>
.toolbar { display: flex; align-items: center; gap: var(--s-2); margin-bottom: var(--s-3); }
.toolbar input[type=text] { background: var(--color-carbon); border: 1px solid var(--color-iron); border-radius: var(--r-sm); color: var(--color-paper); font-family: var(--font-mono); font-size: var(--text-caption); padding: 5px var(--s-2); width: 220px; }
.seg { display: inline-flex; border: 1px solid var(--color-iron); border-radius: var(--r-sm); overflow: hidden; }
.seg button { padding: 4px var(--s-3); font-size: var(--text-caption); color: var(--color-steel); }
.seg button.on { background: var(--color-carbon); color: var(--color-paper); }
.ph-desc { font-size: var(--text-caption); color: var(--color-steel); }
.ph-syms { margin-left: auto; font-size: var(--text-caption); color: var(--color-steel); }

.gaps { background: var(--color-carbon); border: 1px solid var(--color-iron); border-left: 2px solid var(--color-ember); padding: var(--s-2) var(--s-3); margin-bottom: var(--s-3); display: none; align-items: center; gap: var(--s-2); flex-wrap: wrap; }
.gaps.has { display: flex; }
.gaps .lbl { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--color-ember); font-weight: var(--weight-bold); }
.gap-chip { display: inline-flex; align-items: center; gap: var(--s-2); border: 1px solid var(--color-slate); border-radius: var(--r-sm); padding: 3px var(--s-2); font-size: var(--text-caption); }
.gap-chip .k { color: var(--color-paper); font-weight: var(--weight-bold); }
.gap-chip .u { color: var(--color-steel); font-size: 10px; }

.scope-block { margin-bottom: var(--s-4); }
.scope-head { display: flex; align-items: center; gap: var(--s-2); padding: var(--s-2) 0; cursor: pointer; user-select: none; }
.scope-head .caret { color: var(--color-steel); font-size: 10px; width: 10px; }
.scope-head .tag { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--color-fog); border: 1px solid var(--color-slate); border-radius: var(--r-sm); padding: 1px var(--s-2); }
.scope-head .owner { color: var(--color-paper); font-size: var(--text-caption); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.scope-head .cnt { color: var(--color-steel); font-size: var(--text-caption); border: 1px solid var(--color-iron); border-radius: var(--r-sm); padding: 0 var(--s-2); }
.scope-head .grow { flex: 1; }
.scope-body { display: none; }
.scope-block.open .scope-body { display: block; }

.env-thead, .env-row { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1.4fr) minmax(0, 0.8fr) minmax(0, 150px) minmax(0, 120px); gap: var(--s-2); align-items: center; }
.env-thead { position: sticky; top: 0; z-index: 2; background: var(--color-graphite); padding: 8px 12px; font-size: 10px; color: var(--color-steel); text-transform: uppercase; letter-spacing: 0.08em; }
.env-card { border-bottom: 1px solid var(--color-iron); }
.env-row { padding: 8px 12px; min-height: 44px; }
.env-row:hover { background: var(--color-graphite); }
.env-row.empty { color: var(--color-steel); }
.env-key { color: var(--color-paper); font-weight: var(--weight-bold); font-size: var(--text-label); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.env-val { color: var(--color-fog); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.env-val.masked { color: var(--color-steel); letter-spacing: 0.2em; }
.env-note { color: var(--color-ash); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.env-meta { color: var(--color-steel); font-size: 10px; white-space: nowrap; }
.env-meta.src.ovr { color: var(--color-ember); }
.env-acts { display: flex; gap: var(--s-2); justify-content: flex-end; }
.env-acts button { color: var(--color-pewter); font-size: var(--text-caption); transition: color var(--t); }
.env-acts button:hover { color: var(--color-chalk); }
.env-acts button.danger:hover { color: var(--color-ember); }
.badge { font-size: 10px; padding: 0 var(--s-2); border: 1px solid var(--color-slate); border-radius: var(--r-sm); color: var(--color-ash); margin-left: var(--s-1); }
.badge.set { color: var(--color-fog); border-color: var(--color-slate); }
.badge.ovr { color: var(--color-ember); border-color: var(--color-ember-dim); }

.inline-add { display: flex; gap: var(--s-2); padding: var(--s-2) var(--s-3); background: var(--color-carbon); border-top: 1px solid var(--color-iron); align-items: center; }
.inline-add input { background: var(--color-graphite); border: 1px solid var(--color-iron); border-radius: var(--r-sm); color: var(--color-paper); font-family: var(--font-mono); font-size: var(--text-caption); padding: 5px var(--s-2); }
.inline-add input.k { width: 200px; } .inline-add input.v { flex: 1; }
.sec-l { font-size: 11px; color: var(--color-steel); }

.eff-bar { display: flex; gap: var(--s-2); align-items: center; margin-bottom: var(--s-3); }
.eff-bar .lbl { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--color-steel); }
.eff-bar select { background: var(--color-carbon); border: 1px solid var(--color-iron); border-radius: var(--r-sm); color: var(--color-paper); font-family: var(--font-mono); font-size: var(--text-caption); padding: 5px var(--s-2); width: auto; }
.eff-wrap .env-thead, .eff-wrap .env-row { grid-template-columns: minmax(0, 1.1fr) minmax(0, 1.4fr) minmax(0, 0.8fr) minmax(0, 90px) minmax(0, 90px); }

.dlg-wrap { position: fixed; inset: 0; background: rgba(0,0,0,.72); display: none; align-items: center; justify-content: center; z-index: 10; }
.dlg-wrap.open { display: flex; }
.dlg { background: var(--color-graphite); border: 1px solid var(--color-slate); border-radius: var(--r-sm); padding: var(--s-4); width: 420px; }
.dlg h3 { font-size: var(--text-caption); font-weight: var(--weight-bold); text-transform: uppercase; letter-spacing: 0.08em; color: var(--color-fog); margin-bottom: var(--s-3); }
.dlg label { font-size: 10px; color: var(--color-steel); display: block; margin: var(--s-2) 0 var(--s-1); text-transform: uppercase; letter-spacing: 0.08em; }
.dlg label .keep { text-transform: none; }
.dlg input { width: 100%; background: var(--color-carbon); border: 1px solid var(--color-iron); border-radius: var(--r-sm); color: var(--color-paper); font-family: var(--font-mono); font-size: var(--text-caption); padding: 6px var(--s-2); }
.dlg .row { display: flex; gap: var(--s-2); justify-content: flex-end; margin-top: var(--s-4); }

.toast { position: fixed; right: var(--s-4); bottom: var(--s-4); background: var(--color-graphite); border: 1px solid var(--color-slate); border-radius: var(--r-sm); color: var(--color-fog); font-size: var(--text-caption); padding: var(--s-2) var(--s-3); display: none; z-index: 20; }
.toast.show { display: block; }
</style>
