<script setup lang="ts">
import { onMounted, ref } from 'vue';
import PageHeader from '../components/PageHeader.vue';

/** Screens page (A2, registry-UI stage 1) — read-only view of every app's
 *  screen registry: entry in plain terms, refresh gesture + anchors, states
 *  with their selector logic. Data: existing /api/apps/:bundle/screens.
 *  Editing lands in stage 2 (forms); probe in stage 3. */

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

/** which cases reference each screen (joined client-side from templates) */
const usage = ref<Record<string, string[]>>({});

onMounted(async () => {
  try {
    const res = await fetch('/api/apps/screens'); // all-bundles listing
    if (res.status === 404) { bundles.value = []; return; } // no registries yet
    if (!res.ok) throw new Error(`registry fetch failed (${res.status})`);
    const d = (await res.json()) as { registries: Array<{ bundle: string; screens: AppScreen[] }> };
    bundles.value = d.registries.map((r) => ({ bundle: r.bundle, screens: r.screens }));
    // usage join: cases whose steps reference each screen
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

/** selector → plain terms ("label contains Batam", "element x exists") */
function describeSelector(sel: ScreenSelector): string {
  if (sel.identifier) return `element ${sel.identifier} exists`;
  if (sel.label) return `label is "${sel.label}"${sel.ignoreCase ? ' (any case)' : ''}`;
  if (sel.labelContains) return `label contains "${sel.labelContains}"${sel.ignoreCase ? ' (any case)' : ''}`;
  return '?';
}
function describeEntry(s: AppScreen): string {
  if (s.entry.tab) return `tab ${s.entry.tab.label ?? s.entry.tab.identifier ?? '?'}${s.entry.tab.point ? ` @ ${s.entry.tab.point.join(', ')}` : ''}`;
  if (s.entry.deepLink) return `deep link ${s.entry.deepLink}`;
  if (s.entry.navigate) return `navigate (${s.entry.navigate.length} taps)`;
  return '?';
}
function describeRefresh(s: AppScreen): string {
  const r = s.refresh;
  if (!r) return '—';
  const anchor = (sel?: ScreenSelector & { point?: [number, number] }) => sel ? (sel.label ?? sel.identifier ?? (sel.point ? `${sel.point.join(', ')}` : '?')) : null;
  if (r.gesture === 'back-forward') return `back-forward · away ${anchor(r.selector) ?? '?'} · back ${anchor(r.back) ?? 'entry'}`;
  if (r.gesture === 'tab-retap') return `tab-retap ${anchor(r.selector) ?? ''}`.trim();
  if (r.gesture === 'deepLink') return `deep link ${r.deepLink ?? '?'}`;
  return r.gesture;
}
</script>

<template>
  <PageHeader title="screens" desc="per-app screen registry — entries, refresh gestures, assertion states" />
  <div v-if="loading" class="loading">loading registries…</div>
  <div v-else-if="error" class="err">{{ error }}</div>
  <div v-else-if="bundles.length === 0" class="empty">
    no screens registered yet — register one via the API, or wait for the editor (stage 2)
  </div>
  <section v-for="b in bundles" :key="b.bundle" class="bundle">
    <div class="bundle-head">
      <span class="bundle-id">{{ b.bundle }}</span>
      <span class="bundle-count">{{ b.screens.length }} screen{{ b.screens.length === 1 ? '' : 's' }}</span>
    </div>
    <div v-for="s in b.screens" :key="s.id" class="card">
      <div class="card-head">
        <span class="sid">{{ s.id }}</span>
        <span class="used-by" v-if="usage[s.id]?.length" :title="usage[s.id]!.join(', ')">used by {{ usage[s.id]!.join(', ') }}</span>
      </div>
      <div class="card-body">
        <div class="facts">
          <div class="fact"><span class="k">entry</span><span class="v">{{ describeEntry(s) }}</span></div>
          <div class="fact"><span class="k">refresh</span><span class="v">{{ describeRefresh(s) }}</span></div>
        </div>
        <div class="states">
          <div class="states-h">states · {{ Object.keys(s.states).length }}</div>
          <div v-for="(def, name) in s.states" :key="name" class="state-row">
            <span class="state-nm">{{ name }}</span>
            <span class="state-def">
              <template v-if="def.all?.length && def.any?.length">all: {{ def.all.map(describeSelector).join(' + ') }} · any: {{ def.any.map(describeSelector).join(' / ') }}</template>
              <template v-else-if="def.all?.length">{{ def.all.map(describeSelector).join(' + ') }}</template>
              <template v-else-if="def.any?.length">any of {{ def.any.map(describeSelector).join(' / ') }}</template>
              <template v-else>—</template>
            </span>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.loading, .empty { color: var(--color-steel); font-size: var(--text-label); padding: var(--s-4) 0; }
.err { color: var(--color-ember); font-size: var(--text-label); padding: var(--s-4) 0; }
.bundle { margin-bottom: var(--s-5); }
.bundle-head { display: flex; gap: var(--s-3); align-items: baseline; margin-bottom: var(--s-3); }
.bundle-id { color: var(--color-ash); font-size: var(--text-label); }
.bundle-count { color: var(--color-steel); font-size: var(--text-caption); }
.card { border: 1px solid var(--color-iron); background: var(--color-carbon); margin-bottom: var(--s-4); }
.card-head { display: flex; gap: var(--s-3); align-items: baseline; padding: var(--s-3) var(--s-4); border-bottom: 1px solid var(--color-iron); }
.sid { font-weight: var(--weight-bold); font-size: var(--text-label); }
.used-by { color: var(--color-steel); font-size: var(--text-caption); margin-left: auto; max-width: 40ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card-body { padding: var(--s-3) var(--s-4); display: grid; grid-template-columns: 260px 1fr; gap: var(--s-4); }
.fact { display: grid; grid-template-columns: 64px 1fr; gap: 2px var(--s-2); font-size: var(--text-caption); padding: 2px 0; }
.fact .k { color: var(--color-steel); }
.fact .v { color: var(--color-fog); }
.states-h { font-size: var(--text-caption); color: var(--color-steel); text-transform: uppercase; letter-spacing: .08em; font-weight: var(--weight-bold); margin-bottom: var(--s-1); }
.state-row { display: flex; gap: var(--s-3); align-items: baseline; padding: var(--s-1) 0; font-size: var(--text-label); border-bottom: 1px solid var(--color-iron); }
.state-row:last-child { border-bottom: none; }
.state-nm { color: var(--color-paper); min-width: 124px; }
.state-def { color: var(--color-steel); }
</style>
