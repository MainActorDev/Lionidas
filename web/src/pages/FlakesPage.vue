<script setup lang="ts">
import PageHeader from '../components/PageHeader.vue';
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
  <div>
    <PageHeader title="flaky tests">
      <span class="ph-desc">{{ flakes.filter((f) => f.quarantined).length }} quarantined</span>
    </PageHeader>

    <div v-if="msg" class="meta-row">{{ msg }}</div>

    <div v-if="flakes.length === 0" class="empty">no flaky flows — nothing needs attention</div>

    <template v-else>
      <div class="card">
        <div class="meta-row"><span class="k">release reason</span><input v-model="reason" placeholder="e.g. root cause fixed in PR #123" /></div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>flow</th><th>score</th><th>recent</th><th>state</th><th></th></tr></thead>
          <tbody>
            <tr v-for="f in flakes" :key="f.flow" style="cursor: default;">
              <td>{{ f.flow }}</td>
              <td style="color: var(--color-ash);">{{ f.score }}</td>
              <td style="color: var(--color-steel); letter-spacing: 2px;">{{ f.recent.map((s) => (s === 'pass' ? '✓' : s === 'skip' ? '·' : '✕')).join(' ') }}</td>
              <td>
                <span v-if="f.quarantined" class="status status-quarantined">quarantined</span>
                <span v-else style="color: var(--color-steel);">—</span>
              </td>
              <td><button v-if="f.quarantined" class="btn btn-sm" @click="release(f.flow)">release</button></td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>
