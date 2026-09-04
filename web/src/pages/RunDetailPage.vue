<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue';
import { useRoute } from 'vue-router';
import TriagePanel from '../components/TriagePanel.vue';
import { useLiveEvents } from '../stores/live.ts';

interface Step { idx: number; flow_name: string; kind: string; name: string; status: string; reason: string | null; duration_ms: number; evidence_ids_json: string; evaluated_json?: string | null }
interface Run { id: string; ticket_key: string; status: string; kind: string; triggered_by: string; device_udid: string; artifact_hash: string | null; freshness: string; launch_args_json: string; started_at: number | null; finished_at: number | null; template_id: string | null; app_version: string | null; blocked: number; note: string | null }

const route = useRoute();
const runId = route.params.id as string;
const run = ref<Run | null>(null);
const steps = ref<Step[]>([]);
const live = useLiveEvents();

async function load(): Promise<void> {
  const [r, s] = await Promise.all([
    fetch(`/api/runs/${runId}`).then((x) => x.json()) as Promise<{ run: Run }>,
    fetch(`/api/runs/${runId}/steps`).then((x) => x.json()) as Promise<{ steps: Step[] }>,
  ]);
  run.value = r.run;
  steps.value = s.steps;
  void loadTraffic();
}

const attachMsg = ref('');

/** B1: this run's own HTTP traffic — what the app (and the host, while the
 *  proxy routes it) talked to while THIS run executed. Empty + proxy down =
 *  hint, not silence (pages teach themselves). */
