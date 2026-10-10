<script setup lang="ts">
/** P3 agent chat — the run workspace panel (b1-warm): tabs pipeline/artifacts,
 *  vertical stage flow with live results, the question card, knowledge page,
 *  drafts. Collapses to zero width; a floating pill reopens while a run is
 *  live. State from GET /api/agent/pipeline/:id + /api/agent/artifacts. */
import { ref, watch, computed } from 'vue';

interface StageRow { id: string; status: string; attempt: number; question?: { questions: Array<{ id: string; text: string }> } }
interface RunState { run: { id: string; status: string; currentStage: string | null }; stages: StageRow[] }
interface Artifact { id: string; kind: string; name: string; version: number; runId: string | null; supersededBy: string | null; createdAt: number }
interface ArtifactBody extends Artifact { body: string; provenance_json: string | null }

const props = defineProps<{ runId: string | null }>();
const emit = defineEmits<{ collapsed: [] }>();

const run = ref<RunState | null>(null);
const tab = ref<'pipeline' | 'artifacts'>('pipeline');
const panelOpen = ref(true);
const artifacts = ref<Artifact[]>([]);
const knowledge = ref<ArtifactBody | null>(null);
const answers = ref<Record<string, string>>({});
const working = ref(false);

const live = computed(() => run.value?.run.status === 'running' || run.value?.run.status === 'awaiting_answer');
const question = computed(() => run.value?.stages.find((s) => s.status === 'paused' && s.question));

async function refresh(): Promise<void> {
  if (!props.runId) { run.value = null; return; }
  const r = await fetch(`/api/agent/pipeline/${props.runId}`);
  if (r.ok) run.value = await r.json();
}

async function loadArtifacts(): Promise<void> {
  if (!props.runId) { artifacts.value = []; knowledge.value = null; return; }
  // knowledge pages are versioned per (kind,name); the run's snapshot rows ride the kind query
  // the run's own rows (scope/breakdown) + the per-app knowledge page (its run_id is the compile id,
  // not the workflow id — fetch by kind and take the latest version for THIS app context)
  const [byRun, byKnowledge] = await Promise.all([
    fetch(`/api/agent/artifacts?runId=${props.runId}`),
    fetch(`/api/agent/artifacts?kind=knowledge`),
  ]);
  const rows: Artifact[] = [];
  if (byRun.ok) rows.push(...(((await byRun.json()) as { artifacts: Artifact[] }).artifacts ?? []));
  if (byKnowledge.ok) rows.push(...(((await byKnowledge.json()) as { artifacts: Artifact[] }).artifacts ?? []));
  artifacts.value = rows;
  const k = artifacts.value
    .filter((a) => a.kind === 'knowledge' && !a.supersededBy)
    .sort((a, b) => b.version - a.version)[0];
  if (k) {
    const kr = await fetch(`/api/agent/artifacts/${k.id}`);
    if (kr.ok) knowledge.value = await kr.json();
  } else knowledge.value = null;
}

