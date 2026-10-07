<script setup lang="ts">
/** Builds page (029-A Jenkins table): flat build list — # · status ball ·
 *  project · transport · duration · when · artifact; console opens as a
 *  drawer under the row (live-tailed while running via ?from= polling).
 *  ▶ build… picks a project (admin). */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import PageHeader from '../components/PageHeader.vue';

interface Build {
  id: string; projectId: string; projectName: string; number: number;
  status: 'running' | 'passed' | 'failed'; transport: 'repo-lane' | 'generic';
  scheme: string | null; startedAt: number; finishedAt: number | null;
  artifactPath: string | null; error: string | null;
}
interface Project { id: string; name: string }

const builds = ref<Build[]>([]);
const projects = ref<Project[]>([]);
const loaded = ref(false);
const error = ref('');

const openId = ref<string | null>(null);
const logText = ref('');
const logAt = ref(0);
let poll: ReturnType<typeof setInterval> | null = null;
let logPoll: ReturnType<typeof setInterval> | null = null;

const pickOpen = ref(false);
const starting = ref(false);

async function load(): Promise<void> {
  try {
    const r = await fetch('/api/builds');
    if (!r.ok) { error.value = r.status === 403 ? 'admin only' : `load failed (${r.status})`; loaded.value = true; return; }
    builds.value = ((await r.json()) as { builds?: Build[] }).builds ?? [];
    // keep polling while any build runs
    if (poll && !builds.value.some((b) => b.status === 'running')) { clearInterval(poll); poll = null; }
    loaded.value = true;
  } catch { error.value = 'load failed'; }
}
async function loadProjects(): Promise<void> {
  try {
    const r = await fetch('/api/projects');
    if (r.ok) projects.value = ((await r.json()) as { projects?: Project[] }).projects ?? [];
  } catch { /* picker handles empty */ }
}
onMounted(() => {
  void load();
  void loadProjects();
  poll = setInterval(() => void load(), 3000);
});
onBeforeUnmount(() => { if (poll) clearInterval(poll); if (logPoll) clearInterval(logPoll); });

