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

function toggle(s: AppScreen): void { openId.value = openId.value === s.id ? null : s.id; }

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
        <span class="c-arrow">{{ openId === s.id ? '▾' : '▸' }}</span>
      </button>
      <div v-if="openId === s.id" class="scr-states">
        <div v-for="(def, name) in s.states" :key="name" class="state-row">
          <span class="st-nm">{{ name }}</span>
          <span class="st-def">{{ stateDef(def) }}</span>
        </div>
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
</style>
