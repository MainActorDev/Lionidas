<script setup lang="ts">
/** EnvPanelContent — the ENVIRONMENT overlay body (sketch v2, locked):
 *  live strip (pulsing dot + what's shaping the device now) + scenario
 *  CARDS (name, tag, one-line effect from the scenario's own description)
 *  + clear. Activation logic is EnvDrawer's, verbatim — this is the skin. */
import { onMounted, ref } from 'vue';

const scenarios = ref<Array<{ id: string; name: string; desc: string; tag: string; active: boolean }>>([]);
const busy = ref(false);
const error = ref('');
const emit = defineEmits<{ (e: 'scenario', name: string | null): void }>();

function tagFor(name: string): string {
  if (/pay|checkout|payment/i.test(name)) return 'payments';
  if (/countr|geo|intl/i.test(name)) return 'geo';
  if (/net|latency|offline/i.test(name)) return 'network';
  return 'preset';
}

async function load(): Promise<void> {
  try {
    const r = await fetch('/api/forge/scenarios');
    const b = await r.json() as { scenarios?: Array<{ id: string; name: string; description?: string | null }> };
    scenarios.value = (b.scenarios ?? []).map((s) => ({ id: s.id, name: s.name, desc: s.description ?? 'network shaping preset', tag: tagFor(s.name), active: false }));
  } catch { error.value = 'failed to load scenarios'; }
}
onMounted(load);

async function activate(id: string): Promise<void> {
  busy.value = true; error.value = '';
  try {
    const r = await fetch(`/api/forge/scenarios/${encodeURIComponent(id)}/activate`, { method: 'POST' });
    if (!r.ok) error.value = `activate failed (${r.status})`;
    else {
      scenarios.value.forEach((s) => { s.active = s.id === id; });
      emit('scenario', scenarios.value.find((s) => s.id === id)?.name ?? id);
    }
  } finally { busy.value = false; }
}
async function clearAll(): Promise<void> {
  busy.value = true;
  try {
    const r = await fetch('/api/forge/network-condition', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ udid: null, profile: null }) });
    if (!r.ok) error.value = `clear failed (${r.status})`;
    else { scenarios.value.forEach((s) => { s.active = false; }); emit('scenario', null); }
  } finally { busy.value = false; }
}
const activeName = () => scenarios.value.find((s) => s.active)?.name ?? null;
</script>

<template>
  <div class="env">
    <!-- live strip -->
    <div class="env-live">
      <span class="pulse" />
      <span class="k">shaping</span>
      <span class="v" :class="{ none: !activeName() }">{{ activeName() ?? 'nothing — device sees reality' }}</span>
    </div>

    <!-- scenario cards -->
    <div class="scen-list">
      <div v-for="s in scenarios" :key="s.id" class="scen" :class="{ on: s.active, busy }" @click="activate(s.id)">
        <div class="scen-top">
          <span class="radio" />
          <span class="scen-name">{{ s.name }}</span>
          <span class="scen-tag">{{ s.tag }}</span>
        </div>
        <div class="scen-desc">{{ s.desc }}</div>
      </div>
      <div v-if="!scenarios.length && !error" class="loading">loading scenarios…</div>

      <div class="scen-foot">
        <button type="button" class="scen-clear" :disabled="busy" @click="clearAll">clear scenario</button>
        <span class="scen-hint">chat sees what's active</span>
      </div>
      <div v-if="error" class="err">{{ error }} <button class="mini" @click="load">retry</button></div>
    </div>
  </div>
</template>

<style scoped>
.env { display: flex; flex-direction: column; min-height: 0; flex: 1; }

.env-live { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--color-iron); background: var(--color-carbon); flex: 0 0 auto; }
.pulse { width: 6px; height: 6px; border-radius: 50%; background: var(--color-ember); animation: pulse 2.4s infinite; flex: none; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
@media (prefers-reduced-motion: reduce) { .pulse { animation: none; } }
.env-live .k { font-size: 10px; color: var(--color-ash); text-transform: uppercase; letter-spacing: .08em; }
.env-live .v { font-size: var(--text-caption); color: var(--color-paper); }
.env-live .v.none { color: var(--color-ash); }

.scen-list { padding: 8px; display: flex; flex-direction: column; gap: 6px; flex: 1; }
.scen { border: 1px solid var(--color-iron); border-radius: var(--r); padding: 8px 10px; cursor: pointer; background: var(--color-void, #0d0d0d); }
.scen:hover { border-color: var(--color-slate); }
.scen.on { border-color: var(--color-accent); background: #131010; }
.scen.busy { opacity: .6; pointer-events: none; }
.scen-top { display: flex; align-items: center; gap: 8px; }
.scen-name { font-size: var(--text-caption); color: var(--color-paper); }
.scen.on .scen-name { color: var(--color-accent); }
.radio { width: 10px; height: 10px; border: 1.5px solid var(--color-pewter); border-radius: 50%; flex: none; }
.scen.on .radio { border-color: var(--color-accent); background: radial-gradient(circle, var(--color-accent) 0 3.5px, transparent 4px); }
.scen-desc { font-size: 10.5px; color: var(--color-ash); margin-top: 3px; line-height: 1.45; }
.scen-tag { margin-left: auto; font-size: 9px; color: var(--color-ash); border: 1px solid var(--color-iron); padding: 0 5px; border-radius: var(--r); flex: none; }
.scen-foot { margin-top: 6px; display: flex; align-items: center; }
.scen-clear { background: none; border: 1px solid var(--color-iron); color: var(--color-fog); font-family: inherit; font-size: 11px; padding: 3px 12px; border-radius: var(--r); cursor: pointer; }
.scen-clear:hover { border-color: var(--color-slate); color: var(--color-paper); }
.scen-hint { margin-left: auto; font-size: 10px; color: var(--color-steel); }
.loading { font-size: var(--text-caption); color: var(--color-steel); padding: 8px 2px; }
.err { font-size: var(--text-caption); color: var(--color-paper); display: flex; gap: 8px; align-items: center; }
.mini { background: none; border: 1px solid var(--color-iron); color: var(--color-fog); font-family: inherit; font-size: 10px; padding: 1px 8px; border-radius: var(--r); cursor: pointer; }
</style>
