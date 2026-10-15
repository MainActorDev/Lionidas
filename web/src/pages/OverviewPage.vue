<script setup lang="ts">
/** Overview — the front door (014-C3 lineage). The build-level answer:
 *  verdict word + coverage strip + attention list + latest runs, one API
 *  call (/api/overview), live-updating as runs finish. Replaces the
 *  per-case card board (SuiteHomePage) — case-level truth lives in
 *  /templates; this page answers "is the build safe / what needs eyes". */
import PageHeader from '../components/PageHeader.vue';
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useLiveEvents } from '../stores/live.ts';

const router = useRouter();
const route = useRoute();
const live = useLiveEvents();

interface AttItem { kind: string; templateId: string; runId: string | null; variantId: string | null; status: string; appVersion: string | null; batchId: string; tag?: string; templateName?: string }
interface RunItem { runId: string; templateId: string; status: string; blocked: number; appVersion: string | null; variantId: string | null; batchId: string | null; startedAt: number; finishedAt: number | null; templateName?: string }
interface Overview {
  health: { status: string; passed: number; failed: number; blocked: number; running: number; passRate: number | null; delta: number | null; previousBatch: string | null; buildLabel: string | null; lastRunAt: number | null; lastSuccessfulAt: number | null };
  attention: AttItem[];
  coverage: { active: number; draft: number; deprecated: number; variants: number; executedInRange: number; notRunRecently: number };
  latestRuns: RunItem[];
}

const data = ref<Overview | null>(null);
const loading = ref(true);
const error = ref('');