async function startBuild(pid: string): Promise<void> {
  if (starting.value) return;
  starting.value = true; error.value = '';
  try {
    const r = await fetch(`/api/projects/${pid}/builds`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const b = (await r.json()) as { ok?: boolean; build?: Build; error?: string };
    if (!b.ok) { error.value = b.error ?? `start failed (${r.status})`; return; }
    pickOpen.value = false;
    await load();
    if (b.build) toggleLog(b.build.id);
    if (!poll) poll = setInterval(() => void load(), 3000);
  } catch { error.value = 'start failed'; }
  finally { starting.value = false; }
}

async function toggleLog(id: string): Promise<void> {
  if (openId.value === id) {
    openId.value = null;
    if (logPoll) { clearInterval(logPoll); logPoll = null; }
    return;
  }
  openId.value = id;
  logText.value = ''; logAt.value = 0;
  await tailLog(id);
  if (logPoll) clearInterval(logPoll);
  logPoll = setInterval(() => { if (openId.value) void tailLog(openId.value); }, 2000);
}
async function tailLog(id: string): Promise<void> {
  try {
    const r = await fetch(`/api/builds/${id}/log?from=${logAt.value}`);
    if (!r.ok) return;
    const size = Number(r.headers.get('x-log-size') ?? '0');
    const chunk = await r.text();
    if (chunk) logText.value += chunk;
    logAt.value = size;
  } catch { /* next tick */ }
}

function ball(b: Build): { glyph: string; cls: string; label: string } {
  if (b.status === 'running') return { glyph: '◐', cls: 'run', label: 'running' };
  if (b.status === 'passed') return { glyph: '●', cls: 'pass', label: 'passed' };
  return { glyph: '✕', cls: 'fail', label: 'failed' };
}
function durOf(b: Build): string {
  const end = b.finishedAt ?? Date.now();
  const s = Math.max(0, Math.round((end - b.startedAt) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${(s / 3600).toFixed(1)}h`;
}
function hhmm(ts: number): string {
  const d = new Date(ts);
  const day = new Date(ts).toDateString() === new Date().toDateString() ? '' : `${new Date(ts).toLocaleDateString()} `;
  return `${day}${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const runningCount = computed(() => builds.value.filter((b) => b.status === 'running').length);
</script>

<template>
  <div>
    <PageHeader title="builds">
      <span class="ph-desc">ci — simulator packages built from the repos workspace · admin only</span>
      <template #actions>
        <button class="btn btn-primary" @click="pickOpen = true">▶ build…</button>
      </template>
    </PageHeader>

    <div v-if="error" class="b-err">{{ error }}</div>
    <div v-if="!loaded && !error" class="b-empty">loading…</div>

    <div v-if="loaded" class="b-list a2-list">
      <div class="b-thead">
        <span>#</span><span>status</span><span>project</span><span>transport</span><span>duration</span><span>when</span><span>artifact</span><span></span>
      </div>
      <template v-for="b in builds" :key="b.id">
        <div class="b-row" @click="toggleLog(b.id)" :title="openId === b.id ? 'click to collapse console' : 'click for console'">
          <span class="b-num">#{{ b.number }}</span>
          <span class="b-status"><span class="ball" :class="ball(b).cls">{{ ball(b).glyph }}</span> <span class="b-meta">{{ ball(b).label }}</span></span>
          <span class="b-proj">{{ b.projectName }} <span v-if="b.scheme" class="b-meta">· {{ b.scheme }}</span></span>
          <span><span class="b-chip">{{ b.transport }}</span></span>
          <span class="b-meta">{{ b.status === 'running' ? '…' : '' }}{{ durOf(b) }}</span>
          <span class="b-meta">{{ hhmm(b.startedAt) }}</span>
          <span class="b-meta b-art" :title="b.artifactPath ?? b.error ?? ''">
            <template v-if="b.artifactPath">{{ b.artifactPath.split('/').pop() }}</template>
            <template v-else-if="b.error">✕ {{ b.error.slice(0, 60) }}{{ b.error.length > 60 ? '…' : '' }}</template>
            <template v-else>—</template>
          </span>
          <span class="b-meta">▤</span>
        </div>
        <div v-if="openId === b.id" class="b-console">
          <pre class="b-log">{{ logText || '…' }}</pre>
        </div>
      </template>
      <div v-if="builds.length === 0" class="b-empty">no builds yet — ▶ build… starts one from a cloned project</div>
    </div>

    <!-- project picker for ▶ build… -->
    <div v-if="pickOpen" class="pk-backdrop" @click.self="pickOpen = false">
      <div class="pk-modal">
        <div class="pk-head"><span class="pk-title">build project</span><button class="pk-x" @click="pickOpen = false">✕</button></div>
        <div class="pk-body">
          <div v-if="projects.length === 0" class="b-empty">no projects — register one on the projects page first</div>
          <div v-for="p in projects" :key="p.id" class="pk-row" @click="startBuild(p.id)">
            <span>{{ p.name }}</span>
            <span class="b-meta">▶</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.b-list { background: var(--color-carbon); border: 1px solid var(--color-iron); }
.b-thead, .b-row { display: grid; grid-template-columns: 56px 110px minmax(0, 1.4fr) 92px 82px 96px minmax(0, 1fr) 28px; gap: var(--s-3); align-items: center; padding: 0 var(--s-4); }
.b-thead { position: sticky; top: 0; z-index: 2; background: var(--color-carbon); min-height: 34px; border-bottom: 1px solid var(--color-iron); font-size: var(--text-caption); text-transform: uppercase; letter-spacing: 0.06em; color: var(--color-steel); }
.b-row { min-height: 40px; border-bottom: 1px solid var(--color-iron); font-size: var(--text-label); color: var(--color-fog); cursor: pointer; }
.b-row:hover { background: var(--color-graphite); }
.b-num { color: var(--color-steel); }
.b-status { display: flex; align-items: center; gap: 6px; }
.ball { font-size: 13px; display: inline-block; }
.ball.pass { color: var(--color-ember); }
.ball.fail { color: var(--color-paper); }
.ball.run { color: var(--color-ash); animation: spin 1.2s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.b-proj { color: var(--color-paper); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.b-meta { color: var(--color-ash); font-size: var(--text-caption); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.b-chip { font-size: 10px; padding: 1px 5px; border: 1px solid var(--color-iron); color: var(--color-ash); text-transform: uppercase; }
.b-console { background: var(--color-graphite); border-bottom: 1px solid var(--color-iron); padding: var(--s-3) var(--s-4); }
.b-log { font-family: var(--font-mono); font-size: 12px; line-height: 1.6; color: var(--color-fog); max-height: 320px; overflow-y: auto; white-space: pre-wrap; word-break: break-all; margin: 0; }
.b-empty { padding: var(--s-5); color: var(--color-ash); font-size: var(--text-label); }
.b-err { color: var(--color-ember); font-size: var(--text-label); margin-bottom: var(--s-3); }
.pk-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.72); display: flex; align-items: center; justify-content: center; z-index: 90; }
.pk-modal { width: 380px; background: var(--color-graphite); border: 1px solid var(--color-iron); }
.pk-head { display: flex; align-items: center; padding: var(--s-4) var(--s-5); border-bottom: 1px solid var(--color-iron); }
.pk-title { font-size: var(--text-heading-sm); color: var(--color-paper); }
.pk-x { margin-left: auto; background: none; border: none; color: var(--color-steel); cursor: pointer; font-size: 15px; }
.pk-row { display: flex; justify-content: space-between; align-items: center; padding: var(--s-3) var(--s-5); font-size: var(--text-label); color: var(--color-fog); cursor: pointer; border-bottom: 1px solid var(--color-iron); }
.pk-row:hover { background: var(--color-carbon); color: var(--color-paper); }
</style>
