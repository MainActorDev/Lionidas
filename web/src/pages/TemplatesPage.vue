<script setup lang="ts">
/** Templates manager: recorded test configs (CRUD) — the QA regression library.
 *  Steps are plain data; playback runs them (2d). Ticket tag filters regression selection. */
import { ref, onMounted } from 'vue';

interface Step { idx: number; action: string; x?: number; y?: number; direction?: string; text?: string }
interface Template {
  id: string; name: string; description: string | null; ticketKey: string | null;
  udid: string; logicalW: number | null; logicalH: number | null;
  steps: Step[]; defaultPresetId: string | null;
  appBundleId: string | null; appName: string | null; appVersion: string | null;
  createdBy: string; createdAt: number; updatedAt: number;
}

const templates = ref<Template[]>([]);
const loading = ref(true);
const error = ref('');
const expanded = ref<string | null>(null);
const filter = ref('');
const renaming = ref<string | null>(null);
const renameName = ref('');
const renamingTicket = ref('');
const renamingDesc = ref('');
const playing = ref<string | null>(null);
const playMsg = ref('');
// network choice (phase 4): scenarios group presets; the selector applies to
// every run started while set — presets active for the run's duration only
const scenarios = ref<Array<{ id: string; name: string }>>([]);
const runScenario = ref<string>('');

async function play(t: Template): Promise<void> {
  if (playing.value) return;
  playing.value = t.id;
  playMsg.value = '';
  try {
    const r = await fetch(`/api/templates/${t.id}/play`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(runScenario.value ? { scenarioId: runScenario.value } : {}),
    });
    const b = (await r.json()) as { runId?: string; error?: string };
    playMsg.value = b.runId ? `running · ${b.runId}${runScenario.value ? ' · scenario active' : ''}` : (b.error ?? 'failed');
  } catch {
    playMsg.value = 'failed';
  } finally { playing.value = null; }
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
}

async function saveRename(id: string): Promise<void> {
  await fetch(`/api/templates/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: renameName.value, ticketKey: renamingTicket.value || null, description: renamingDesc.value || null }),
  });
  renaming.value = null;
  await load();
}

function stepLabel(s: Step): string {
  if (s.action === 'tap') return `tap ${s.x},${s.y}`;
  if (s.action === 'scroll') return `scroll ${s.direction}`;
  if (s.action === 'type') return `type "${(s.text ?? '').slice(0, 18)}${(s.text ?? '').length > 18 ? '…' : ''}"`;
  return s.action;
}

const shown = (): Template[] => {
  const f = filter.value.trim().toLowerCase();
  if (!f) return templates.value;
  return templates.value.filter((t) =>
    t.name.toLowerCase().includes(f) || (t.ticketKey ?? '').toLowerCase().includes(f));
};

onMounted(() => void load());
</script>

<template>
  <section class="page">
    <header class="page-head">
      <h1>templates</h1>
      <input v-model="filter" class="input filter" placeholder="filter by name or ticket…" />
      <select
        v-model="runScenario" class="input" style="width: auto;"
        title="network scenario active during runs — its presets fake endpoints for the run's duration, then restore"
      >
        <option value="">network: live</option>
        <option v-for="s in scenarios" :key="s.id" :value="s.id">{{ s.name }}</option>
      </select>
      <span class="count">{{ templates.length }}</span>
    </header>

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
          <button class="btn btn-sm" @click="saveRename(t.id)">save</button>
          <button class="btn btn-sm btn-ghost" @click="renaming = null">cancel</button>
        </div>

        <div v-if="expanded === t.id" class="tpl-body">
          <p v-if="t.description" class="tpl-desc">{{ t.description }}</p>
          <ol class="tpl-steps">
            <li v-for="s in t.steps" :key="s.idx"><span class="tpl-step-idx">{{ s.idx + 1 }}</span> {{ stepLabel(s) }}</li>
          </ol>
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
.tpl-meta { flex: 1; color: var(--color-steel); font-size: 10px; text-align: right; display: flex; align-items: center; justify-content: flex-end; gap: 4px; }
.tpl-icon { width: 16px; height: 16px; border-radius: 4px; display: block; }
.tpl-app { color: var(--color-ash); }
.tpl-app-none { color: var(--color-steel); font-style: italic; }
.tpl-ver { font-size: 9px; }
.tpl-sep { opacity: 0.5; }
.tpl-actions { display: flex; gap: var(--s-1); opacity: 0; }
.tpl-row:hover .tpl-actions { opacity: 1; }
.tpl-edit { display: flex; gap: var(--s-2); padding: var(--s-2) var(--s-3); border-top: 1px solid var(--color-iron); flex-wrap: wrap; }
.tpl-edit .input { flex: 1; min-width: 120px; }
.tpl-body { border-top: 1px solid var(--color-iron); padding: var(--s-3); }
.tpl-desc { color: var(--color-fog); font-size: 12px; margin: 0 0 var(--s-2); }
.tpl-steps { margin: 0; padding-left: 20px; color: var(--color-fog); font-size: 12px; }
.tpl-steps li { margin: 2px 0; }
.tpl-step-idx { color: var(--color-steel); }
.play-msg { margin-top: var(--s-3); color: var(--color-steel); font-size: 11px; }
</style>
