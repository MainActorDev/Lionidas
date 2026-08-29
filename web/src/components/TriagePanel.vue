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
const copyCmd = (): void => {
  if (!bundle.value) return;
  const cmd = `alloy flow ${bundle.value.run.device} --ticket ${bundle.value.run.ticket} # evidence: /api/runs/${runId}`;
  void navigator.clipboard.writeText(cmd);
};
onMounted(load);
</script>

<template>
  <section v-if="failedSteps.length > 0" class="triage">
    <h2>Triage — {{ failedSteps.length }} failed step(s)</h2>
    <div class="fails">
      <button v-for="s in failedSteps" :key="s.idx" class="failchip" @click="openTriage(s.idx)">
        ▲ {{ s.flow_name }}
      </button>
    </div>

    <article v-if="bundle" class="panel">
      <header>
        <h3>{{ bundle.step.flow }} <span class="mono dim">{{ bundle.step.durationMs }}ms</span></h3>
        <div class="actions">
          <button :disabled="rerunning" @click="rerunFragment(bundle.step.idx)">{{ rerunning ? 'running…' : 'Re-run fragment' }}</button>
          <button @click="copyCmd">Copy alloy command</button>
          <RouterLink v-if="rerunId?.startsWith('run_')" :to="`/runs/${rerunId}`" class="mono">→ {{ rerunId }}</RouterLink>
        </div>
      </header>
      <p class="reason">{{ bundle.step.reason ?? 'no reason recorded' }}</p>

      <div class="grid">
        <figure v-for="ev in bundle.evidence.filter((e) => e.type === 'screenshot' || e.type === 'diff')" :key="ev.id">
          <img :src="`/api/evidence/${ev.id}/file`" :alt="ev.type" />
          <figcaption class="mono dim">{{ ev.type }} · {{ Math.round(ev.bytes / 1024) }}KB</figcaption>
        </figure>
      </div>

      <dl class="meta mono">
        <div><dt>ticket</dt><dd>{{ bundle.run.ticket }}</dd></div>
        <div><dt>artifact</dt><dd>{{ bundle.run.artifactHash?.slice(0, 12) ?? '—' }} <span v-if="bundle.run.freshness === 'stale_ignored'" class="stale">⚠ stale</span></dd></div>
        <div><dt>launch args</dt><dd>{{ bundle.run.launchArgs }}</dd></div>
      </dl>

      <div class="runev mono dim">
        run evidence:
        <a v-for="ev in bundle.runEvidence" :key="ev.id" :href="`/api/evidence/${ev.id}/file`" target="_blank">{{ ev.type }}</a>
      </div>
    </article>
  </section>
</template>

<style scoped>
.triage { margin-top: var(--s6); }
h2 { font-size: var(--text-sm); font-weight: 600; color: var(--fail); margin: 0 0 var(--s2); }
.fails { display: flex; gap: var(--s2); margin-bottom: var(--s3); }
.failchip { background: var(--surface); border: 1px solid var(--fail); color: var(--fail); border-radius: var(--radius-ctl); padding: var(--s1) var(--s2); cursor: pointer; font-size: var(--text-sm); }
.panel { border: 1px solid var(--border); border-radius: var(--radius-card); background: var(--surface); padding: var(--s4); }
.panel header { display: flex; justify-content: space-between; align-items: baseline; gap: var(--s3); }
h3 { font-size: var(--text-sm); font-weight: 600; margin: 0 0 var(--s2); }
.actions { display: flex; gap: var(--s2); align-items: baseline; }
.actions button { border: 1px solid var(--border); background: var(--bg); color: var(--fg); border-radius: var(--radius-ctl); padding: var(--s1) var(--s2); cursor: pointer; font-size: var(--text-xs); }
.reason { color: var(--fg-dim); font-size: var(--text-sm); border-left: 3px solid var(--fail); padding-left: var(--s2); }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: var(--s3); margin: var(--s3) 0; }
.grid img { width: 100%; border: 1px solid var(--border); border-radius: var(--radius-ctl); display: block; }
.meta { display: flex; gap: var(--s6); flex-wrap: wrap; }
.meta dt { color: var(--fg-dim); display: inline; }
.meta dd { display: inline; margin: 0 0 0 var(--s1); }
.stale { color: var(--amber); }
.runev a { color: var(--accent); margin-right: var(--s2); text-decoration: none; }
</style>
