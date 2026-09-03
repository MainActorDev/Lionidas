<script setup lang="ts">
/** Test cases — the A2 design, natively: a viewport-locked column of
 *  header / case table (own scroll) / yaml panel. The minimal header is not
 *  a "locked variant" — it IS the page chrome (mockup: a2-split-panel-scroll).
 *  The advanced run controls (network scenario, env, plans) live in a
 *  disclosure row that collapses away while editing yaml.
 *  Everything from the old page is ported: verdicts/trends, play/playAll,
 *  plans, rename/edit/delete, step expander (param/optional, + subflow,
 *  + assert), tag-filter chips, suite summary. */
import { ref, onMounted, onBeforeUnmount, computed, watch } from 'vue';
import CaseEditorPanel from '../components/CaseEditorPanel.vue';
import RunPanel from '../components/RunPanel.vue';

interface Step { idx: number; action: string; x?: number; y?: number; direction?: string; text?: string; optional?: boolean; selector?: { identifier?: string; label?: string; type?: string }; templateId?: string }
interface Verdict {
  lastRunId: string | null; lastStatus: string | null; lastBlocked: number;
  lastFinishedAt: number | null; lastAppVersion: string | null;
  trend: string | null; totalRuns: number;
}
interface Template {
  id: string; name: string; description: string | null; ticketKey: string | null;
  udid: string; logicalW: number | null; logicalH: number | null;
  steps: Step[]; defaultPresetId: string | null;
  appBundleId: string | null; appName: string | null; appVersion: string | null;
  tags: string[]; verdict: Verdict | null;
  createdBy: string; createdAt: number; updatedAt: number;
}
interface Plan { id: string; name: string; tags: string[]; udid: string | null; appBundleId: string | null; scenarioId: string | null; env: Record<string, string> }

const templates = ref<Template[]>([]);
const loading = ref(true);
const error = ref('');
const filter = ref('');
const filterEl = ref<HTMLInputElement | null>(null);
const playing = ref<string | null>(null);
const playMsg = ref('');
const playingAll = ref(false);
// network choice (phase 4): scenarios group presets; the selector applies to
// every run started while set — presets active for the run's duration only
const scenarios = ref<Array<{ id: string; name: string }>>([]);
const runScenario = ref<string>('');

/** env map for plays: KEY=value lines. Prompted once, reused for every play
 *  until cleared — the Maestro envFile equivalent. */
const envText = ref('');
const envOpen = ref(false); // collapsed until asked — env is an advanced control
function parseEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of envText.value.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) {
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1);
      if (k) out[k] = v;
    }
  }
  return out;
}
const envKeyCount = computed(() => Object.keys(parseEnv()).length);

async function play(t: Template): Promise<void> {
  if (playing.value) return;
  playing.value = t.id;
  playMsg.value = '';
  try {
    const env = parseEnv();
    const r = await fetch(`/api/templates/${t.id}/play`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...(runScenario.value ? { scenarioId: runScenario.value } : {}),
        ...(Object.keys(env).length ? { env } : {}),
      }),
    });
    const b = (await r.json()) as { runId?: string; error?: string };
    if (b.runId) {
      playMsg.value = `running · ${b.runId}${runScenario.value ? ' · scenario active' : ''}`;
      runPanel.value = { runId: b.runId, templateId: t.id, caseName: t.name, udid: t.udid };
    } else {
      playMsg.value = b.error ?? 'failed';
    }
  } catch {
    playMsg.value = 'failed';
  } finally { playing.value = null; }
}

// ── run companion panel (R1 observer dock) ──
const runPanel = ref<{ runId: string; templateId: string; caseName: string; udid: string } | null>(null);
/** adopt a run already live on this page's device set — reload mid-run,
 *  play from another tab, run started via plan/prompt. The panel hydrates
 *  itself from GET /api/runs/:id/steps, so no template steps needed. */
async function adoptRunningRun(): Promise<void> {
  if (runPanel.value) return;
  try {
    const r = await fetch('/api/runs?limit=200');
    const b = (await r.json()) as { runs?: Array<{ id: string; status: string; template_id: string | null; device_udid: string; note: string | null }> };
    const liveRun = (b.runs ?? []).find((x) => x.status === 'running' && templates.value.some((t) => t.id === x.template_id));
    if (liveRun) {
      const t = templates.value.find((x) => x.id === liveRun.template_id)!;
      runPanel.value = { runId: liveRun.id, templateId: t.id, caseName: t.name, udid: liveRun.device_udid };
    }
  } catch { /* adopt best-effort */ }
}