interface TrafficRow { id: string; run_id: string | null; ts: number; method: string; host: string; path: string; status: number; latency_ms: number }
const traffic = ref<TrafficRow[]>([]);
const proxyRunning = ref(false);
async function loadTraffic(): Promise<void> {
  const [t, m] = await Promise.all([
    fetch(`/api/forge/traffic?runId=${runId}`).then((x) => x.json()) as Promise<{ traffic: TrafficRow[] }>,
    fetch('/api/forge/mitm/status').then((x) => x.json()) as Promise<{ running: boolean }>,
  ]);
  traffic.value = t.traffic ?? [];
  proxyRunning.value = m.running;
}
async function attachJira(): Promise<void> {
  const res = await fetch(`/api/runs/${runId}/attach`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const body = await res.json() as { attached?: boolean; commentId?: string; ticket?: string; error?: string };
  attachMsg.value = body.attached ? `comment ${body.commentId} → ${body.ticket}` : (body.error ?? `HTTP ${res.status}`);
}

/** A4 evaluated display: the post-substitution step (what actually executed),
 *  shown when it differs from the recorded template step. */
function evaluatedText(s: Step): string | null {
  if (!s.evaluated_json) return null;
  try {
    const ev = JSON.parse(s.evaluated_json) as { action?: string; text?: string; x?: number; y?: number; direction?: string; resolvedBy?: string; flow?: string; expect?: { label?: string; labelContains?: string; ignoreCase?: boolean; identifier?: string }; matched?: number };
    const summary = ev.action === 'type' ? `type "${(ev.text ?? '').slice(0, 24)}"` : ev.action === 'tap' ? `tap ${ev.x},${ev.y}` : ev.action ? `${ev.action} ${ev.direction ?? ''}`.trim() : '';
    const provenance = [ev.flow ? `flow:${ev.flow}` : null, ev.resolvedBy, ev.expect ? `expect ${ev.expect.labelContains !== undefined ? `contains: ${ev.expect.labelContains}` : ev.expect.label ?? ev.expect.identifier ?? '?'}${ev.expect.ignoreCase === true ? ' (ignore case)' : ''} · matched ${ev.matched ?? '?'}` : null].filter(Boolean).join(' · ');
    return [summary, provenance].filter(Boolean).join(' — ') || null;
  } catch { return null; }
}

onMounted(() => {
  load();
  live.connect();
  const onEvent = (ev: { type: string; payload: Record<string, unknown> }): void => {
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
  const unwatch = watch(
    () => live.events.length,
    () => {
      const latest = live.events[live.events.length - 1];
      if (latest) onEvent(latest);
    },
    { flush: 'sync' },
  );
  onUnmounted(() => { unwatch(); live.release(); });
});
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
      <div style="display: flex; gap: var(--s-2); align-items: center;">
        <span v-if="attachMsg" class="badge">{{ attachMsg }}</span>
        <button class="btn btn-sm" @click="attachJira">attach → jira</button>
        <span class="status" :class="`status-${run.status}`">{{ run.status }}</span>
      </div>
    </div>

    <div class="card">
      <div class="meta-row"><span class="k">device</span><b>{{ run.device_udid.slice(0, 8) }}…</b></div>
      <div class="meta-row"><span class="k">build</span><b>{{ run.app_version ? `v${run.app_version}` : 'unknown' }}</b></div>
      <div class="meta-row"><span class="k">artifact</span><b>{{ run.artifact_hash?.slice(0, 12) ?? '—' }}</b></div>
      <div class="meta-row">
        <span class="k">freshness</span>
        <b>{{ run.freshness }}</b>
        <span v-if="run.freshness === 'stale_ignored'" class="badge badge-accent">⚠ older than source</span>
      </div>
      <div class="meta-row"><span class="k">launch args</span><b>{{ run.launch_args_json }}</b></div>
    </div>

    <div v-if="run.blocked === 1" class="card card-accent" style="border-left-style: dashed;">
      <b>◆ blocked — infrastructure failure, not an app failure</b>
      <div style="font-size: 11px; color: var(--color-steel); margin-top: 4px;">
        {{ run.note?.includes('already bound') ? 'engine session bound to another device — release it (engine close --session alloy) or restart the server, then re-run' : 'the app never got tested — device/engine/network failed before or during the run' }}
      </div>
    </div>

    <div class="section-label">steps</div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>#</th><th>flow</th><th>status</th><th>duration</th><th>reason</th></tr></thead>
        <tbody>
          <tr v-for="s in steps" :key="s.idx" style="cursor: default;">
            <td style="color: var(--color-steel);">{{ s.idx }}</td>
            <td>
              {{ s.flow_name }}
              <div v-if="evaluatedText(s)" class="evaluated" :title="evaluatedText(s) ?? ''">↳ {{ evaluatedText(s) }}</div>
            </td>
            <td><span class="status" :class="`status-${s.status}`">{{ s.status }}</span></td>
            <td style="color: var(--color-ash);">{{ s.duration_ms }}ms</td>
            <td style="color: var(--color-steel); font-size: var(--text-caption); max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">{{ s.reason ?? '' }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="section-label">network</div>
    <div v-if="traffic.length > 0" class="table-wrap">
      <table>
        <thead><tr><th>method</th><th>host</th><th>path</th><th>status</th><th>latency</th></tr></thead>
        <tbody>
          <tr v-for="t in traffic" :key="t.id" style="cursor: default;">
            <td class="mono">{{ t.method }}</td>
            <td style="max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">{{ t.host }}</td>
            <td style="color: var(--color-ash); max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" :title="t.path">{{ t.path }}</td>
            <td><span class="status" :class="t.status < 400 ? 'status-pass' : 'status-fail'">{{ t.status }}</span></td>
            <td style="color: var(--color-steel);">{{ t.latency_ms }}ms</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-else class="card" style="font-size: 12px; color: var(--color-steel);">
      no traffic captured for this run<span v-if="!proxyRunning"> — <RouterLink to="/forge">the network proxy was not running</RouterLink>; start it there before a run to capture</span>
    </div>

    <TriagePanel :key="runId" />
  </div>
</template>

<style scoped>
.evaluated { color: var(--color-steel); font-size: 10px; margin-top: 2px; white-space: normal; }
</style>
