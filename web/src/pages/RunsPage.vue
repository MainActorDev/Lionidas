<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useLiveEvents } from '../stores/live.ts';

interface RunRow {
  id: string; ticket_key: string; kind: string; status: string; triggered_by: string;
  device_udid: string; freshness: string; started_at: number | null; finished_at: number | null;
}
const router = useRouter();
const runs = ref<RunRow[]>([]);
const live = useLiveEvents();
let poll: ReturnType<typeof setInterval> | null = null;

async function load(): Promise<void> {
  const res = await fetch('/api/runs?limit=50');
  runs.value = (await res.json() as { runs: RunRow[] }).runs;
}
function ago(ts: number | null): string {
  if (!ts) return '—';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// live: run lifecycle events refresh the table instantly (no 5s wait)
const unwatch = watch(
  () => live.events.length,
  () => {
    const latest = live.events[live.events.length - 1];
    if (latest && (latest.type === 'run.started' || latest.type === 'run.finished' || latest.type === 'queue.changed')) void load();
  },
);

onMounted(() => {
  live.connect();
  void load();
  poll = setInterval(() => void load(), 5000); // safety net
});
onUnmounted(() => { if (poll) clearInterval(poll); unwatch(); live.release(); });
</script>

<template>
  <div>
    <div class="page-header">
      <div>
        <div class="page-title">runs</div>
        <div class="page-desc">
          {{ runs.length }} recent
          <span v-if="!live.connected" style="color: var(--color-ember);"> · live offline</span>
        </div>
      </div>
    </div>

    <div v-if="runs.length === 0" class="empty">no runs yet — trigger one from the wall (+ new run)</div>

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
            <td style="color: var(--color-steel);">{{ ago(r.started_at) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
