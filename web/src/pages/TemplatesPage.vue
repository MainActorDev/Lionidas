<script setup lang="ts">
/** Test cases: recorded flows (CRUD) + assertions — the QA regression suite.
 *  Each case shows its last verdict + trend; plans replay the suite in one
 *  click; playback runs them. Ticket tag filters regression selection. */
import { ref, onMounted, computed } from 'vue';

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
  tags: string[];
  verdict: Verdict | null;
  createdBy: string; createdAt: number; updatedAt: number;
}
interface Plan { id: string; name: string; tags: string[]; udid: string | null; appBundleId: string | null; scenarioId: string | null; env: Record<string, string> }

const templates = ref<Template[]>([]);
const loading = ref(true);
const error = ref('');
const expanded = ref<string | null>(null);
const filter = ref('');
const renaming = ref<string | null>(null);
const renameName = ref('');
const renamingTicket = ref('');
const renamingDesc = ref('');
const renamingTags = ref('');
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
    playMsg.value = b.runId ? `running · ${b.runId}${runScenario.value ? ' · scenario active' : ''}` : (b.error ?? 'failed');
  } catch {
    playMsg.value = 'failed';
  } finally { playing.value = null; }
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

/** parameterize (B10 fix): turn a type step's literal text into ${env.KEY} —
 *  the literal secret leaves the template; the value comes from env at play */
async function parameterize(t: Template, s: Step): Promise<void> {
  const key = window.prompt('env key name (used as ${env.KEY} at play time):', 'PASSWORD');
  if (!key) return;
  const steps = t.steps.map((x) => (x.idx === s.idx ? { ...x, text: `\${env.${key}}` } : x));
  await patchTemplate(t.id, { steps });
}

