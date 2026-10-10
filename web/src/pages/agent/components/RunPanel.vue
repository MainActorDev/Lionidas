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
      <span class="t ag-serif">{{ run ? run.run.id : 'run' }}</span>
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
              <span class="b">{{ s.status === 'running' ? '✦' : '' }}</span>
              <div class="meta"><div class="nm ag-mono">{{ s.id }}</div><div class="st">{{ s.status }}<span v-if="s.attempt > 1"> · try {{ s.attempt }}</span></div></div>
            </div>
            <div v-if="i < run.stages.length - 1" class="flink" :class="{ done: run.stages[i + 1]!.status !== 'pending' }"></div>
          </template>
          <div v-if="run.run.status === 'done'" class="alldone">✓ run complete</div>
          <div v-if="run.run.status === 'failed'" class="allfail">✕ run failed</div>
        </div>

        <div v-if="question" class="q">
          <div class="ql">✦ a question before I continue</div>
          <div v-for="q in question.question!.questions" :key="q.id" class="qt ag-serif">{{ q.text }}</div>
          <textarea v-for="q in question.question!.questions" :key="'a-' + q.id" v-model="answers[q.id]" class="ag-mono" placeholder="type your answer…"></textarea>
          <div class="row">
            <button class="btn" :disabled="working" @click="answer(true)">skip</button>
            <button class="btn primary" :disabled="working" @click="answer(false)">answer &amp; continue</button>
          </div>
        </div>
      </template>

      <template v-else>
        <div v-if="knowledge" class="kdoc">
          <div class="kt ag-serif">{{ knowledge.name }}</div>
          <div class="kv ag-mono">v{{ knowledge.version }}{{ knowledge.supersededBy ? ' · superseded' : ' · latest' }} · compounding</div>
          <pre class="kb">{{ knowledge.body.slice(0, 1200) }}</pre>
        </div>
        <div class="rlabel">artifacts</div>
        <div v-for="a in artifacts" :key="a.id" class="arow ag-mono">
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
.panel { width: 380px; flex: none; background: var(--ag-surface); border-left: 1px solid var(--ag-line); display: flex; flex-direction: column; min-height: 0; transition: width 240ms ease; overflow: hidden; }
.panel.closed { width: 0; border-left: none; }
.phead { display: flex; align-items: center; gap: 8px; padding: 14px 16px; border-bottom: 1px solid var(--ag-line); }
.phead .t { font-size: 17px; }
.ptabs { display: flex; gap: 4px; margin-left: auto; }
.ptab { border-radius: 999px; padding: 4px 12px; font-size: 11.5px; color: var(--ag-ink-3); cursor: pointer; }
.ptab.on { color: var(--ag-ember); background: rgba(224,106,53,.1); box-shadow: inset 0 0 0 1px rgba(224,106,53,.3); }
.x { width: 24px; height: 24px; border-radius: 50%; background: none; box-shadow: inset 0 0 0 1px var(--ag-line); color: var(--ag-ink-3); border: none; cursor: pointer; font-size: 10px; }
.x:hover { color: var(--ag-ember); }
.pbody { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 14px; }
.none { font-size: 13px; color: var(--ag-ink-3); padding: 18px 6px; text-align: center; }

.fnode { display: flex; align-items: center; gap: 12px; }
.fnode .b { width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; font-size: 11px; background: var(--ag-canvas); box-shadow: inset 0 0 0 1px var(--ag-line-2); flex: none; }
.fnode.done .b { color: var(--ag-ink); background: var(--ag-raise); }
.fnode.done .b::before { content: '✓'; font-size: 10px; }
.fnode.running .b { color: var(--ag-ink); background: radial-gradient(circle at 35% 30%, var(--ag-ember), var(--ag-ember-dim) 75%); box-shadow: 0 0 14px rgba(224,106,53,.55); animation: agpulse 1.3s infinite; }
.fnode .nm { font-size: 12.5px; color: var(--ag-ink); }
.fnode .st { font-size: 11px; color: var(--ag-ink-3); }
.fnode.done .st { color: var(--ag-ink-2); }
.flink { width: 1px; height: 16px; background: var(--ag-line); margin-left: 15px; }
.flink.done { background: var(--ag-line-2); }
.alldone { font-size: 12.5px; color: var(--ag-ink-2); margin-top: 8px; }
.allfail { font-size: 12.5px; color: var(--ag-ember); margin-top: 8px; }

.q { border-radius: 18px; padding: 15px 17px; background: linear-gradient(160deg, rgba(224,106,53,.12), rgba(224,106,53,.05)); box-shadow: inset 0 0 0 1px rgba(224,106,53,.35); }
.ql { font-size: 11px; letter-spacing: .14em; text-transform: uppercase; color: var(--ag-ember); margin-bottom: 7px; }
.qt { font-size: 15px; line-height: 1.55; margin-bottom: 8px; }
.q textarea { width: 100%; border-radius: 14px; padding: 9px 13px; background: #1d1b18; border: none; outline: none; box-shadow: inset 0 0 0 1px var(--ag-line); color: var(--ag-ink); font-family: var(--font-mono); font-size: 12.5px; resize: vertical; min-height: 44px; margin-bottom: 6px; }
.row { display: flex; gap: 9px; justify-content: flex-end; }
.btn { border-radius: 999px; background: none; box-shadow: inset 0 0 0 1px var(--ag-line-2); color: var(--ag-ink-2); font-family: var(--font-sans); font-size: 12.5px; padding: 5px 15px; cursor: pointer; border: none; }
.primary { background: var(--ag-ember); box-shadow: 0 4px 16px rgba(224,106,53,.35); color: var(--ag-ink); font-weight: 600; }

.kdoc { border-radius: 16px; padding: 13px 15px; background: var(--ag-canvas); box-shadow: inset 0 0 0 1px var(--ag-line); }
.kt { font-size: 15px; margin-bottom: 3px; }
.kv { font-size: 11px; color: var(--ag-ink-3); margin-bottom: 8px; }
.kb { font-family: var(--font-mono); font-size: 11.5px; color: var(--ag-ink-2); white-space: pre-wrap; max-height: 300px; overflow-y: auto; }
.rlabel { font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: var(--ag-ink-3); }
.arow { display: flex; align-items: center; gap: 10px; border-radius: 12px; padding: 7px 12px; background: var(--ag-canvas); box-shadow: inset 0 0 0 1px var(--ag-line); font-size: 12px; }
.arow .k { color: var(--ag-ink-3); width: 110px; }
.arow .n { color: var(--ag-ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.arow .v { margin-left: auto; color: var(--ag-ink-3); font-size: 11px; }

.reopen { position: absolute; right: 18px; top: 60px; display: inline-flex; align-items: center; gap: 8px; border-radius: 999px; padding: 8px 16px; background: #26231f; box-shadow: inset 0 0 0 1px rgba(224,106,53,.45), 0 8px 26px rgba(0,0,0,.55); color: var(--ag-ember); font-family: var(--font-mono); font-size: 11px; cursor: pointer; border: none; z-index: 5; }
.reopen .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ag-ember); animation: agpulse 1.3s infinite; }
@keyframes agpulse { 50% { opacity: .3; } }
</style>
