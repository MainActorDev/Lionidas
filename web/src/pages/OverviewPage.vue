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
// latest runs: 8 rows is a glance, 20 is a log — full depth lives on the runs page
const latestTop = computed(() => (data.value?.latestRuns ?? []).slice(0, 8));

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
      <!-- ═══ verdict (C3: title parity above; the answer is THE big element) ═══ -->
      <div class="ov-verdict" :class="`ov-${verdictWord}`">
        <span class="ov-word">{{ verdictWord }}</span>
        <span class="ov-sub">{{ verdictSub }}</span>
        <span class="ov-flex"></span>
        <span class="ov-sub ov-dim" v-if="attCount">{{ attCount }} attention</span>
      </div>

      <!-- ═══ coverage strip ═══ -->
      <div class="ov-strip">
        <div class="seg"><b>{{ h?.passed ?? 0 }}</b><span>passed</span></div>
        <div class="seg" :class="{ alert: (h?.failed ?? 0) > 0 }"><b>{{ h?.failed ?? 0 }}</b><span>failed</span></div>
        <div class="seg"><b>{{ h?.blocked ?? 0 }}</b><span>blocked</span></div>
        <div class="seg"><b>{{ data.coverage.active }}</b><span>active cases</span></div>
        <div class="seg"><b>{{ data.coverage.variants }}</b><span>variants</span></div>
        <div class="seg" :class="{ alert: data.coverage.notRunRecently > 0 }"><b>{{ data.coverage.notRunRecently }}</b><span>not run 7d</span></div>
      </div>

      <div class="ov-below">
        <!-- ═══ attention ═══ -->
        <div>
          <div class="section-label">requires attention</div>
          <div class="card ov-att">
            <div v-if="attCount === 0" class="ov-none">nothing needs eyes — all quiet in the last batch</div>
            <div v-for="a in data.attention" :key="`${a.kind}-${a.templateId}`" class="att-row" @click="openAtt(a)" :title="a.runId ? 'open the run' : 'open the case table'">
              <span class="kind" :class="a.kind">{{ kindOf(a) }}</span>
              <span class="case-name">{{ nameOf(a) }}</span>
              <span class="tag">{{ attLabel(a) }}</span>
            </div>
          </div>
        </div>

        <!-- ═══ latest runs ═══ -->
        <div>
          <div class="section-label">latest runs →</div>
          <div class="card ov-latest">
            <div v-for="r in latestTop" :key="r.runId" class="run-row" @click="openRun(r)" title="open the run">
              <span class="run-name">{{ nameOf(r) }}{{ r.variantId ? ` / ${r.variantId}` : '' }}</span>
              <span class="run-time">{{ timeAgo(r.startedAt) }}</span>
              <span class="status" :class="runStatusClass(r)">{{ r.status }}</span>
            </div>
          </div>
        </div>
      </div>
      <div v-if="msg && !plans.length" class="ov-msg" style="margin-top: var(--s-3);">{{ msg }}</div>
    </template>
  </section>
</template>

<style scoped>

.ov-plans { display: flex; align-items: center; gap: var(--s-2); flex-wrap: wrap; margin: var(--s-3) 0 0; }
.ov-msg { font-size: var(--text-caption); color: var(--color-ash); }

/* ── verdict: 48px of air under the title row, then THE answer ── */
.ov-verdict { margin-top: var(--s-7); display: flex; align-items: baseline; gap: var(--s-4); padding-bottom: var(--s-4); border-bottom: 1px solid var(--color-iron); }
.ov-word { font-size: var(--text-display); font-weight: var(--weight-bold); letter-spacing: -0.01em; line-height: var(--leading-tight); }
.ov-sub { color: var(--color-ash); font-size: var(--text-label); }
.ov-dim { color: var(--color-steel); }
.ov-flex { flex: 1; }
.ov-failed .ov-word { color: var(--color-paper); }
.ov-running .ov-word { color: var(--color-ember); }
.ov-no_data .ov-word { color: var(--color-steel); }

/* ── coverage strip ── */
.ov-strip { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); border: 1px solid var(--color-iron); border-radius: var(--r); overflow: hidden; margin-top: var(--s-5); }
.ov-strip .seg { padding: var(--s-3) var(--s-4); border-right: 1px solid var(--color-iron); min-width: 0; }
.ov-strip .seg:last-child { border-right: 0; }
.ov-strip b { display: block; font-size: var(--text-heading-sm); font-weight: var(--weight-bold); }
.ov-strip span { color: var(--color-steel); font-size: var(--text-caption); }
.ov-strip .alert b { color: var(--color-ember); }

/* ── two-below ── */
/* the global .section-label:first-child reset zeroes the label's top margin —
   the wrapper owns the gap here, not the label (0px glue under the strip) */
.ov-below { margin-top: var(--s-5); display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: var(--s-4); align-items: start; }
.ov-att, .ov-latest { padding: 0; overflow: hidden; }

.att-row { display: grid; grid-template-columns: 84px minmax(0, 1fr) auto; gap: var(--s-3); align-items: baseline; padding: var(--s-2) var(--s-3); border-bottom: 1px solid var(--color-iron); cursor: pointer; }
.att-row:last-child { border-bottom: 0; }
.att-row:hover { background: var(--color-graphite); }
.kind { font-size: var(--text-caption); color: var(--color-steel); }
.kind.new_failure { color: var(--color-ember); }
.kind.infra_blocked { color: var(--color-fog); }
.case-name { color: var(--color-paper); font-size: var(--text-label); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tag { color: var(--color-steel); font-size: var(--text-caption); }
.ov-none { padding: var(--s-4); color: var(--color-ash); font-size: var(--text-label); }

.run-row { display: flex; gap: var(--s-3); align-items: baseline; padding: var(--s-2) var(--s-3); border-bottom: 1px solid var(--color-iron); cursor: pointer; font-size: var(--text-label); }
.run-row:last-child { border-bottom: 0; }
.run-row:hover { background: var(--color-graphite); }
.run-name { color: var(--color-fog); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.run-time { margin-left: auto; color: var(--color-steel); font-size: var(--text-caption); flex: 0 0 auto; }
.status.failed { color: var(--color-paper); font-weight: var(--weight-bold); }
.status.passed { color: var(--color-fog); }
.status.aborted { color: var(--color-ash); }
.status.running { color: var(--color-ember); }
</style>