async function toggleOptional(t: Template, s: Step): Promise<void> {
  const steps = t.steps.map((x) => (x.idx === s.idx ? { ...x, optional: !x.optional } : x));
  await patchTemplate(t.id, { steps });
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

function startRename(t: Template): void {
  renaming.value = t.id;
  renameName.value = t.name;
  renamingTicket.value = t.ticketKey ?? '';
  renamingDesc.value = t.description ?? '';
  renamingTags.value = (t.tags ?? []).join(', ');
}

async function saveRename(id: string): Promise<void> {
  await fetch(`/api/templates/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: renameName.value,
      ticketKey: renamingTicket.value || null,
      description: renamingDesc.value || null,
      tags: renamingTags.value.split(',').map((x) => x.trim()).filter(Boolean),
    }),
  });
  renaming.value = null;
  await load();
}

function stepLabel(s: Step): string {
  if (s.action === 'expect') return `expect "${s.selector?.label ?? s.selector?.identifier ?? '?'}"`;
  if (s.action === 'runFlow') return `run flow: ${templates.value.find((t) => t.id === s.templateId)?.name ?? s.templateId ?? '?'}`;
  if (s.action === 'tap') return `tap ${s.x},${s.y}`;
  if (s.action === 'scroll') return `scroll ${s.direction}`;
  if (s.action === 'type') return `type "${(s.text ?? '').slice(0, 18)}${(s.text ?? '').length > 18 ? '…' : ''}"`;
  return s.action;
}

/** A7: append an expect step to an EXISTING template — the maintenance path
 *  (most assertions get added retroactively after a first failure). */
async function addExpectation(t: Template): Promise<void> {
  const label = window.prompt('assert screen contains (label):')?.trim();
  if (!label) return;
  const steps = [...t.steps, { idx: t.steps.length, action: 'expect', selector: { label } }];
  await patchTemplate(t.id, { steps });
}

/** A5: append a runFlow step referencing another template by name. */
async function addSubflow(t: Template): Promise<void> {
  const name = window.prompt('subflow template name:')?.trim();
  if (!name) return;
  const target = templates.value.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!target) { window.alert(`no template named "${name}"`); return; }
  if (target.id === t.id) { window.alert('a template cannot run itself'); return; }
  const steps = [...t.steps, { idx: t.steps.length, action: 'runFlow', templateId: target.id }];
  await patchTemplate(t.id, { steps });
}

const shown = (): Template[] => {
  const f = filter.value.trim().toLowerCase();
  if (!f) return templates.value;
  return templates.value.filter((t) =>
    t.name.toLowerCase().includes(f) || (t.ticketKey ?? '').toLowerCase().includes(f) || (t.tags ?? []).some((tg) => tg.toLowerCase().includes(f)));
};

onMounted(() => { void load(); void loadPlans(); });

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

// ── revamp: env disclosure + step-kind labels ──
const envOpen = ref(false);  // collapsed until asked — env is an advanced control
const envKeyCount = computed(() => Object.keys(parseEnv()).length);
function stepKindLabel(action: string): string {
  return action === 'tap' ? 'tap' : action === 'scroll' ? 'scroll' : action === 'type' ? 'type' : action === 'expect' ? 'assert' : action === 'runFlow' ? 'flow' : action;
}
function stepKindTitle(action: string): string {
  return action === 'tap' ? 'tap at recorded coordinates (selector-resolved when possible)' : action === 'scroll' ? 'scroll gesture' : action === 'type' ? 'type text into the focused field' : action === 'expect' ? 'existence assertion — replay fails red if the element disappears' : action === 'runFlow' ? 'run another case as a subflow' : action;
}
</script>
<template>
  <section class="page">
    <!-- ── header: title · suite summary · primary actions ── -->
    <header class="tc-head">
      <div class="tc-title-group">
        <h1>test cases</h1>
        <span class="stat-summary" :title="`${suiteSummary.green} pass · ${suiteSummary.red} fail · ${suiteSummary.blocked} blocked · ${suiteSummary.never} never run`">
          <span class="n">{{ suiteSummary.total }}</span> {{ suiteSummary.total === 1 ? 'case' : 'cases' }}
          <span class="sym" title="passing">✓{{ suiteSummary.green }}</span>
          <span v-if="suiteSummary.red" class="sym" title="failing">✕{{ suiteSummary.red }}</span>
          <span v-if="suiteSummary.blocked" class="sym" title="blocked (infra)">◆{{ suiteSummary.blocked }}</span>
          <span v-if="suiteSummary.never" class="sym" title="never run">◌{{ suiteSummary.never }}</span>
        </span>
      </div>
      <div class="tc-actions">
        <button class="btn" :disabled="playingAll || shown().length === 0" @click="playAll()" title="sequentially run every case matching the filter">
          {{ playingAll ? 'running…' : '▶ run filtered' }}
        </button>
        <button class="btn btn-ghost" @click="savePlanFromCurrent" title="save the current filter + network choice + env as a named plan — one click replays this exact suite later">+ plan</button>
      </div>
    </header>

    <!-- ── controls: filter · network · env disclosure ── -->
    <div class="tc-controls">
      <input v-model="filter" class="input tc-filter" placeholder="filter by name, ticket, or tag…" />
      <select
        v-model="runScenario" class="input tc-scenario"
        title="network scenario active during runs — its presets fake endpoints for the run's duration, then restore"
      >
        <option value="">network: live</option>
        <option v-for="s in scenarios" :key="s.id" :value="s.id">{{ s.name }}</option>
      </select>
      <button class="btn btn-ghost tc-env-toggle" :class="{ active: envOpen || !!envText }" @click="envOpen = !envOpen" title="run-time env values (KEY=value lines) sent with every play — never stored in cases">
        env{{ envKeyCount ? ` · ${envKeyCount}` : '' }} {{ envOpen ? '▾' : '▸' }}
      </button>
    </div>
    <div v-if="envOpen" class="tc-env">
      <textarea
        v-model="envText" class="input" rows="3" spellcheck="false"
        placeholder="secrets at play time — one KEY=value per line (e.g. PASSWORD=hunter2). never stored in cases."
      />
    </div>

    <!-- ── plans (saved suite invocations) ── -->
    <div v-if="plans.length > 0" class="tc-plans">
      <span class="tc-plans-label">plans</span>
      <span v-for="p in plans" :key="p.id" class="chip" :title="planDesc(p)">
        <button class="chip-click" :disabled="runningPlan !== null" @click="runPlan(p)">{{ runningPlan === p.id ? 'running…' : `▶ ${p.name}` }}</button>
        <button class="chip-x" title="delete this plan" @click="deletePlan(p)">✕</button>
      </span>
      <span v-if="planMsg" class="tc-plan-msg">{{ planMsg }}</span>
    </div>

    <div v-if="loading" class="empty">loading…</div>
    <div v-else-if="error" class="empty" style="color: var(--color-ember);">{{ error }}</div>

    <div v-else-if="shown().length === 0" class="empty tc-empty">
      <div class="tc-empty-title">{{ templates.length === 0 ? 'no test cases yet' : 'no cases match the filter' }}</div>
      <div class="hint-bar tc-empty-journey">
        <span class="h-step">record <span>▸ devices</span></span>
        <span class="h-arrow">→</span>
        <span class="h-step">assert <span>▸ recorder</span></span>
        <span class="h-arrow">→</span>
        <span class="h-step">save <span>▸ sidebar</span></span>
        <span class="h-arrow">→</span>
        <span class="h-step">run <span>▶ here</span></span>
      </div>
    </div>

    <!-- ── case table: column headers + grid rows ── -->
    <div v-else class="tc-table">
      <div class="tc-thead">
        <span class="col-expander"></span>
        <span class="col-case">case</span>
        <span class="col-app">app</span>
        <span class="col-steps">steps</span>
        <span class="col-updated">updated</span>
        <span class="col-trend" title="last 10 runs, oldest → newest (✓ pass · ✕ fail · ◆ blocked · ◌ aborted)">trend</span>
        <span class="col-verdict">verdict</span>
      </div>

      <article v-for="t in shown()" :key="t.id" class="tc-row-card" :class="{ open: expanded === t.id }">
        <div class="tc-row" @click="expanded = expanded === t.id ? null : t.id">
          <span class="col-expander">{{ expanded === t.id ? '▾' : '▸' }}</span>
          <span class="col-case">
            <span class="tc-name">{{ t.name }}</span>
            <span v-if="t.ticketKey" class="tc-ticket">{{ t.ticketKey }}</span>
            <span v-for="tg in t.tags ?? []" :key="tg" class="chip tc-tag" title="click to filter by this tag" @click.stop="filter = tg">{{ tg }}</span>
          </span>
          <span class="col-app">
            <template v-if="t.appBundleId">
              <img
                v-if="t.udid" class="tc-app-icon" alt=""
                :src="`/api/devices/${t.udid}/apps/${encodeURIComponent(t.appBundleId)}/icon`"
                @error="(e: Event) => (e.target as HTMLImageElement).style.display = 'none'"
              />
              <span class="tc-app-name">{{ t.appName ?? t.appBundleId }}</span>
              <span v-if="t.appVersion" class="tc-app-ver">v{{ t.appVersion }}</span>
            </template>
            <span v-else class="tc-app-none">no app</span>
          </span>
          <span class="col-steps">{{ t.steps.length }}</span>
          <span class="col-updated" :title="new Date(t.updatedAt).toLocaleString()">{{ relTime(t.updatedAt) }}</span>
          <span class="col-trend">
            <span v-if="t.verdict?.trend" class="trend" title="last 10 runs, oldest → newest (✓ pass · ✕ fail · ◆ blocked · ◌ aborted)">
              <span v-for="(g, i) in trendGlyphs(t)" :key="i" :class="g.cls">{{ g.g }}</span>
            </span>
            <span v-else class="tc-trend-none">—</span>
          </span>
          <span class="col-verdict">
            <span v-if="t.verdict" :class="`status ${verdictStatusClass(t)}`" :title="verdictLabel(t)">{{ verdictLabel(t) }}</span>
            <span v-else class="status status-none">never run</span>
          </span>
          <span class="tc-hover-actions">
            <button class="btn btn-sm" :disabled="playing !== null" @click.stop="play(t)">{{ playing === t.id ? 'starting…' : '▶ run' }}</button>
            <button class="btn btn-sm btn-ghost" @click.stop="startRename(t)">edit</button>
            <button class="btn btn-sm btn-ghost" @click.stop="remove(t.id)">delete</button>
          </span>
        </div>

        <div v-if="renaming === t.id" class="tc-edit">
          <input v-model="renameName" class="input" placeholder="name" />
          <input v-model="renamingTicket" class="input" placeholder="ticket key (e.g. LP-123)" />
          <input v-model="renamingDesc" class="input" placeholder="description" />
          <input v-model="renamingTags" class="input" placeholder="tags (comma list, e.g. smoke, login)" />
          <span class="tc-edit-actions">
            <button class="btn btn-sm" @click="saveRename(t.id)">save</button>
            <button class="btn btn-sm btn-ghost" @click="renaming = null">cancel</button>
          </span>
        </div>

        <div v-if="expanded === t.id" class="tc-body">
          <p v-if="t.description" class="tc-desc">{{ t.description }}</p>
          <div class="tc-steps">
            <div v-for="s in t.steps" :key="s.idx" class="tc-step">
              <span class="tc-step-n">{{ s.idx + 1 }}</span>
              <span class="chip tc-step-kind" :class="`kind-${s.action}`" :title="stepKindTitle(s.action)">{{ stepKindLabel(s.action) }}</span>
              <span class="tc-step-label">{{ stepLabel(s) }}</span>
              <span
                v-if="s.selector && (s.selector.identifier || s.selector.label) && s.action !== 'expect'"
                class="tc-step-sel"
                :title="`element selector: ${JSON.stringify(s.selector)}`"
              >⚓ {{ s.selector.identifier ?? s.selector.label }}</span>
              <span v-if="s.action === 'expect' && s.selector" class="tc-step-sel tc-step-assert" :title="`assertion: replay fails if this element disappears — ${JSON.stringify(s.selector)}`">assert</span>
              <span class="tc-step-controls">
                <label v-if="s.action === 'type'" class="tc-step-ctl" title="replace literal text with ${env.KEY} — the value is provided at play time (env box above), never stored in the case">
                  <input type="checkbox" :checked="(s.text ?? '').startsWith('${env.')" @change="parameterize(t, s)" /> param
                </label>
                <label class="tc-step-ctl" title="optional step: a miss records skip, the run stays green (popups, interstitials)">
                  <input type="checkbox" :checked="!!s.optional" @change="toggleOptional(t, s)" /> optional
                </label>
              </span>
            </div>
          </div>
          <div class="tc-body-actions">
            <button class="btn btn-sm" @click="addSubflow(t)" title="append a runFlow step — this case will run another case's steps as part of its own">+ subflow</button>
            <button class="btn btn-sm" @click="addExpectation(t)" title="append an assertion — replay fails red if the element disappears from the screen">+ assert</button>
          </div>
        </div>
      </article>
    </div>
    <div v-if="playMsg" class="tc-play-msg">{{ playMsg }}</div>
  </section>
</template>

<style scoped>
.page { padding: var(--s-5); max-width: 1160px; margin: 0 auto; }

/* ── header ── */
.tc-head { display: flex; align-items: center; justify-content: space-between; gap: var(--s-4); margin-bottom: var(--s-4); }
.tc-title-group { display: flex; align-items: baseline; gap: var(--s-4); }
.tc-head h1 { font-size: var(--text-heading); font-weight: var(--weight-bold); margin: 0; }
.tc-actions { display: flex; gap: var(--s-2); }

/* ── controls ── */
.tc-controls { display: flex; align-items: center; gap: var(--s-2); margin-bottom: var(--s-3); }
.tc-filter { flex: 1; max-width: 340px; }
.tc-scenario { width: auto; }
.tc-env-toggle { min-width: 72px; justify-content: center; }
.tc-env-toggle.active { color: var(--color-paper); border-color: var(--color-slate); }
.tc-env { margin-bottom: var(--s-3); }
.tc-env textarea { resize: vertical; font-size: var(--text-caption); }

/* ── plans ── */
.tc-plans { display: flex; align-items: center; gap: var(--s-2); flex-wrap: wrap; margin-bottom: var(--s-3); }
.tc-plans-label { font-size: var(--text-caption); color: var(--color-steel); text-transform: uppercase; letter-spacing: 0.08em; }
.tc-plan-msg { font-size: var(--text-caption); color: var(--color-ash); }

/* ── empty state ── */
.tc-empty { padding: var(--s-7); }
.tc-empty-title { color: var(--color-fog); font-size: var(--text-body); margin-bottom: var(--s-4); }
.tc-empty-journey { border-bottom: none; justify-content: center; margin-bottom: 0; }

/* ── the table: grid columns shared by header + rows ── */
.tc-thead, .tc-row {
  display: grid;
  grid-template-columns: 20px minmax(220px, 1.6fr) minmax(150px, 1fr) 52px 72px minmax(84px, auto) minmax(150px, auto);
  gap: var(--s-2);
  align-items: center;
}
.tc-thead {
  font-size: var(--text-caption);
  color: var(--color-ash);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 0 var(--s-3) var(--s-2);
}
.tc-thead .col-steps, .tc-thead .col-updated { text-align: right; }
.tc-thead .col-trend { text-align: center; }
.tc-thead .col-verdict { text-align: right; }

.tc-table { display: flex; flex-direction: column; gap: var(--s-2); }
.tc-row-card { border: 1px solid var(--color-iron); border-radius: var(--r-sm); background: var(--color-carbon); }
.tc-row-card.open { border-color: var(--color-slate); }
.tc-row { position: relative; padding: var(--s-2) var(--s-3); cursor: pointer; min-height: 44px; }
.tc-row:hover { background: var(--color-graphite); }

.col-expander { color: var(--color-steel); font-size: 10px; }
.col-case { display: flex; align-items: center; gap: var(--s-2); min-width: 0; flex-wrap: wrap; }
.tc-name { font-weight: var(--weight-bold); font-size: var(--text-label); color: var(--color-paper); }
.tc-ticket { font-size: var(--text-caption); color: var(--color-ash); }
.tc-tag { font-size: 10px; padding: 0 var(--s-1); }

.col-app { display: flex; align-items: center; gap: 6px; min-width: 0; }
.tc-app-icon { width: 18px; height: 18px; border-radius: 3px; display: block; flex: none; }
.tc-app-name { color: var(--color-ash); font-size: var(--text-caption); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tc-app-ver { color: var(--color-steel); font-size: 10px; flex: none; }
.tc-app-none { color: var(--color-steel); font-size: var(--text-caption); font-style: italic; }

.col-steps, .col-updated { text-align: right; color: var(--color-ash); font-size: var(--text-caption); }
.col-trend { text-align: center; }
.tc-trend-none { color: var(--color-pewter); }
.col-verdict { text-align: right; }

/* hover actions overlay — zero reserve, verdict stays flush */
.tc-hover-actions {
  position: absolute; right: var(--s-2); top: 50%; transform: translateY(-50%);
  display: flex; gap: var(--s-1); opacity: 0;
  background: linear-gradient(to right, transparent, var(--color-graphite) 24px);
  padding: 2px 0;
}
.tc-row:hover .tc-hover-actions { opacity: 1; }

/* ── edit strip ── */
.tc-edit { display: flex; gap: var(--s-2); padding: var(--s-2) var(--s-3); border-top: 1px solid var(--color-iron); flex-wrap: wrap; align-items: center; }
.tc-edit .input { flex: 1; min-width: 120px; }
.tc-edit-actions { display: flex; gap: var(--s-2); }

/* ── expanded body: structured steps ── */
.tc-body { border-top: 1px solid var(--color-iron); padding: var(--s-3); }
.tc-desc { color: var(--color-fog); font-size: var(--text-caption); margin: 0 0 var(--s-3); }
.tc-steps { display: flex; flex-direction: column; gap: 2px; }
.tc-step { display: flex; align-items: center; gap: var(--s-2); padding: 3px var(--s-1); border-radius: var(--r-sm); font-size: var(--text-caption); color: var(--color-fog); min-height: 26px; }
.tc-step:hover { background: var(--color-graphite); }
.tc-step-n { color: var(--color-steel); width: 18px; text-align: right; flex: none; }
.tc-step-kind { flex: none; font-size: 10px; padding: 0 var(--s-1); min-width: 44px; justify-content: center; }
.kind-tap { color: var(--color-paper); }
.kind-scroll { color: var(--color-ash); }
.kind-type { color: var(--color-paper); }
.kind-expect { border-color: var(--color-ember-dim); color: var(--color-ember); }
.kind-runFlow { border-style: dashed; }
.tc-step-label { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tc-step-sel { color: var(--color-steel); font-size: 10px; flex: none; }
.tc-step-assert { color: var(--color-ember); }
.tc-step-controls { margin-left: auto; display: flex; gap: var(--s-3); flex: none; }
.tc-step-ctl { font-size: 10px; color: var(--color-steel); cursor: pointer; user-select: none; white-space: nowrap; }
.tc-step-ctl input { vertical-align: middle; }
.tc-body-actions { display: flex; gap: var(--s-2); margin-top: var(--s-3); }

.tc-play-msg { margin-top: var(--s-3); color: var(--color-steel); font-size: var(--text-caption); }
</style>