async function load(): Promise<void> {
  try {
    const r = await fetch('/api/overview');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    data.value = (await r.json()) as Overview;
    error.value = '';
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

// legacy deep links: /?watch=<udid> belonged to the wall — forward it
onMounted(() => {
  if (typeof route.query.watch === 'string' && route.query.watch) {
    void router.replace({ path: '/devices', query: { watch: route.query.watch } });
    return;
  }
  live.connect();
  void load();
  void loadPlans();
});
onUnmounted(() => live.release());

// live: a finished/started run re-reads the board (RunsPage pattern)
const unwatch = watch(
  () => live.events.length,
  () => {
    const latest = live.events[live.events.length - 1];
    if (latest && (latest.type === 'run.finished' || latest.type === 'run.started')) void load();
  },
);

// ── plans (B4): remembered invocations stay one click from the front door ──
interface Plan { id: string; name: string }
const plans = ref<Plan[]>([]);
const runningPlan = ref<string | null>(null);
const msg = ref('');
async function loadPlans(): Promise<void> {
  try {
    const r = await fetch('/api/plans');
    plans.value = ((await r.json()) as { plans: Plan[] }).plans ?? [];
  } catch { /* plans optional */ }
}
async function runPlan(p: Plan): Promise<void> {
  if (runningPlan.value) return;
  runningPlan.value = p.id;
  try {
    const r = await fetch(`/api/plans/${p.id}/run`, { method: 'POST' });
    const b = (await r.json()) as { count?: number; error?: string };
    msg.value = b.error ? b.error : `plan ${p.name}: running ${b.count ?? 0} case(s)`;
    void load();
  } catch { msg.value = 'plan run failed'; }
  finally { runningPlan.value = null; }
}

const runningSuite = ref(false);
async function runAll(): Promise<void> {
  if (runningSuite.value) return;
  runningSuite.value = true;
  msg.value = '';
  try {
    const r = await fetch('/api/templates/play-all', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
    const b = (await r.json()) as { runIds?: string[]; count?: number; batchId?: string; error?: string };
    msg.value = b.error ? b.error : `running ${b.count ?? 0} case(s) — verdicts update live`;
  } catch { msg.value = 'failed to start the batch'; }
  finally { runningSuite.value = false; }
}

// ── derived display state ──
const h = computed(() => data.value?.health);
const verdictWord = computed(() => h.value?.status ?? '—');
const verdictSub = computed((): string => {
  if (!h.value) return '';
  const bits: string[] = [];
  if (h.value.running > 0) bits.push(`${h.value.running} running`);
  if (h.value.failed > 0) bits.push(`${h.value.failed} failed`);
  if (h.value.blocked > 0) bits.push(`${h.value.blocked} blocked`);
  bits.push(h.value.passRate === null ? 'no pass rate' : `pass rate ${Math.round(h.value.passRate * 100)}%`);
  if (h.value.delta !== null) bits.push(`delta ${h.value.delta >= 0 ? '+' : ''}${Math.round(h.value.delta * 100)}%`);
  bits.push(h.value.previousBatch ? `vs ${h.value.previousBatch}` : 'no comparable build');
  return bits.join(' · ');
});
const batchLabel = computed((): string => {
  if (!data.value) return '';
  const b = data.value.health.buildLabel;
  const att = data.value.latestRuns.find((r) => r.batchId)?.batchId ?? null;
  const scope = b && b !== 'mixed builds' && b !== 'unknown build' ? b : (b ?? '');
  return [att, scope, '7d'].filter(Boolean).join(' · ');
});
const attCount = computed(() => data.value?.attention.length ?? 0);
// latest runs: 5 rows is a glance, more is a log — full depth lives on the runs page
const latestTop = computed(() => (data.value?.latestRuns ?? []).slice(0, 5));

const kindLabel: Record<string, string> = { new_failure: 'new', infra_blocked: 'infra', repeated_failure: 'recurring', stale_case: 'stale' };
function kindOf(a: AttItem): string { return kindLabel[a.kind] ?? a.kind; }
function nameOf(t: { templateId: string; templateName?: string }): string { return t.templateName ?? t.templateId; }
function attLabel(a: AttItem): string { return a.tag === 'no_baseline' ? 'no_baseline' : (a.runId ? `${a.runId} →` : a.tag ?? ''); }
function openAtt(a: AttItem): void {
  if (a.runId) void router.push(`/runs/${a.runId}`);
  else void router.push(`/templates`);
}
function openRun(r: RunItem): void { void router.push(`/runs/${r.runId}`); }
function runStatusClass(r: RunItem): string {
  if (r.status === 'failed') return 'failed';
  if (r.status === 'passed') return 'passed';
  if (r.status === 'aborted') return 'aborted';
  return r.status;
}
function timeAgo(ms: number | null): string {
  if (!ms) return '';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
</script>

<template>
  <section class="page">
    <PageHeader title="overview">
      <span class="ph-desc">{{ batchLabel }}</span>
      <template #actions>
        <button class="btn" :disabled="runningSuite" @click="runAll" title="run every active case sequentially — verdicts update live">
          {{ runningSuite ? 'starting…' : '▶ run all cases' }}
        </button>
        <RouterLink class="btn btn-ghost" to="/templates" title="the full case table — edit, tags, steps">all cases →</RouterLink>
      </template>
    </PageHeader>

    <div v-if="plans.length > 0" class="ov-plans">
      <span v-for="p in plans" :key="p.id" class="chip">
        <button class="chip-click" :disabled="runningPlan !== null" @click="runPlan(p)">{{ runningPlan === p.id ? 'running…' : `▶ ${p.name}` }}</button>
      </span>
      <span v-if="msg" class="ov-msg">{{ msg }}</span>
    </div>

    <div v-if="loading" class="empty">loading…</div>
    <div v-else-if="error" class="empty" style="color: var(--color-ember);">{{ error }}</div>

    <template v-else-if="data">
      <!-- ═══ verdict band (041-A: /status grammar — word + dot + mono sub-line) ═══ -->
      <div class="ov-band">
        <span class="ov-overall"><i class="ov-dot" :class="verdictWord" aria-hidden="true"></i><span class="ov-word" :class="`ov-w-${verdictWord}`">{{ verdictWord }}</span></span>
        <span class="ov-summary">{{ verdictSub }}</span>
        <span v-if="attCount" class="ov-stamp">{{ attCount }} attention</span>
      </div>

      <!-- ═══ coverage strip (041-A: mono numbers over caption labels) ═══ -->
      <div class="ov-strip">
        <div class="seg"><b>{{ h?.passed ?? 0 }}</b><span>passed</span></div>
        <div class="seg" :class="{ alert: (h?.failed ?? 0) > 0 }"><b>{{ h?.failed ?? 0 }}</b><span>failed</span></div>
        <div class="seg"><b>{{ h?.blocked ?? 0 }}</b><span>blocked</span></div>
        <div class="seg"><b>{{ data.coverage.active }}</b><span>active cases</span></div>
        <div class="seg"><b>{{ data.coverage.variants }}</b><span>variants</span></div>
        <div class="seg" :class="{ alert: data.coverage.notRunRecently > 0 }"><b>{{ data.coverage.notRunRecently }}</b><span>not run 7d</span></div>
      </div>

      <div class="ov-below">
        <!-- ═══ attention (041-A: audit-row grammar) ═══ -->
        <div>
          <div class="ov-label">requires attention</div>
          <div class="ov-list">
            <div v-if="attCount === 0" class="ov-none">nothing needs eyes — all quiet in the last batch</div>
            <div v-for="a in data.attention" :key="`${a.kind}-${a.templateId}`" class="ov-att-row" role="link" tabindex="0" @click="openAtt(a)" @keydown.enter.prevent="openAtt(a)" :title="a.runId ? 'open the run' : 'open the case table'">
              <span class="ov-kind" :class="a.kind">{{ kindOf(a) }}</span>
              <span class="ov-name">{{ nameOf(a) }}</span>
              <span class="ov-meta">{{ attLabel(a) }}</span>
            </div>
          </div>
        </div>

        <!-- ═══ latest runs (041-A: hairline rows, 5 max) ═══ -->
        <div>
          <div class="ov-label">latest runs →</div>
          <div class="ov-list">
            <div v-for="r in latestTop" :key="r.runId" class="ov-run-row" role="link" tabindex="0" @click="openRun(r)" @keydown.enter.prevent="openRun(r)" title="open the run">
              <span class="ov-rname">{{ nameOf(r) }}{{ r.variantId ? ` / ${r.variantId}` : '' }}</span>
              <span class="ov-rtime">{{ timeAgo(r.startedAt) }}</span>
              <span class="ov-state" :class="runStatusClass(r)">{{ r.status }}</span>
            </div>
          </div>
        </div>
      </div>
      <div v-if="msg && !plans.length" class="ov-msg" style="margin-top: var(--s-3);">{{ msg }}</div>
    </template>
  </section>
</template>

<style scoped>
/* 041-A band verdict — Factory migrated-page grammar (sketch a-band-verdict).
 *  Layout only — chrome from theme tokens; colors via theme vars (no hexes). */

.ov-plans { display: flex; align-items: center; gap: var(--s-2); flex-wrap: wrap; margin: var(--s-3) 0 0; }
.ov-plans .chip { border: 1px solid var(--color-iron); border-radius: 3px; padding: 4px 10px; font: 11px var(--font-mono); color: var(--color-ash); }
.ov-plans .chip:hover { border-color: var(--color-ash); color: var(--color-paper); }
.ov-msg { font-size: var(--text-caption); color: var(--color-ash); }

/* ── verdict band (/status grammar: word + dot + mono sub-line + stamp) ── */
.ov-band { display: flex; align-items: center; gap: 12px; padding: 17px 0 15px; border-bottom: 1px solid var(--color-iron); flex-wrap: wrap; margin-top: var(--s-5); }
.ov-overall { display: inline-flex; align-items: center; gap: 8px; font-family: var(--font-mono); font-size: 17px; font-weight: 500; }
.ov-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--color-steel); }
.ov-dot.failed { background: var(--status-orange); }
.ov-dot.running { background: var(--status-orange); }
.ov-word { letter-spacing: -0.01em; color: var(--color-paper); }
.ov-w-running { color: var(--color-ember); }
.ov-w-no_data { color: var(--color-steel); }
.ov-summary { font-family: var(--font-mono); font-size: 12px; color: var(--color-ash); }
.ov-stamp { font-family: var(--font-mono); font-size: 11px; color: var(--color-steel); margin-left: auto; }

/* ── coverage strip (mono numbers over caption labels) ── */
.ov-strip { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); border: 1px solid var(--color-iron); border-radius: var(--r); overflow: hidden; margin-top: var(--s-5); }
.ov-strip .seg { padding: 12px 16px; border-right: 1px solid var(--color-iron); min-width: 0; }
.ov-strip .seg:last-child { border-right: 0; }
.ov-strip b { display: block; font-family: var(--font-mono); font-size: 24px; font-weight: 500; line-height: 1.2; }
.ov-strip span { font-family: var(--font-mono); color: var(--color-steel); font-size: 11px; }
.ov-strip .alert b { color: var(--color-ember); }

/* ── two-below: hairline row lists (audit-row grammar) ── */
.ov-below { margin-top: var(--s-5); display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: var(--s-4); align-items: start; }
.ov-label { font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--color-steel); margin: 0 0 9px; }
.ov-list { border: 1px solid var(--color-iron); min-width: 0; padding: 0; }

