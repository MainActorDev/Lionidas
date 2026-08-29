<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import TriagePanel from '../components/TriagePanel.vue';
import { useRoute } from 'vue-router';

interface Step { idx: number; flow_name: string; kind: string; name: string; status: string; reason: string | null; duration_ms: number; evidence_ids_json: string }
interface Run { id: string; ticket_key: string; status: string; kind: string; triggered_by: string; device_udid: string; artifact_hash: string | null; freshness: string; launch_args_json: string; started_at: number | null; finished_at: number | null }

const route = useRoute();
const runId = route.params.id as string;
const run = ref<Run | null>(null);
const steps = ref<Step[]>([]);
let ws: WebSocket | null = null;

const statusShape: Record<string, string> = { pass: '●', fail: '▲', skip: '○', error: '▲', passed: '●', failed: '▲', running: '◆' };

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
      load(); // final truth from db
    }
  };
});
onUnmounted(() => ws?.close());
</script>

<template>
  <main class="page">
    <header v-if="run" class="head">
      <h1>{{ run.id }} <span :class="run.status">{{ statusShape[run.status] ?? '○' }} {{ run.status }}</span></h1>
      <span class="mono dim">{{ run.ticket_key }} · {{ run.kind }} · by {{ run.triggered_by }}</span>
    </header>
    <section v-if="run" class="meta mono">
      <div>device <b>{{ run.device_udid.slice(0, 8) }}…</b></div>
      <div>artifact <b>{{ run.artifact_hash?.slice(0, 12) ?? '—' }}</b> <span v-if="run.freshness === 'stale_ignored'" class="stale">⚠ artifact older than source</span></div>
      <div>launch args <b>{{ run.launch_args_json }}</b></div>
    </section>
    <ol class="steps">
      <li v-for="s in steps" :key="s.idx" class="step" :class="s.status">
        <span class="shape">{{ statusShape[s.status] ?? '○' }}</span>
        <span class="name mono">{{ s.flow_name }}</span>
        <span class="dur mono dim">{{ s.duration_ms }}ms</span>
        <span v-if="s.reason" class="reason">{{ s.reason }}</span>
      </li>
    </ol>
    <TriagePanel :key="runId" />
  </main>
</template>

<style scoped>
.page { padding: var(--s6); }
.head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: var(--s2); }
h1 { font-size: var(--text-base); font-weight: 600; margin: 0; }
.meta { display: flex; gap: var(--s6); color: var(--fg-dim); margin-bottom: var(--s4); flex-wrap: wrap; }
.meta b { color: var(--fg); font-weight: 500; }
.stale { color: var(--amber); }
.steps { list-style: none; padding: 0; margin: 0; }
.step { display: flex; gap: var(--s2); align-items: baseline; padding: var(--s2) 0; border-bottom: 1px solid var(--border); }
.shape { width: 1.2em; }
.pass { color: var(--pass); } .fail, .error { color: var(--fail); } .running { color: var(--fg-dim); }
.reason { color: var(--fg-dim); font-size: var(--text-sm); margin-left: auto; max-width: 40%; text-align: right; }
</style>
