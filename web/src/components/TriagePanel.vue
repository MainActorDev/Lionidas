<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import { useRoute } from 'vue-router';

interface TriageBundle {
  step: { idx: number; flow: string; status: string; reason: string | null; durationMs: number };
  evidence: Array<{ id: string; type: string; path: string; sha256: string; bytes: number }>;
  runEvidence: Array<{ id: string; type: string }>;
  run: { ticket: string; artifactHash: string | null; freshness: string; launchArgs: string; device: string };
}
interface Step { idx: number; flow_name: string; status: string; reason: string | null }

const route = useRoute();
const runId = route.params.id as string;
const steps = ref<Step[]>([]);
const bundle = ref<TriageBundle | null>(null);
const rerunning = ref(false);
const rerunId = ref<string | null>(null);

const failedSteps = computed(() => steps.value.filter((s) => s.status === 'fail' || s.status === 'error'));

async function load(): Promise<void> {
  const res = await fetch(`/api/runs/${runId}/steps`);
  steps.value = (await res.json() as { steps: Step[] }).steps;
}
async function openTriage(idx: number): Promise<void> {
  const res = await fetch(`/api/runs/${runId}/steps/${idx}/triage`);
  bundle.value = await res.json() as TriageBundle;
}
async function rerunFragment(idx: number): Promise<void> {
  rerunning.value = true;
  try {
    const res = await fetch(`/api/runs/${runId}/steps/${idx}/rerun`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const body = await res.json() as { rerunId?: string; error?: string };
    rerunId.value = body.rerunId ?? body.error ?? null;
  } finally {
    rerunning.value = false;
  }
}
onMounted(load);
</script>

<template>
  <section v-if="failedSteps.length > 0">
    <div class="section-label">triage · {{ failedSteps.length }} failed</div>

    <div style="display: flex; gap: var(--s-2); margin-bottom: var(--s-3);">
      <button v-for="s in failedSteps" :key="s.idx" class="btn btn-sm btn-danger" @click="openTriage(s.idx)">✕ {{ s.flow_name }}</button>
    </div>

    <div v-if="bundle" class="card card-accent">
      <div class="card-header">
        <span class="card-title">{{ bundle.step.flow }} · {{ bundle.step.durationMs }}ms</span>
        <div style="display: flex; gap: var(--s-2);">
          <button class="btn btn-sm" :disabled="rerunning" @click="rerunFragment(bundle.step.idx)">{{ rerunning ? 'running…' : 're-run fragment' }}</button>
          <RouterLink v-if="rerunId?.startsWith('run_')" :to="`/runs/${rerunId}`" class="btn btn-sm">{{ rerunId }}</RouterLink>
        </div>
      </div>
      <div class="log-block" style="margin-bottom: var(--s-3);">{{ bundle.step.reason ?? 'no reason recorded' }}</div>

      <div class="evidence-grid">
        <figure v-for="ev in bundle.evidence.filter((e) => e.type === 'screenshot' || e.type === 'diff')" :key="ev.id">
          <img :src="`/api/evidence/${ev.id}/file`" :alt="ev.type" />
          <figcaption>{{ ev.type }} · {{ Math.round(ev.bytes / 1024) }}KB</figcaption>
        </figure>
      </div>

      <div class="meta-row" style="margin-top: var(--s-3);"><span class="k">ticket</span><b>{{ bundle.run.ticket }}</b></div>
      <div class="meta-row"><span class="k">artifact</span><b>{{ bundle.run.artifactHash?.slice(0, 12) ?? '—' }}</b>
        <span v-if="bundle.run.freshness === 'stale_ignored'" class="badge badge-accent">⚠ stale</span></div>
      <div class="meta-row"><span class="k">launch args</span><b>{{ bundle.run.launchArgs }}</b></div>
      <div class="meta-row" v-if="bundle.runEvidence.length > 0">
        <span class="k">run evidence</span>
        <b>
          <a v-for="ev in bundle.runEvidence" :key="ev.id" :href="`/api/evidence/${ev.id}/file`" target="_blank" style="color: var(--color-fog); margin-right: var(--s-2);">{{ ev.type }}</a>
        </b>
      </div>
    </div>
  </section>
</template>
