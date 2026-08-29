<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';

interface RunRow {
  id: string; ticket_key: string; kind: string; status: string; triggered_by: string;
  device_udid: string; freshness: string; started_at: number | null; finished_at: number | null;
}
const router = useRouter();
const runs = ref<RunRow[]>([]);

const statusShape: Record<string, string> = { passed: '●', failed: '▲', running: '◆', queued: '○', aborted: '○' };

async function load(): Promise<void> {
  const res = await fetch('/api/runs?limit=50');
  const body = await res.json() as { runs: RunRow[] };
  runs.value = body.runs;
}
onMounted(load);
</script>

<template>
  <main class="page">
    <header class="head">
      <h1>Runs</h1>
      <RouterLink to="/" class="mono dim">← wall</RouterLink>
    </header>
    <p v-if="runs.length === 0" class="dim">No runs yet — trigger one via the CLI (M2 adds the button).</p>
    <table v-else class="runs mono">
      <thead>
        <tr><th></th><th>run</th><th>ticket</th><th>kind</th><th>device</th><th>freshness</th><th>status</th><th>started</th></tr>
      </thead>
      <tbody>
        <tr v-for="r in runs" :key="r.id" class="row" @click="router.push(`/runs/${r.id}`)">
          <td :class="r.status">{{ statusShape[r.status] ?? '○' }}</td>
          <td>{{ r.id }}</td>
          <td>{{ r.ticket_key }}</td>
          <td>{{ r.kind }}</td>
          <td class="dim">{{ r.device_udid.slice(0, 8) }}</td>
          <td>{{ r.freshness === 'fresh' ? '' : (r.freshness === 'stale_ignored' ? '⚠ stale' : '—') }}</td>
          <td :class="r.status">{{ r.status }}</td>
          <td class="dim">{{ r.started_at ? new Date(r.started_at).toLocaleTimeString() : '—' }}</td>
        </tr>
      </tbody>
    </table>
  </main>
</template>

<style scoped>
.page { padding: var(--s6); }
.head { display: flex; justify-content: space-between; align-items: baseline; }
h1 { font-size: var(--text-base); font-weight: 600; margin: 0 0 var(--s4); }
.dim { color: var(--fg-dim); }
.runs { width: 100%; border-collapse: collapse; font-size: var(--text-sm); }
.runs th { text-align: left; color: var(--fg-dim); font-weight: 500; padding: var(--s1) var(--s2); border-bottom: 1px solid var(--border); }
.runs td { padding: var(--s1) var(--s2); border-bottom: 1px solid var(--border); }
.row { cursor: pointer; }
.row:hover { background: var(--surface); }
.passed { color: var(--pass); }
.failed { color: var(--fail); }
.running, .queued { color: var(--fg-dim); }
</style>