async function playAll(): Promise<void> {
  if (playingAll.value) return;
  // use the visible (filtered) set's tags — play what you see
  const visible = shown();
  const tagSet = [...new Set(visible.flatMap((t) => t.tags ?? []))];
  const tags = tagSet.length ? window.prompt(`play all ${visible.length} templates — restrict to tags (comma list, empty = all visible):`, tagSet.join(',')) ?? '' : '';
  if (tags === null) return;
  playingAll.value = true;
  playMsg.value = `playing ${visible.length} templates…`;
  try {
    const env = parseEnv();
    const r = await fetch('/api/templates/play-all', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tags,
        ...(runScenario.value ? { scenarioId: runScenario.value } : {}),
        ...(Object.keys(env).length ? { env } : {}),
      }),
    });
    const b = (await r.json()) as { runIds?: string[]; count?: number; error?: string };
    playMsg.value = b.runIds ? `queued ${b.count} runs · ${b.runIds.join(' ')}` : (b.error ?? 'failed');
  } catch {
    playMsg.value = 'failed';
  } finally { playingAll.value = false; }
}

async function patchTemplate(id: string, body: Record<string, unknown>): Promise<void> {
  await fetch(`/api/templates/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await load();
}

async function editTags(t: Template): Promise<void> {
  const raw = window.prompt('tags (comma list, max 8):', (t.tags ?? []).join(','));
  if (raw === null) return;
  const tags = raw.split(',').map((x) => x.trim()).filter(Boolean);
  await patchTemplate(t.id, { tags });
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const r = await fetch('/api/templates');
    const b = (await r.json()) as { templates?: Template[] };
    templates.value = b.templates ?? [];
    error.value = '';
  } catch {
    error.value = 'failed to load templates';
  } finally { loading.value = false; }
  try {
    const r = await fetch('/api/forge/scenarios');
    const b = (await r.json()) as { scenarios?: Array<{ id: string; name: string }> };
    scenarios.value = b.scenarios ?? [];
  } catch { /* scenarios optional — runs go without network config */ }
}

async function remove(id: string): Promise<void> {
  if (!confirm('delete this template?')) return;
  await fetch(`/api/templates/${id}`, { method: 'DELETE' });
  await load();
}

/** A2 plan: '+ case (yaml)' — hand-author a new case: create the shell row,
 *  then open it in the yaml panel (the editor IS the authoring surface). */
async function createCaseYaml(): Promise<void> {
  const res = await fetch('/api/templates', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: `untitled case ${Date.now().toString(36).slice(-4)}`, steps: [{ idx: 0, action: 'scroll', direction: 'down' }] }),
  });
  if (!res.ok) { error.value = 'create failed'; return; }
  const t = (await res.json()) as Template;
  await load();
  yamlOpenId.value = t.id;
}

const shown = (): Template[] => {
  const f = filter.value.trim().toLowerCase();
  if (!f) return templates.value;
  return templates.value.filter((t) =>
    t.name.toLowerCase().includes(f) || (t.ticketKey ?? '').toLowerCase().includes(f) || (t.tags ?? []).some((tg) => tg.toLowerCase().includes(f)));
};

// ── A2 yaml split panel: the page's native editing surface ──
const yamlOpenId = ref<string | null>(null);
const yamlPosition = computed(() => {
  if (!yamlOpenId.value) return { pos: 1, total: 1 };
  const list = shown();
  const i = list.findIndex((t) => t.id === yamlOpenId.value);
  return { pos: i >= 0 ? i + 1 : 1, total: list.length };
});
/** ONE editor at a time, with a save/abort guard: switching (or hopping)
 *  away from dirty edits asks first — save keeps them, abort drops them. */
const yamlPanelEl = ref<InstanceType<typeof CaseEditorPanel> | Array<InstanceType<typeof CaseEditorPanel>> | null>(null);
function panel(): InstanceType<typeof CaseEditorPanel> | null {
  // template refs inside v-for arrive as ARRAYS — normalize (the setCanvas lesson)
  const el = yamlPanelEl.value;
  return Array.isArray(el) ? (el[0] ?? null) : (el ?? null);
}
const pendingSwitch = ref<string | null>(null); // case awaiting the decision
function openYaml(t: Template): void {
  if (yamlOpenId.value === t.id) { yamlOpenId.value = null; return; } // toggle
  if (yamlOpenId.value !== null && panel()?.isDirty()) {
    pendingSwitch.value = t.id;
    return;
  }
  yamlOpenId.value = t.id;
}
async function resolveSwitch(save: boolean): Promise<void> {
  const target = pendingSwitch.value;
  pendingSwitch.value = null;
  if (!target) return;
  if (save) await panel()?.saveNow();
  yamlOpenId.value = target;
}
function hopYaml(dir: -1 | 1): void {
  const list = shown();
  const i = list.findIndex((t) => t.id === yamlOpenId.value);
  if (i < 0) return;
  const next = list[i + dir];
  if (next) openYaml(next); // same dirty guard as clicking a row
}
const yamlCase = computed(() => (yamlOpenId.value ? shown().find((t) => t.id === yamlOpenId.value) ?? null : null));
const tagCount = computed(() => new Set(templates.value.flatMap((t) => t.tags ?? [])).size);
/** the A2 editing state — drives header chrome swap + table share */
const editing = computed(() => yamlOpenId.value !== null);

// A2: ⌘F jumps to the case filter (search-to-jump)
function onCmdF(ev: KeyboardEvent): void {
  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'f' && yamlOpenId.value !== null) {
    ev.preventDefault();
    filterEl.value?.focus();
  }
}
onMounted(() => window.addEventListener('keydown', onCmdF));
onBeforeUnmount(() => { window.removeEventListener('keydown', onCmdF); });

onMounted(() => { void load().then(() => void adoptRunningRun()); void loadPlans(); });

// ── B4: verdict + trend rendering ──
type VerdictKind = 'never' | 'green' | 'red' | 'blocked' | 'aborted';
function verdictKind(t: Template): VerdictKind {
  const v = t.verdict;
  if (!v || v.lastStatus === null) return 'never';
  if (v.lastStatus === 'passed') return 'green';
  if (v.lastStatus === 'aborted') return 'aborted';
  return v.lastBlocked === 1 ? 'blocked' : 'red';
}
/** verdict → existing .status-* system class (symbols carry status per Axiom:
 *  ✓ pass · ✕ fail · ◆ blocked (dashed) · ◌ aborted · · never). */
function verdictStatusClass(t: Template): string {
  const k = verdictKind(t);
  return k === 'green' ? 'status-pass' : k === 'red' ? 'status-fail' : k === 'blocked' ? 'status-blocked' : k === 'aborted' ? 'status-quarantined' : 'status-none';
}
function verdictLabel(t: Template): string {
  const k = verdictKind(t);
  if (k === 'never') return 'never run';
  const v = t.verdict!;
  const when = v.lastFinishedAt ? relTime(v.lastFinishedAt) : '';
  const build = v.lastAppVersion ? ` · v${v.lastAppVersion}` : '';
  const lbl = k === 'green' ? 'pass' : k === 'red' ? 'fail' : k === 'blocked' ? 'blocked (infra)' : 'aborted';
  return `${lbl}${build}${when ? ` · ${when}` : ''}`;
}
function relTime(ms: number): string {
  const d = Date.now() - ms;
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

/** trend glyph → (symbol, system class) — mirrors .status-* semantics */
function trendGlyphs(t: Template): Array<{ g: string; cls: string }> {
  const trend = t.verdict?.trend;
  if (!trend) return [];
  return trend.split('').map((g) => ({ g: g === 'p' ? '✓' : g === 'F' ? '◆' : g === 'f' ? '✕' : '◌', cls: g === 'p' ? 't-pass' : g === 'F' ? 't-blocked' : g === 'f' ? 't-fail' : 't-abort' }));
}
const suiteSummary = computed(() => {
  const ks = templates.value.map(verdictKind);
  return {
    total: ks.length,
    green: ks.filter((k) => k === 'green').length,
    red: ks.filter((k) => k === 'red').length,
    blocked: ks.filter((k) => k === 'blocked').length,
    never: ks.filter((k) => k === 'never').length,
  };
});

// ── B4: plans ──
const plans = ref<Plan[]>([]);
const planMsg = ref('');
const runningPlan = ref<string | null>(null);
async function loadPlans(): Promise<void> {
  try {
    const r = await fetch('/api/plans');
    plans.value = ((await r.json()) as { plans: Plan[] }).plans ?? [];
  } catch { /* plans optional */ }
}
async function savePlanFromCurrent(): Promise<void> {
  const name = window.prompt('plan name (saves current filter, device, network choice and env):')?.trim();
  if (!name) return;
  try {
    const activeTags = filter.value.trim().split(',').map((s) => s.trim()).filter(Boolean);
    const r = await fetch('/api/plans', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, tags: activeTags, scenarioId: runScenario.value || undefined, env: parseEnv() }),
    });
    if (!r.ok) { planMsg.value = ((await r.json()) as { error?: string }).error ?? 'failed'; return; }
    planMsg.value = '';
    await loadPlans();
  } catch { planMsg.value = 'failed'; }
}
async function runPlan(p: Plan): Promise<void> {
  if (runningPlan.value) return;
  runningPlan.value = p.id;
  planMsg.value = '';
  try {
    const r = await fetch(`/api/plans/${p.id}/run`, { method: 'POST' });
    const b = (await r.json()) as { runIds?: string[]; count?: number; error?: string };
    planMsg.value = b.error ? b.error : (b.count ? `plan ran ${b.count} case(s)` : 'no cases matched');
    await load(); // refresh verdicts
  } catch { planMsg.value = 'plan run failed'; }
  finally { runningPlan.value = null; }
}
async function deletePlan(p: Plan): Promise<void> {
  if (!window.confirm(`delete plan "${p.name}"?`)) return;
  try { await fetch(`/api/plans/${p.id}`, { method: 'DELETE' }); } catch { /* ignore */ }
  await loadPlans();
}
function planDesc(p: Plan): string {
  const bits = [p.tags.length ? `#${p.tags.join(' #')}` : 'all cases'];
  if (p.scenarioId) bits.push(`net:${p.scenarioId}`);
  if (Object.keys(p.env).length) bits.push(`env:${Object.keys(p.env).length} vars`);
  return bits.join(' · ');
}

// the advanced-controls disclosure is collapsed while the yaml panel is open
const advancedOpen = ref(false);
watch(yamlOpenId, (id) => { if (id !== null) advancedOpen.value = false; });
</script>
<template>
  <section class="a2-page" :class="{ editing: yamlOpenId !== null }">
    <!-- ── header — the mockup's minimal one-row chrome; the suite summary +
         run controls ride in the advanced disclosure when not editing ── -->
    <header class="a2-head">
      <span class="page-title">test cases</span>
      <span class="a2-desc">{{ templates.length }} case{{ templates.length === 1 ? '' : 's' }} · {{ tagCount }} tag{{ tagCount === 1 ? '' : 's' }}</span>
      <span v-if="!editing" class="a2-suite" :title="`${suiteSummary.green} pass · ${suiteSummary.red} fail · ${suiteSummary.blocked} blocked · ${suiteSummary.never} never run`">
        <span class="sym" title="passing">✓{{ suiteSummary.green }}</span>
        <span v-if="suiteSummary.red" class="sym" title="failing">✕{{ suiteSummary.red }}</span>
        <span v-if="suiteSummary.blocked" class="sym" title="blocked (infra)">◆{{ suiteSummary.blocked }}</span>
        <span v-if="suiteSummary.never" class="sym" title="never run">◌{{ suiteSummary.never }}</span>
      </span>
      <span class="a2-spacer"></span>
      <input ref="filterEl" v-model="filter" class="a2-search" placeholder="search cases…  ⌘F" />
      <button class="btn" :disabled="playingAll" @click="createCaseYaml" title="hand-author a new case as yaml — opens the editor with a minimal starter">+ case (yaml)</button>
      <button v-if="!editing" class="btn" :disabled="playingAll || shown().length === 0" @click="playAll()" title="sequentially run every case matching the filter">
        {{ playingAll ? 'running…' : '▶ run filtered' }}
      </button>
    </header>

    <!-- ── advanced controls disclosure (hidden while editing yaml) ── -->
    <div v-if="!editing" class="a2-advanced">
      <button class="btn btn-ghost a2-adv-toggle" :class="{ active: advancedOpen || envOpen || !!envText || runScenario !== '' }" @click="advancedOpen = !advancedOpen">
        advanced {{ advancedOpen ? '▾' : '▸' }}
      </button>
      <template v-if="advancedOpen">
        <select v-model="runScenario" class="a2-select" title="network scenario active during runs — its presets fake endpoints for the run's duration, then restore">
          <option value="">network: live</option>
          <option v-for="s in scenarios" :key="s.id" :value="s.id">{{ s.name }}</option>
        </select>
        <button class="btn btn-ghost" :class="{ active: envOpen || !!envText }" @click="envOpen = !envOpen" title="run-time env values (KEY=value lines) sent with every play — never stored in cases">
          env{{ envKeyCount ? ` · ${envKeyCount}` : '' }} {{ envOpen ? '▾' : '▸' }}
        </button>
        <button class="btn btn-ghost" @click="savePlanFromCurrent" title="save the current filter + network choice + env as a named plan — one click replays this exact suite later">+ plan</button>
        <span v-if="planMsg" class="a2-note">{{ planMsg }}</span>
      </template>
      <span v-if="plans.length > 0" class="a2-plans">
        <button v-for="p in plans" :key="p.id" class="chip chip-click-wrap" :title="planDesc(p)">
          <span class="chip-click" :disabled="runningPlan !== null" @click="runPlan(p)">{{ runningPlan === p.id ? 'running…' : `▶ ${p.name}` }}</span>
          <span class="chip-x" title="delete this plan" @click="deletePlan(p)">✕</span>
        </button>
      </span>
    </div>
    <div v-if="!editing && envOpen" class="a2-env">
      <textarea v-model="envText" rows="3" spellcheck="false" placeholder="secrets at play time — one KEY=value per line (e.g. PASSWORD=hunter2). never stored in cases." />
    </div>

    <!-- ── case table: own scroll region, sticky header ── -->
    <div class="a2-table">
      <div class="a2-thead">
        <span class="col-case">case</span>
        <span class="col-app">app</span>
        <span class="col-steps">steps</span>
        <span class="col-updated">updated</span>
        <span class="col-trend" title="last 5 runs, oldest → newest (✓ pass · ✕ fail · ◆ blocked · ◌ aborted)">trend</span>
        <span class="col-verdict">verdict</span>
        <span class="col-actions"></span>
      </div>

      <article v-for="t in shown()" :key="t.id" class="a2-row-card" :class="{ editing: yamlOpenId === t.id }">
        <div class="a2-row" @click="openYaml(t)" title="click to edit this case">
          <span class="col-case">
            <span class="a2-name">{{ t.name }}</span>
            <span v-if="t.ticketKey" class="a2-ticket">{{ t.ticketKey }}</span>
            <span v-for="tg in t.tags ?? []" :key="tg" class="chip" title="click to filter by this tag" @click.stop="filter = tg">{{ tg }}</span>
          </span>
          <span class="col-app">
            <template v-if="t.appBundleId">
              <img v-if="t.udid" class="a2-app-icon" alt=""
                :src="`/api/devices/${t.udid}/apps/${encodeURIComponent(t.appBundleId)}/icon`"
                @error="(e: Event) => (e.target as HTMLImageElement).style.display = 'none'" />
              <span class="a2-app-name">{{ t.appName ?? t.appBundleId }}</span>
              <span v-if="t.appVersion" class="a2-app-ver">v{{ t.appVersion }}</span>
            </template>
            <span v-else class="a2-app-none">no app</span>
          </span>
          <span class="col-steps">{{ t.steps.length }}</span>
          <span class="col-updated" :title="new Date(t.updatedAt).toLocaleString()">{{ relTime(t.updatedAt) }}</span>
          <span class="col-trend">
            <span v-if="t.verdict?.trend" class="trend" title="last 5 runs, oldest → newest">
              <span v-for="(g, i) in trendGlyphs(t)" :key="i" :class="g.cls">{{ g.g }}</span>
            </span>
            <span v-else class="a2-trend-none">—</span>
          </span>
          <span class="col-verdict">
            <span v-if="t.verdict" :class="`status ${verdictStatusClass(t)}`" :title="verdictLabel(t)">{{ verdictLabel(t) }}</span>
            <span v-else class="status status-none">never run</span>
          </span>
          <span class="col-actions" @click.stop>
            <button class="btn btn-sm" :disabled="playing !== null" @click.stop="play(t)">{{ playing === t.id ? 'starting…' : '▶ run' }}</button>
            <button class="btn btn-sm btn-ghost" @click.stop="openYaml(t)" title="edit this case — metadata + yaml">edit</button>
            <button class="btn btn-sm btn-ghost" @click.stop="remove(t.id)">delete</button>
          </span>
        </div>

        <!-- the case editor (metadata + yaml) opens INLINE below this row -->
        <div v-if="yamlOpenId === t.id" class="a2-yaml">
          <CaseEditorPanel
            ref="yamlPanelEl"
            :template-id="t.id"
            :case-name="t.name"
            :position="yamlPosition.pos"
            :total="yamlPosition.total"
            :updated-at="t.updatedAt"
            :description="t.description"
            :ticket-key="t.ticketKey"
            :tags="t.tags ?? []"
            @close="yamlOpenId = null"
            @saved="() => void load()"
            @hop="hopYaml"
          />
        </div>

</article>
    </div>

    <div v-if="playMsg" class="a2-note">{{ playMsg }}</div>


    <!-- unsaved-changes guard: save / abort (✕ = keep editing) -->
    <div v-if="pendingSwitch" class="a2-modal-backdrop" @click.self="pendingSwitch = null">
      <div class="a2-modal card">
        <div class="card-header">
          <span class="card-title">unsaved changes</span>
          <button class="btn btn-sm" style="margin-left: auto;" title="keep editing" @click="pendingSwitch = null">✕</button>
        </div>
        <p style="color: var(--color-fog); font-size: var(--text-body); line-height: 1.6; padding: var(--s-2) var(--s-3);">
          This case has edits that are not saved yet. Save them before switching, or abort and lose the changes.
        </p>
        <div style="display: flex; gap: var(--s-2); justify-content: flex-end; padding: 0 var(--s-3) var(--s-3);">
          <button class="btn" @click="pendingSwitch = null">keep editing</button>
          <button class="btn btn-danger" @click="() => void resolveSwitch(false)">abort changes</button>
          <button class="btn btn-primary" @click="() => void resolveSwitch(true)">save &amp; switch</button>
        </div>
      </div>
    </div>

    <!-- the run companion dock (R1) — locked open for the run's duration -->
    <RunPanel
      v-if="runPanel"
      :run-id="runPanel.runId"
      :template-id="runPanel.templateId"
      :case-name="runPanel.caseName"
      :udid="runPanel.udid"
      @close="runPanel = null"
      @open-run="(id) => $router.push(`/runs/${id}`)"
    />
  </section>
</template>

<style scoped>
/* ── the A2 layout, natively: a viewport column. Header + table (own scroll)
   + yaml panel. The lock lives at the app's scroll container (body class),
   set by the watcher — nothing here needs a "variant". ── */
.a2-page {
  display: flex; flex-direction: column;
  gap: var(--s-3);
  width: 100%;
  box-sizing: border-box;
}
/* the run dock is a pure overlay: no layout shift when it opens — it sits
   above the table (fixed, z-80), the table never reflows */
/* header */
.a2-head { display: flex; align-items: baseline; gap: 14px; flex: none; }
.page-title { font-size: 15px; font-weight: 700; letter-spacing: 0.02em; }
.a2-desc { color: var(--color-steel); font-size: 11px; }
.a2-suite { color: var(--color-steel); font-size: 11px; }
.a2-suite .sym { margin-left: 6px; }
.a2-spacer { flex: 1; }
.a2-search {
  background: var(--color-carbon); border: 1px solid var(--color-iron); border-radius: var(--r-sm);
  color: var(--color-fog); font: inherit; font-size: 12px; padding: 4px 10px; width: 220px;
}
.a2-search:focus { outline: none; border-color: var(--color-ember); }

/* advanced disclosure */
.a2-advanced { display: flex; align-items: center; gap: var(--s-2); flex-wrap: wrap; flex: none; }
.a2-adv-toggle.active { border-color: var(--color-ember); color: var(--color-ember); }
.a2-select {
  background: var(--color-carbon); border: 1px solid var(--color-iron); border-radius: var(--r-sm);
  color: var(--color-fog); font: inherit; font-size: 12px; padding: 4px 8px;
}
.a2-note { color: var(--color-steel); font-size: 11px; }
.a2-plans { display: flex; gap: 4px; flex-wrap: wrap; }
.a2-env { flex: none; }
.a2-env textarea {
  width: 100%; background: var(--color-void); border: 1px solid var(--color-iron); border-radius: var(--r-sm);
  color: var(--color-paper); font-family: var(--font-mono); font-size: 11px; padding: var(--s-2);
}

/* table region — content-sized: no stretch, no forced height. Scrolls only
   when the list outgrows the available space (flex shrink engages then). */
.a2-table {
  flex: 0 1 auto;
  /* fit the width — never h-scroll: overflow-y:auto computes overflow-x to
     auto too (CSS spec), so lock x to hidden explicitly. The grid's
     minmax(0, fr) columns compress; long names ellipsize. */
  overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain;
  border: 1px solid var(--color-iron); border-radius: var(--r-sm);
  background: var(--color-carbon);
}
.a2-thead {
  position: sticky; top: 0; z-index: 2; background: var(--color-graphite);
  display: grid; grid-template-columns: minmax(0, 1.9fr) minmax(0, 1.2fr) minmax(0, 64px) minmax(0, 92px) minmax(0, 110px) minmax(0, 150px) minmax(0, 200px);
  gap: var(--s-2); padding: 8px 12px;
  font-size: 10px; color: var(--color-steel); text-transform: uppercase; letter-spacing: 0.08em;
}
.a2-row-card { border-bottom: 1px solid var(--color-iron); }
.a2-row-card.editing { border-color: var(--color-ember); }
.a2-row-card.editing .a2-row { background: color-mix(in srgb, var(--color-ember) 6%, transparent); }
.a2-row {
  position: relative; display: grid; grid-template-columns: minmax(0, 1.9fr) minmax(0, 1.2fr) minmax(0, 64px) minmax(0, 92px) minmax(0, 110px) minmax(0, 150px) minmax(0, 200px);
  gap: var(--s-2); align-items: center; padding: 8px 12px; min-height: 44px; cursor: pointer;
}
.a2-row:hover { background: var(--color-graphite); }
.col-steps, .col-updated { color: var(--color-fog); font-size: 12px; }
.a2-name { color: var(--color-paper); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.col-app { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* verdict pill ellipsizes inside its track at extreme narrow widths (the
   pill is the unbreakable floor: mono text can't wrap) */
.col-verdict { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.col-verdict .status { max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.a2-ticket { color: var(--color-steel); font-size: 10px; margin-left: 6px; }
.a2-app-icon { width: 16px; height: 16px; border-radius: 3px; vertical-align: -3px; margin-right: 6px; }
.a2-app-name { color: var(--color-fog); font-size: 12px; }
.a2-app-ver { color: var(--color-steel); font-size: 10px; margin-left: 4px; }
.a2-app-none { color: var(--color-steel); font-size: 11px; }
.a2-trend-none { color: var(--color-steel); }
/* actions: always-visible final column — no overlay, never covers the verdict */
.col-actions { display: flex; gap: 4px; justify-content: flex-end; }

/* row edit + expander body */

/* the yaml panel fills the remaining viewport while editing */
/* while EDITING, the table region takes its fixed mockup share */

/* the inline yaml editor below its row */
.a2-yaml { margin: 0 var(--s-2) var(--s-2); }
.a2-yaml > :deep(*) { width: 100%; }
/* unsaved-changes modal */
.a2-modal-backdrop {
  position: fixed; inset: 0; z-index: 90;
  background: rgba(0, 0, 0, 0.85);
  display: flex; align-items: center; justify-content: center;
}
.a2-modal {
  width: min(440px, calc(100vw - 32px));
  background: var(--color-graphite);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
}
</style>
