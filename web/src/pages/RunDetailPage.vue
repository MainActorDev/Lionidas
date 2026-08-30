<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { useRoute } from 'vue-router';
import TriagePanel from '../components/TriagePanel.vue';

interface Step { idx: number; flow_name: string; kind: string; name: string; status: string; reason: string | null; duration_ms: number; evidence_ids_json: string }
interface Run { id: string; ticket_key: string; status: string; kind: string; triggered_by: string; device_udid: string; artifact_hash: string | null; freshness: string; launch_args_json: string; started_at: number | null; finished_at: number | null }

const route = useRoute();
const runId = route.params.id as string;
const run = ref<Run | null>(null);
const steps = ref<Step[]>([]);
let ws: WebSocket | null = null;

async function load(): Promise<void> {
  const [r, s] = await Promise.all([
    fetch(`/api/runs/${runId}`).then((x) => x.json()) as Promise<{ run: Run }>,
    fetch(`/api/runs/${runId}/steps`).then((x) => x.json()) as Promise<{ steps: Step[] }>,
  ]);
  run.value = r.run;
  steps.value = s.steps;
}

onMounted(() => {
  load();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/api/events`);
  ws.onmessage = (m) => {
    const ev = JSON.parse(m.data) as { type: string; payload: Record<string, unknown> };
    if (ev.type === 'step.started' && ev.payload['runId'] === runId) {
      steps.value.push({ idx: ev.payload['idx'] as number, flow_name: ev.payload['flow'] as string, kind: 'flow', name: ev.payload['flow'] as string, status: 'running', reason: null, duration_ms: 0, evidence_ids_json: '[]' });
    } else if (ev.type === 'step.finished' && ev.payload['runId'] === runId) {
      const idx = ev.payload['idx'] as number;
      const s = steps.value.find((x) => x.idx === idx);
      if (s) { s.status = ev.payload['status'] as string; s.duration_ms = ev.payload['durationMs'] as number; }
    } else if (ev.type === 'run.finished' && ev.payload['runId'] === runId) {
      load();
    }
  };
});
onUnmounted(() => ws?.close());
</script>

<template>
  <div v-if="run">
    <div class="page-header">
      <div>
        <div class="page-title">{{ run.id }}</div>
        <div class="page-desc">
          <RouterLink :to="`/tickets/${run.ticket_key}`" style="color: inherit;">{{ run.ticket_key }}</RouterLink>
          · {{ run.kind }} · by {{ run.triggered_by }} · {{ run.started_at ? new Date(run.started_at).toLocaleString() : '' }}
        </div>
      </div>
      <span class="status" :class="`status-${run.status}`">{{ run.status }}</span>
    </div>

    <div class="card">
      <div class="meta-row"><span class="k">device</span><b>{{ run.device_udid.slice(0, 8) }}…</b></div>
      <div class="meta-row"><span class="k">artifact</span><b>{{ run.artifact_hash?.slice(0, 12) ?? '—' }}</b></div>
      <div class="meta-row">
        <span class="k">freshness</span>
        <b>{{ run.freshness }}</b>
        <span v-if="run.freshness === 'stale_ignored'" class="badge badge-accent">⚠ older than source</span>
      </div>
      <div class="meta-row"><span class="k">launch args</span><b>{{ run.launch_args_json }}</b></div>
    </div>

    <div class="section-label">steps</div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>#</th><th>flow</th><th>status</th><th>duration</th><th>reason</th></tr></thead>
        <tbody>
          <tr v-for="s in steps" :key="s.idx" style="cursor: default;">
            <td style="color: var(--color-steel);">{{ s.idx }}</td>
            <td>{{ s.flow_name }}</td>
            <td><span class="status" :class="`status-${s.status}`">{{ s.status }}</span></td>
            <td style="color: var(--color-ash);">{{ s.duration_ms }}ms</td>
            <td style="color: var(--color-steel); font-size: var(--text-caption); max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">{{ s.reason ?? '' }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <TriagePanel :key="runId" />
  </div>
</template>
