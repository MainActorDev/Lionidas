<script setup lang="ts">
/** Overview — the front door. Answers "is the app OK?" in one screen:
 *  every case's latest verdict, attention-first ordering, run-all-cases
 *  and plans one click away, live-updating as runs finish. */
import { ref, onMounted, onUnmounted, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useSuite, verdictKind, verdictStatusClass, verdictLabel } from '../composables/suite.ts';
import { useLiveEvents } from '../stores/live.ts';

const router = useRouter();
const route = useRoute();
const live = useLiveEvents();
const { cases, plans, loading, error, summary, attentionOrder, load } = useSuite();

// legacy deep links: /?watch=<udid> belonged to the wall — forward it
onMounted(() => {
  if (typeof route.query.watch === 'string' && route.query.watch) {
    void router.replace({ path: '/devices', query: { watch: route.query.watch } });
    return;
  }
  live.connect();
  void load();
});
onUnmounted(() => live.release());

// live verdicts: a finished run re-reads the board (RunsPage pattern)
const unwatch = watch(
  () => live.events.length,
  () => {
    const latest = live.events[live.events.length - 1];
    if (latest && latest.type === 'run.finished') void load();
  },
);

const runningSuite = ref(false);
const suiteMsg = ref('');
async function runSuite(): Promise<void> {
  if (runningSuite.value) return;
  runningSuite.value = true;
  suiteMsg.value = '';
  try {
    const r = await fetch('/api/templates/play-all', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
    const b = (await r.json()) as { runIds?: string[]; count?: number; error?: string };
    suiteMsg.value = b.error ? b.error : `running ${b.count ?? 0} case(s) — verdicts update live`;
  } catch { suiteMsg.value = 'failed to start the suite'; }
  finally { runningSuite.value = false; }
}

const runningPlan = ref<string | null>(null);
async function runPlan(p: { id: string; name: string }): Promise<void> {
  if (runningPlan.value) return;
  runningPlan.value = p.id;
  try {
    const r = await fetch(`/api/plans/${p.id}/run`, { method: 'POST' });
    const b = (await r.json()) as { count?: number; error?: string };
    suiteMsg.value = b.error ? b.error : `plan ${p.name}: running ${b.count ?? 0} case(s)`;
    void load();
  } catch { suiteMsg.value = 'plan run failed'; }
  finally { runningPlan.value = null; }
}

function openCase(c: { verdict: { lastRunId: string | null } | null; id: string }): void {
  if (c.verdict?.lastRunId) void router.push(`/runs/${c.verdict.lastRunId}`);
  else void router.push('/templates');
}
</script>

<template>
  <section class="page">
    <header class="sh-head">
      <div class="sh-title-group">
        <h1>overview</h1>
        <p class="sh-sub">every case's latest verdict — click a card to open its last run</p>
        <span class="stat-summary" :title="`${summary.green} pass · ${summary.red} fail · ${summary.blocked} blocked · ${summary.never} never run`">
          <span class="n">{{ summary.total }}</span> {{ summary.total === 1 ? 'case' : 'cases' }}
          <span class="sym" title="passing">passing {{ summary.green }}</span>
          <span v-if="summary.red" class="sym" title="failing">failing {{ summary.red }}</span>
          <span v-if="summary.blocked" class="sym" title="blocked (infrastructure failed, not the app)">blocked {{ summary.blocked }}</span>
          <span v-if="summary.never" class="sym" title="never run">never run {{ summary.never }}</span>
        </span>
      </div>
      <div class="sh-actions">
        <button class="btn" :disabled="runningSuite || cases.length === 0" @click="runSuite" title="run every case sequentially — verdicts update live">
          {{ runningSuite ? 'starting…' : '▶ run all cases' }}
        </button>
        <RouterLink class="btn btn-ghost" to="/templates" title="the full case table — edit, tags, steps">all cases →</RouterLink>
      </div>
    </header>

    <div v-if="plans.length > 0" class="sh-plans">
      <span v-for="p in plans" :key="p.id" class="chip">
        <button class="chip-click" :disabled="runningPlan !== null" @click="runPlan(p)">{{ runningPlan === p.id ? 'running…' : `▶ ${p.name}` }}</button>
      </span>
      <span v-if="suiteMsg" class="sh-msg">{{ suiteMsg }}</span>
    </div>

    <div v-if="loading" class="empty">loading…</div>
    <div v-else-if="error" class="empty" style="color: var(--color-ember);">{{ error }}</div>

    <div v-else-if="cases.length === 0" class="empty sh-empty">
      <div class="sh-empty-title">the suite is empty — record the first case</div>
      <div class="hint-bar sh-empty-journey">
        <span class="h-step">record <span>▸ devices</span></span>
        <span class="h-arrow">→</span>
        <span class="h-step">assert <span>▸ recorder</span></span>
        <span class="h-arrow">→</span>
        <span class="h-step">save <span>▸ sidebar</span></span>
        <span class="h-arrow">→</span>
        <span class="h-step">run <span>▶ here</span></span>
      </div>
      <RouterLink class="btn" to="/devices" style="margin-top: var(--s-4);">go to devices →</RouterLink>
    </div>

    <div v-else class="sh-board">
      <article
        v-for="c in attentionOrder" :key="c.id"
        class="sh-card" :class="`sh-${verdictKind(c)}`"
        @click="openCase(c)"
        :title="c.verdict?.lastRunId ? 'open the last run' : 'never run — open the case table'"
      >
        <div class="sh-card-main">
          <span class="sh-name">{{ c.name }}</span>
          <span v-if="c.appName ?? c.appBundleId" class="sh-app">{{ c.appName ?? c.appBundleId }}</span>
        </div>
        <span :class="`status ${verdictStatusClass(c)}`">{{ verdictLabel(c) }}</span>
      </article>
    </div>
    <div v-if="cases.length > 0 && suiteMsg" class="sh-msg" style="margin-top: var(--s-3);">{{ suiteMsg }}</div>
  </section>
</template>

<style scoped>
.sh-head { display: flex; align-items: center; justify-content: space-between; gap: var(--s-4); margin-bottom: var(--s-4); }
.sh-title-group { display: flex; align-items: baseline; gap: var(--s-4); }
.sh-head h1 { font-size: var(--text-heading); font-weight: var(--weight-bold); margin: 0; }
.sh-sub { margin: 2px 0 0; font-size: var(--text-caption); color: var(--color-ash); }
.sh-title-group { flex-direction: column; align-items: flex-start; gap: 0; }
.sh-actions { display: flex; gap: var(--s-2); }

.sh-plans { display: flex; align-items: center; gap: var(--s-2); flex-wrap: wrap; margin-bottom: var(--s-3); }
.sh-msg { font-size: var(--text-caption); color: var(--color-ash); }

.sh-board { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: var(--s-3); }
.sh-card {
  display: flex; align-items: center; gap: var(--s-3);
  border: 1px solid var(--color-iron); border-left: 2px solid var(--color-slate);
  border-radius: var(--r-sm); background: var(--color-carbon);
  padding: var(--s-3) var(--s-4); cursor: pointer; min-height: 52px;
  transition: background var(--t);
}
.sh-card:hover { background: var(--color-graphite); }
.sh-card.sh-red { border-left-color: var(--color-paper); }
.sh-card.sh-blocked { border-left-style: dashed; }
.sh-card.sh-green { border-left-color: var(--color-slate); }
.sh-card-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.sh-name { font-weight: var(--weight-bold); font-size: var(--text-label); color: var(--color-paper); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sh-app { font-size: var(--text-caption); color: var(--color-ash); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.sh-empty { padding: var(--s-7); }
.sh-empty-title { color: var(--color-fog); font-size: var(--text-body); margin-bottom: var(--s-4); }
.sh-empty-journey { border-bottom: none; justify-content: center; margin-bottom: 0; }
</style>
