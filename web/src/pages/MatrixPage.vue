<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';

interface Ac { ac_id: string; ac_text: string; category: string; status: string; lastRunId: string | null; flows: string[] }
const route = useRoute();
const router = useRouter();
const ticket = route.params.key as string;
const acs = ref<Ac[]>([]);
const ticketStatus = ref('none');

const statusShape: Record<string, string> = { pass: '●', fail: '▲', skip: '○', none: '○', 'changes-pending': '◆', quarantined: '◌' };

onMounted(async () => {
  const res = await fetch(`/api/tickets/${ticket}/matrix`);
  const body = await res.json() as { acs: Ac[]; status: string };
  acs.value = body.acs;
  ticketStatus.value = body.status;
});
</script>

<template>
  <main class="page">
    <header class="head">
      <h1>{{ ticket }} <span :class="ticketStatus">{{ statusShape.pass }} {{ ticketStatus }}</span></h1>
      <span class="head-links">
        <RouterLink v-if="acs.some((a) => a.status === 'changes-pending')" to="/baselines" class="amber mono">◆ judgments pending →</RouterLink>
        <RouterLink to="/runs" class="mono dim">← runs</RouterLink>
      </span>
    </header>
    <p v-if="acs.length === 0" class="dim">No automated coverage for this ticket yet.</p>
    <table v-else class="matrix">
      <thead><tr><th></th><th>AC</th><th>category</th><th>flows</th></tr></thead>
      <tbody>
        <tr v-for="ac in acs" :key="ac.ac_id" class="row" @click="ac.lastRunId && router.push(`/runs/${ac.lastRunId}`)">
          <td :class="ac.status">{{ statusShape[ac.status] ?? '○' }}</td>
          <td>
            <div class="mono">{{ ac.ac_id }}</div>
            <div class="text">{{ ac.ac_text }}</div>
          </td>
          <td class="mono dim">{{ ac.category }}</td>
          <td class="mono dim">{{ ac.flows.join(', ') }}</td>
        </tr>
      </tbody>
    </table>
  </main>
</template>

<style scoped>
.page { padding: var(--s6); max-width: 900px; }
.head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: var(--s4); }
h1 { font-size: var(--text-base); font-weight: 600; margin: 0; }
.pass { color: var(--pass); } .fail { color: var(--fail); } .skip, .none { color: var(--fg-dim); }
.changes-pending { color: var(--amber); }
.quarantined { color: var(--fg-dim); }
.matrix { width: 100%; border-collapse: collapse; }
.matrix th { text-align: left; color: var(--fg-dim); font-weight: 500; font-size: var(--text-xs); padding: var(--s1) var(--s2); border-bottom: 1px solid var(--border); }
.matrix td { padding: var(--s2); border-bottom: 1px solid var(--border); vertical-align: top; }
.row { cursor: pointer; }
.row:hover { background: var(--surface); }
.text { color: var(--fg-dim); font-size: var(--text-sm); }
.head-links { display: flex; gap: var(--s4); align-items: baseline; }
.amber { color: var(--amber); text-decoration: none; }
</style>