.ov-att-row { display: grid; grid-template-columns: 76px minmax(0, 1fr) auto; gap: 12px; align-items: baseline; padding: 10px 14px; border-bottom: 1px solid var(--color-iron); cursor: pointer; font-family: var(--font-mono); font-size: 12px; }
.ov-att-row:last-child { border-bottom: 0; }
.ov-att-row:hover { background: var(--color-carbon); }
.ov-att-row:focus-visible { outline: 2px solid var(--ring); outline-offset: -2px; }
.ov-kind { color: var(--color-steel); }
.ov-kind.new_failure { color: var(--color-ember); }
.ov-kind.infra_blocked { color: var(--color-fog); }
.ov-name { color: var(--color-paper); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ov-meta { color: var(--color-steel); font-size: 11px; }
.ov-none { padding: var(--s-4); color: var(--color-ash); font-size: var(--text-label); }

.ov-run-row { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 12px; align-items: baseline; padding: 10px 14px; border-bottom: 1px solid var(--color-iron); cursor: pointer; font-family: var(--font-mono); font-size: 12px; }
.ov-run-row:last-child { border-bottom: 0; }
.ov-run-row:hover { background: var(--color-carbon); }
.ov-run-row:focus-visible { outline: 2px solid var(--ring); outline-offset: -2px; }
.ov-rname { color: var(--color-fog); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ov-rtime { color: var(--color-steel); font-size: 11px; }
.ov-state { font-size: 11px; color: var(--color-steel); }
.ov-state.failed { color: var(--status-orange); }
.ov-state.passed { color: var(--status-green); }
.ov-state.running { color: var(--status-orange); }
.ov-state.aborted { color: var(--color-ash); }

@media (max-width: 900px) {
  .ov-below { grid-template-columns: minmax(0, 1fr); }
  .ov-strip { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .ov-strip .seg:nth-child(3) { border-right: 0; }
  .ov-strip .seg:nth-child(-n+3) { border-bottom: 1px solid var(--color-iron); }
}
@media (max-width: 760px) {
  .ov-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .ov-strip .seg:nth-child(3) { border-right: 1px solid var(--color-iron); }
  .ov-strip .seg:nth-child(2n) { border-right: 0; }
  .ov-att-row { grid-template-columns: 64px minmax(0, 1fr) auto; }
  .ov-stamp { flex-basis: 100%; margin: 0; }
}
</style>
