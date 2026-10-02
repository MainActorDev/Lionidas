<script setup lang="ts">
/** Environment drawer content (S3): scenario radios (activate/clear via forge
 *  routes), location display, env-vars pointer. Mounts inside SideDrawer. */
import { onMounted, ref } from 'vue';

const scenarios = ref<Array<{ id: string; name: string; active: boolean }>>([]);
const location = ref('—');
const envCount = ref<number | null>(null);
const busy = ref(false);
const error = ref('');

async function load(): Promise<void> {
  try {
    const r = await fetch('/api/forge/scenarios');
    const b = await r.json() as { scenarios?: Array<{ id: string; name: string; changedSincePlay?: boolean }> };
    scenarios.value = (b.scenarios ?? []).map((s) => ({ id: s.id, name: s.name, active: false }));
  } catch { error.value = 'failed to load scenarios'; }
}
onMounted(load);

async function activate(id: string): Promise<void> {
  busy.value = true; error.value = '';
  try {
    const r = await fetch(`/api/forge/scenarios/${encodeURIComponent(id)}/activate`, { method: 'POST' });
    if (!r.ok) error.value = `activate failed (${r.status})`;
    else scenarios.value.forEach((s) => { s.active = s.id === id; });
  } finally { busy.value = false; }
}
async function clearAll(): Promise<void> {
  busy.value = true;
  try {
    const r = await fetch('/api/forge/network-condition', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ udid: null, profile: null }) });
    if (!r.ok) error.value = `clear failed (${r.status})`;
    else scenarios.value.forEach((s) => { s.active = false; });
  } finally { busy.value = false; }
}
</script>

<template>
  <div class="env">
    <div v-for="s in scenarios" :key="s.id" class="scen" :class="{ act: s.active }" @click="activate(s.id)">
      <span><span class="chk">{{ s.active ? '✓' : '' }}</span>{{ s.name }}</span>
    </div>
    <div class="actions"><button type="button" :disabled="busy" @click="clearAll">clear scenario</button></div>
    <div class="row"><span class="k">location</span><span class="v">{{ location }}</span></div>
    <div class="row"><span class="k">env vars</span><span class="v">see env page</span></div>
    <div v-if="error" class="err">{{ error }}</div>
  </div>
</template>

<style scoped>
.env { display: flex; flex-direction: column; gap: 4px; }
.scen { padding: 5px 8px; color: var(--color-fog); font-size: var(--text-caption); cursor: pointer; border-radius: var(--r); }
.scen:hover { background: var(--color-iron); color: var(--color-paper); }
.scen.act { color: var(--color-ember); }
.chk { width: 12px; display: inline-block; }
.actions { margin: 8px 0; }
.actions button { font-family: inherit; background: none; border: 1px solid var(--color-iron); color: var(--color-fog); padding: 2px 10px; border-radius: var(--r); cursor: pointer; font-size: var(--text-caption); }
.actions button:hover { border-color: var(--color-slate); color: var(--color-paper); }
.row { display: flex; justify-content: space-between; padding: 3px 0; font-size: var(--text-caption); }
.k { color: var(--color-fog); } .v { color: var(--color-paper); }
.err { color: var(--color-paper); font-size: var(--text-caption); margin-top: 6px; }
</style>
