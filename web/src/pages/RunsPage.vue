<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';

interface RunRow {
  id: string; ticket_key: string; kind: string; status: string; triggered_by: string;
  device_udid: string; freshness: string; started_at: number | null; finished_at: number | null;
}
const router = useRouter();
const runs = ref<RunRow[]>([]);

async function load(): Promise<void> {
  const res = await fetch('/api/runs?limit=50');
  runs.value = (await res.json() as { runs: RunRow[] }).runs;
}
onMounted(load);
</script>

<template>
  <div>
    <div class="page-header">
      <div class="page-title">runs</div>
    </div>

    <div v-if="runs.length === 0" class="empty">no runs yet</div>

    <div v-else class="table-wrap">
      <table>
        <thead>
          <tr><th>run</th><th>ticket</th><th>kind</th><th>status</th><th>freshness</th><th>by</th><th>started</th></tr>
        </thead>
        <tbody>
          <tr v-for="r in runs" :key="r.id" @click="router.push(`/runs/${r.id}`)">
            <td>{{ r.id }}</td>
            <td>
              <RouterLink :to="`/tickets/${r.ticket_key}`" style="color: inherit; text-decoration: none;">{{ r.ticket_key }}</RouterLink>
            </td>
            <td style="color: var(--color-ash);">{{ r.kind }}</td>
            <td><span class="status" :class="`status-${r.status}`">{{ r.status }}</span></td>
            <td style="color: var(--color-steel);">{{ r.freshness === 'fresh' ? '' : r.freshness === 'stale_ignored' ? '⚠ stale' : '—' }}</td>
            <td style="color: var(--color-ash);">{{ r.triggered_by }}</td>
            <td style="color: var(--color-steel);">{{ r.started_at ? new Date(r.started_at).toLocaleTimeString() : '—' }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
