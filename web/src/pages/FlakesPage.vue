<script setup lang="ts">
import { ref, onMounted } from 'vue';

interface Flake {
  flow: string; score: number; recent: string[]; quarantined: boolean; quarantineReason: string | null;
}
const flakes = ref<Flake[]>([]);
const reason = ref('');
const msg = ref('');

async function load(): Promise<void> {
  const res = await fetch('/api/flakes');
  flakes.value = (await res.json() as { flakes: Flake[] }).flakes;
}
async function release(flow: string): Promise<void> {
  if (!reason.value) { msg.value = 'reason required to release'; return; }
  const res = await fetch(`/api/flows/${flow}/quarantine`, {
    method: 'DELETE', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason: reason.value, by: 'dashboard' }),
  });
  msg.value = res.ok ? `released ${flow}` : `failed: ${(await res.json() as { error?: string }).error ?? res.status}`;
  await load();
}
onMounted(load);
</script>

<template>
  <main class="page">
    <header class="head">
      <h1>Flakes &amp; quarantine</h1>
      <RouterLink to="/runs" class="mono dim">← runs</RouterLink>
    </header>
    <p v-if="msg" class="mono dim">{{ msg }}</p>
    <p v-if="flakes.length === 0" class="dim">No flaky flows — nothing needs attention.</p>

    <label class="mono">release reason <input v-model="reason" placeholder="e.g. root cause fixed in PR #123" /></label>
    <table class="mono">
      <thead><tr><th>flow</th><th>score</th><th>recent</th><th>state</th><th></th></tr></thead>
      <tbody>
        <tr v-for="f in flakes" :key="f.flow" :class="{ q: f.quarantined }">
          <td>{{ f.flow }}</td>
          <td>{{ f.score }}</td>
          <td class="dim">{{ f.recent.map((s) => (s === 'pass' ? '●' : s === 'skip' ? '○' : '▲')).join(' ') }}</td>
          <td>{{ f.quarantined ? `◆ quarantined (${f.quarantineReason})` : '' }}</td>
          <td><button v-if="f.quarantined" @click="release(f.flow)">Release</button></td>
        </tr>
      </tbody>
    </table>
  </main>
</template>

<style scoped>
.page { padding: var(--s6); max-width: 900px; }
.head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: var(--s4); }
h1 { font-size: var(--text-base); font-weight: 600; margin: 0 0 var(--s3); }
label { display: block; margin-bottom: var(--s3); font-size: var(--text-sm); }
input { background: var(--surface); border: 1px solid var(--border); color: var(--fg); border-radius: var(--radius-ctl); padding: var(--s1) var(--s2); width: 320px; }
table { width: 100%; border-collapse: collapse; font-size: var(--text-sm); }
th { text-align: left; color: var(--fg-dim); font-weight: 500; padding: var(--s1) var(--s2); border-bottom: 1px solid var(--border); }
td { padding: var(--s1) var(--s2); border-bottom: 1px solid var(--border); }
.q td { color: var(--fg-dim); }
button { border: 1px solid var(--border); background: var(--surface); color: var(--fg); border-radius: var(--radius-ctl); padding: var(--s1) var(--s2); cursor: pointer; }
</style>
