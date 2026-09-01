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
/** trend glyph → (char, class) — p/f/a + uppercase F = blocked */
function trendGlyphs(t: Template): Array<{ g: string; cls: string }> {
  const trend = t.verdict?.trend;
  if (!trend) return [];
  return trend.split('').map((g) => ({ g, cls: g === 'p' ? 'tg-p' : g === 'F' ? 'tg-F' : g === 'f' ? 'tg-f' : 'tg-a' }));
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
</script>

<template>
  <section class="page">
    <header class="page-head">
      <h1>test cases</h1>
      <input v-model="filter" class="input filter" placeholder="filter by name, ticket, or tag…" />
      <select
        v-model="runScenario" class="input" style="width: auto;"
        title="network scenario active during runs — its presets fake endpoints for the run's duration, then restore"
      >
        <option value="">network: live</option>
        <option v-for="s in scenarios" :key="s.id" :value="s.id">{{ s.name }}</option>
      </select>
      <button class="btn btn-sm" :disabled="playingAll || shown().length === 0" @click="playAll()" title="sequentially run every case matching the filter">
        {{ playingAll ? 'running…' : '▶ run filtered' }}
      </button>
      <button class="btn btn-sm" @click="savePlanFromCurrent" title="save the current filter + network choice + env as a named plan — one click replays this exact suite later">+ save as plan</button>
      <span class="count" :title="`${suiteSummary.green} pass · ${suiteSummary.red} fail · ${suiteSummary.blocked} blocked · ${suiteSummary.never} never run`">
        {{ templates.length }} cases · ✓{{ suiteSummary.green }} {{ suiteSummary.red + suiteSummary.blocked > 0 ? `✕${suiteSummary.red}` : '' }}{{ suiteSummary.blocked > 0 ? ` ◆${suiteSummary.blocked}` : '' }}
      </span>
    </header>
    <div class="journey" title="the authoring loop — each word is where that step happens">
      <span class="j-step">record <span class="j-hint">devices ▸ take control</span></span>
      <span class="j-arrow">→</span>
      <span class="j-step">assert <span class="j-hint">recorder ▸ assert box</span></span>
      <span class="j-arrow">→</span>
      <span class="j-step">save <span class="j-hint">save as case</span></span>
      <span class="j-arrow">→</span>
      <span class="j-step">run <span class="j-hint">▶ per case or plan</span></span>
      <span class="j-arrow">→</span>
      <span class="j-step">verdict <span class="j-hint">runs page</span></span>
    </div>
    <div v-if="plans.length > 0 || planMsg" class="plan-bar">
      <template v-for="p in plans" :key="p.id">
        <span class="plan-chip" :title="planDesc(p)">
          <button class="btn btn-sm btn-primary" :disabled="runningPlan !== null" @click="runPlan(p)">{{ runningPlan === p.id ? 'running…' : `▶ ${p.name}` }}</button>
          <button class="btn btn-sm btn-ghost" title="delete this plan" @click="deletePlan(p)">✕</button>
        </span>
      </template>
      <span v-if="planMsg" class="plan-msg">{{ planMsg }}</span>
    </div>
    <div class="env-bar">
      <code class="env-key">env</code>
      <textarea
        v-model="envText" class="input env-input" rows="1" spellcheck="false"
        placeholder="run-time secrets/values, one KEY=value per line (e.g. PASSWORD=hunter2) — sent with every play, never stored in cases"
      />
    </div>

    <div v-if="loading" class="empty">loading…</div>
    <div v-else-if="error" class="empty" style="color: var(--color-ember);">{{ error }}</div>
    <div v-else-if="shown().length === 0" class="empty">
      no templates yet — take control of a device on the wall, record a flow, save it
    </div>

    <div v-else class="tpl-list">
      <article v-for="t in shown()" :key="t.id" class="tpl" :class="{ open: expanded === t.id }">
        <div class="tpl-row" @click="expanded = expanded === t.id ? null : t.id">
          <span class="tpl-chevron">{{ expanded === t.id ? '▾' : '▸' }}</span>
          <span class="tpl-name">{{ t.name }}</span>
          <span v-if="t.ticketKey" class="tag">{{ t.ticketKey }}</span>
          <span v-for="tg in t.tags ?? []" :key="tg" class="tag tag-chip" title="click to filter by this tag" @click.stop="filter = tg">{{ tg }}</span>
          <span class="tpl-meta">
            <img
              v-if="t.appBundleId && t.udid" class="tpl-icon" alt=""
              :src="`/api/devices/${t.udid}/apps/${encodeURIComponent(t.appBundleId)}/icon`"
              @error="(e: Event) => (e.target as HTMLImageElement).style.display = 'none'"
            />
            <span v-if="t.appBundleId" class="tpl-app">{{ t.appName ?? t.appBundleId }}</span>
            <span v-if="t.appVersion" class="tpl-ver">v{{ t.appVersion }}</span>
            <span v-if="!t.appBundleId" class="tpl-app tpl-app-none">no app bound</span>
            <span class="tpl-sep">·</span>{{ t.steps.length }} steps · {{ new Date(t.updatedAt).toLocaleDateString() }}</span>
          <span class="tpl-verdict" :title="verdictLabel(t)">
            <span v-if="trendGlyphs(t).length" class="tpl-trend">
              <span v-for="(g, i) in trendGlyphs(t)" :key="i" :class="g.cls">{{ g.g }}</span>
            </span>
            <span :class="`vd vd-${verdictKind(t)}`">{{ verdictKind(t) === 'green' ? '✓' : verdictKind(t) === 'red' ? '✕' : verdictKind(t) === 'blocked' ? '◆' : verdictKind(t) === 'aborted' ? '◌' : '·' }}</span>
            <span class="vd-label">{{ verdictLabel(t) }}</span>
          </span>
          <span class="tpl-actions">
            <button class="btn btn-sm" :disabled="playing !== null" @click.stop="play(t)">{{ playing === t.id ? 'starting…' : '▶ run' }}</button>
            <button class="btn btn-sm btn-ghost" @click.stop="startRename(t)">edit</button>
            <button class="btn btn-sm btn-ghost" @click.stop="remove(t.id)">delete</button>
          </span>
        </div>

        <div v-if="renaming === t.id" class="tpl-edit">
          <input v-model="renameName" class="input" placeholder="name" />
          <input v-model="renamingTicket" class="input" placeholder="ticket key (e.g. LP-123)" />
          <input v-model="renamingDesc" class="input" placeholder="description" />
          <input v-model="renamingTags" class="input" placeholder="tags (comma list, e.g. smoke, login)" />
          <button class="btn btn-sm" @click="saveRename(t.id)">save</button>
          <button class="btn btn-sm btn-ghost" @click="renaming = null">cancel</button>
        </div>

        <div v-if="expanded === t.id" class="tpl-body">
          <p v-if="t.description" class="tpl-desc">{{ t.description }}</p>
          <ol class="tpl-steps">
            <li v-for="s in t.steps" :key="s.idx">
              <span class="tpl-step-idx">{{ s.idx + 1 }}</span> {{ stepLabel(s) }}
              <span
                v-if="s.selector && (s.selector.identifier || s.selector.label) && s.action !== 'expect'"
                class="tpl-step-sel"
                :title="`element selector (A6): ${JSON.stringify(s.selector)}`"
              >⚓ {{ s.selector.identifier ?? s.selector.label }}</span>
              <span
                v-if="s.action === 'expect' && s.selector"
                class="tpl-step-sel"
                :title="`assertion (A7): replay fails if this element disappears — ${JSON.stringify(s.selector)}`"
              >🎯 {{ s.selector.label ?? s.selector.identifier }}</span>
              <label v-if="s.action === 'type'" class="tpl-step-ctl" title="replace literal text with ${env.KEY} — the value is provided at play time (env box above), never stored in the template">
                <input type="checkbox" :checked="(s.text ?? '').startsWith('${env.')" @change="parameterize(t, s)" /> param
              </label>
              <label class="tpl-step-ctl" title="optional step: a miss records skip, the run stays green (popups, interstitials)">
                <input type="checkbox" :checked="!!s.optional" @change="toggleOptional(t, s)" /> optional
              </label>
            </li>
          </ol>
          <div style="display: flex; gap: var(--s-2); margin-top: var(--s-2);">
            <button class="btn btn-sm" @click="addSubflow(t)" title="append a runFlow step — this template will run another template's steps as part of its own">+ subflow</button>
            <button class="btn btn-sm" @click="addExpectation(t)" title="append an assertion — replay fails red if the element disappears from the screen">+ assert</button>
          </div>
        </div>
      </article>
    </div>
    <div v-if="playMsg" class="play-msg">{{ playMsg }}</div>
  </section>
</template>

<style scoped>
.page { padding: var(--s-5); max-width: 900px; margin: 0 auto; }
.page-head { display: flex; align-items: baseline; gap: var(--s-3); margin-bottom: var(--s-4); }
.page-head h1 { font-size: 20px; font-weight: 600; margin: 0; }
.filter { flex: 1; max-width: 280px; }
.count { color: var(--color-steel); font-size: 11px; }
.empty { color: var(--color-steel); font-size: 12px; padding: var(--s-8) 0; text-align: center; }
.tpl-list { display: flex; flex-direction: column; gap: var(--s-2); }
.tpl { border: 1px solid var(--color-iron); border-radius: 6px; background: var(--color-panel); }
.tpl.open { border-color: var(--color-ash); }
.tpl-row { display: flex; align-items: center; gap: var(--s-3); padding: var(--s-2) var(--s-3); cursor: pointer; }
.tpl-chevron { color: var(--color-steel); font-size: 10px; }
.tpl-name { font-weight: 600; font-size: 13px; }
.tag { font-size: 10px; color: var(--color-ember); border: 1px solid var(--color-iron); padding: 1px 6px; border-radius: 3px; }
.tag-chip { color: var(--color-fog); cursor: pointer; }
.tag-chip:hover { border-color: var(--color-ash); }
.env-bar { display: flex; align-items: center; gap: var(--s-2); margin-bottom: var(--s-3); }
.env-key { font-size: 10px; color: var(--color-steel); }
.env-input { flex: 1; font-family: var(--font-mono, monospace); font-size: 11px; resize: vertical; min-height: 26px; }
.tpl-step-ctl { font-size: 10px; color: var(--color-steel); margin-left: 8px; cursor: pointer; user-select: none; }
.tpl-step-ctl input { vertical-align: middle; }
.tpl-meta { flex: 1; color: var(--color-steel); font-size: 10px; text-align: right; display: flex; align-items: center; justify-content: flex-end; gap: 4px; }
.tpl-icon { width: 16px; height: 16px; border-radius: 4px; display: block; }
.tpl-app { color: var(--color-ash); }
.tpl-app-none { color: var(--color-steel); font-style: italic; }
.tpl-ver { font-size: 9px; }
.tpl-sep { opacity: 0.5; }
.tpl-actions { display: flex; gap: var(--s-1); opacity: 0; }
.tpl-row:hover .tpl-actions { opacity: 1; }

/* ── B4: verdict + trend + journey + plans ── */
.tpl-verdict { margin-left: auto; display: flex; align-items: center; gap: 6px; flex: none; }
.tpl-trend { font-family: var(--font-mono, monospace); font-size: 9px; letter-spacing: 1px; opacity: 0.85; }
.tg-p { color: var(--color-moss, #6a8); }
.tg-f { color: var(--color-ember, #e55); }
.tg-F { color: var(--color-amber, #d80); font-weight: 700; }
.tg-a { color: var(--color-steel, #888); }
.vd { font-size: 12px; width: 16px; text-align: center; }
.vd-green { color: var(--color-moss, #6a8); }
.vd-red { color: var(--color-ember, #e55); }
.vd-blocked { color: var(--color-amber, #d80); }
.vd-aborted, .vd-never { color: var(--color-steel, #888); }
.vd-label { font-size: 10px; color: var(--color-steel); max-width: 170px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.journey {
  display: flex; align-items: center; gap: var(--s-2); flex-wrap: wrap;
  font-size: 10px; color: var(--color-steel);
  padding: 6px 0; border-bottom: 1px dashed var(--color-iron);
  margin-bottom: var(--s-2);
}
.j-step { color: var(--color-fog); }
.j-hint { color: var(--color-steel); }
.j-arrow { opacity: 0.5; }

.plan-bar { display: flex; align-items: center; gap: var(--s-2); flex-wrap: wrap; margin-bottom: var(--s-2); }
.plan-chip { display: inline-flex; gap: 2px; }
.plan-msg { font-size: 10px; color: var(--color-steel); }
.tpl-edit { display: flex; gap: var(--s-2); padding: var(--s-2) var(--s-3); border-top: 1px solid var(--color-iron); flex-wrap: wrap; }
.tpl-edit .input { flex: 1; min-width: 120px; }
.tpl-body { border-top: 1px solid var(--color-iron); padding: var(--s-3); }
.tpl-desc { color: var(--color-fog); font-size: 12px; margin: 0 0 var(--s-2); }
.tpl-steps { margin: 0; padding-left: 20px; color: var(--color-fog); font-size: 12px; }
.tpl-steps li { margin: 2px 0; }
.tpl-step-idx { color: var(--color-steel); }
.play-msg { margin-top: var(--s-3); color: var(--color-steel); font-size: 11px; }
</style>