async function answer(skip = false): Promise<void> {
  if (!props.runId || !question.value || working.value) return;
  working.value = true;
  try {
    const payload = skip ? {} : Object.fromEntries(question.value.question!.questions.map((q) => [q.id, answers.value[q.id] ?? '']));
    await fetch(`/api/agent/pipeline/${props.runId}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stageId: question.value.id, answers: payload }) });
    await fetch(`/api/agent/pipeline/${props.runId}/resume`, { method: 'POST' });
    await refresh();
  } finally { working.value = false; }
}

function close(): void { panelOpen.value = false; emit('collapsed'); }
function open(): void { panelOpen.value = true; }

watch(() => props.runId, () => { void refresh(); void loadArtifacts(); }, { immediate: true });
defineExpose({ refresh, open, panelOpen, live });
</script>

<template>
  <aside class="panel" :class="{ closed: !panelOpen }">
    <div class="phead">
      <span class="t">{{ run ? run.run.id : 'run' }}</span>
      <div class="ptabs">
        <span class="ptab" :class="{ on: tab === 'pipeline' }" @click="tab = 'pipeline'">pipeline</span>
        <span class="ptab" :class="{ on: tab === 'artifacts' }" @click="tab = 'artifacts'">artifacts</span>
      </div>
      <button class="x" title="collapse" @click="close">»</button>
    </div>

    <div class="pbody">
      <template v-if="!run">
        <div class="none">attach refs and send to start a run</div>
      </template>

      <template v-else-if="tab === 'pipeline'">
        <div class="flow">
          <template v-for="(s, i) in run.stages" :key="s.id">
            <div class="fnode" :class="s.status">
              <span class="b"></span>
              <div class="meta"><div class="nm">{{ s.id }}</div><div class="st">{{ s.status }}<span v-if="s.attempt > 1"> · try {{ s.attempt }}</span></div></div>
            </div>
            <div v-if="i < run.stages.length - 1" class="flink" :class="{ done: run.stages[i + 1]!.status !== 'pending' }"></div>
          </template>
          <div v-if="run.run.status === 'done'" class="alldone">✓ run complete</div>
          <div v-if="run.run.status === 'failed'" class="allfail">✕ run failed</div>
        </div>

        <div v-if="question" class="q">
          <div class="ql">✦ a question before I continue</div>
          <div v-for="q in question.question!.questions" :key="q.id" class="qt">{{ q.text }}</div>
          <textarea v-for="q in question.question!.questions" :key="'a-' + q.id" v-model="answers[q.id]" class="ag-mono" placeholder="type your answer…"></textarea>
          <div class="row">
            <button class="btn" :disabled="working" @click="answer(true)">skip</button>
            <button class="btn primary" :disabled="working" @click="answer(false)">answer &amp; continue</button>
          </div>
        </div>
      </template>

      <template v-else>
        <div v-if="knowledge" class="kdoc">
          <div class="kt">{{ knowledge.name }}</div>
          <div class="kv">v{{ knowledge.version }}{{ knowledge.supersededBy ? ' · superseded' : ' · latest' }} · compounding</div>
          <pre class="kb">{{ knowledge.body.slice(0, 1200) }}</pre>
        </div>
        <div class="rlabel">artifacts</div>
        <div v-for="a in artifacts" :key="a.id" class="arow">
          <span class="k">{{ a.kind }}</span><span class="n">{{ a.name }}</span><span class="v">v{{ a.version }}</span>
        </div>
        <div v-if="!artifacts.length" class="none">no artifacts yet</div>
      </template>
    </div>
  </aside>

  <button v-if="!panelOpen" class="reopen" @click="open">
    <span v-if="live" class="dot"></span>{{ live ? 'run live — open panel' : 'run — open panel' }}
  </button>
</template>

<style scoped>
.panel { width: 340px; flex: none; background: var(--ag-panel); border-left: 1px solid var(--ag-line); display: flex; flex-direction: column; min-height: 0; transition: width 200ms ease; overflow: hidden; }
.panel.closed { width: 0; border-left: none; }
.phead { display: flex; align-items: center; gap: var(--s-2); height: var(--ag-head-h); flex: none; padding: 0 var(--s-3); border-bottom: 1px solid var(--ag-line); background: var(--ag-panel); }
.phead .t { font-size: var(--text-caption); color: var(--color-paper); font-family: var(--font-mono); }
.ptabs { display: flex; gap: 4px; margin-left: auto; }
.ptab { border: 1px solid var(--ag-line); border-radius: var(--r-sm); padding: 1px var(--s-2); font-size: var(--text-caption); color: var(--color-steel); cursor: pointer; font-family: var(--font-mono); }
.ptab.on { color: var(--color-ember); border-color: var(--color-ember-dim); background: var(--ag-surface); }
.x { width: 22px; height: 22px; border: 1px solid var(--ag-line); border-radius: var(--r-sm); background: none; color: var(--color-ash); cursor: pointer; font-size: 10px; font-family: var(--font-mono); }
.x:hover { color: var(--color-paper); border-color: var(--ag-line-2); }
.pbody { flex: 1; overflow-y: auto; padding: var(--s-3); display: flex; flex-direction: column; gap: var(--s-3); }
.none { font-size: var(--text-caption); color: var(--color-steel); padding: var(--s-3); text-align: center; }

.fnode { display: flex; align-items: center; gap: var(--s-2); }
.fnode .b { width: 9px; height: 9px; border-radius: var(--r-sm); border: 1px solid var(--ag-line-2); flex: none; }
.fnode.done .b { background: var(--color-fog); border-color: var(--color-fog); }
.fnode.running .b { background: var(--color-ember); border-color: var(--color-ember); animation: agpulse 1.3s infinite; }
.fnode .nm { font-size: var(--text-caption); color: var(--color-paper); font-family: var(--font-mono); }
.fnode .st { font-size: 10px; color: var(--color-steel); }
.fnode.done .st { color: var(--color-fog); }
.flink { width: 1px; height: 12px; background: var(--ag-line); margin-left: 4px; }
.alldone { font-size: var(--text-caption); color: var(--color-paper); margin-top: 6px; }
.allfail { font-size: var(--text-caption); color: var(--color-ember); margin-top: 6px; }

.q { border: 1px solid var(--color-ember-dim); border-left: 2px solid var(--color-ember); border-radius: var(--r-sm); padding: var(--s-2) var(--s-3); background: var(--ag-surface); }
.ql { font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--color-ember); margin-bottom: 6px; }
.qt { font-size: var(--text-body); line-height: 1.55; margin-bottom: var(--s-2); color: var(--color-paper); }
.q textarea { width: 100%; border: 1px solid var(--ag-line); border-radius: var(--r-sm); padding: var(--s-2); background: var(--ag-panel); outline: none; color: var(--color-paper); font-family: var(--font-mono); font-size: var(--text-caption); resize: vertical; min-height: 44px; margin-bottom: 6px; }
.q textarea:focus { border-color: var(--color-ember-dim); }
.row { display: flex; gap: var(--s-2); justify-content: flex-end; }
.btn { border: 1px solid var(--ag-line-2); border-radius: var(--r-sm); background: var(--ag-surface); color: var(--color-fog); font-family: var(--font-mono); font-size: var(--text-caption); padding: 2px var(--s-2); min-height: 24px; cursor: pointer; }
.btn:hover { color: var(--color-paper); }
.primary { background: var(--color-ember); border-color: var(--color-ember); color: var(--color-paper); font-weight: var(--weight-bold); }
.primary:hover { background: var(--color-ember-dim); }

.kdoc { border: 1px solid var(--ag-line); border-radius: var(--r-sm); padding: var(--s-2) var(--s-3); background: var(--ag-surface); }
.kt { font-size: var(--text-body); color: var(--color-paper); margin-bottom: 2px; }
.kv { font-size: 10px; color: var(--color-steel); margin-bottom: var(--s-2); }
.kb { font-family: var(--font-mono); font-size: var(--text-caption); color: var(--color-fog); white-space: pre-wrap; max-height: 280px; overflow-y: auto; }
.rlabel { font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--color-steel); }
.arow { display: flex; align-items: center; gap: var(--s-2); border: 1px solid var(--ag-line); border-radius: var(--r-sm); padding: var(--s-2); background: var(--ag-surface); font-size: var(--text-caption); font-family: var(--font-mono); }
.arow .k { color: var(--color-steel); width: 110px; }
.arow .n { color: var(--color-fog); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.arow .v { margin-left: auto; color: var(--color-steel); font-size: 10px; }

.reopen { position: absolute; right: var(--s-3); top: var(--s-2); display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--color-ember-dim); border-radius: var(--r-sm); padding: 3px var(--s-2); background: var(--ag-surface); color: var(--color-ember); font-family: var(--font-mono); font-size: var(--text-caption); cursor: pointer; z-index: 5; }
.reopen .dot { width: 5px; height: 5px; border-radius: 50%; background: var(--color-ember); animation: agpulse 1.3s infinite; }
@keyframes agpulse { 50% { opacity: .3; } }
</style>
