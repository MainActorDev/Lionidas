<script setup lang="ts">
/** Settings page (028, env-page anatomy): admin-only instance configuration.
 *  Today: per-project credentials (write-only — replace/clear, never display)
 *  and storage locations (read-only, env-derived). Sections are collapsible
 *  scope blocks inside one a2-list, env-page rhythm — future settings land
 *  as more sections. */
import { computed, onMounted, ref } from 'vue';
import PageHeader from '../components/PageHeader.vue';

interface Project { id: string; name: string; authSet: boolean }

const projects = ref<Project[]>([]);
const reposDir = ref('');
const packagesDirVal = ref('');
const loaded = ref(false);
const error = ref('');

const openSections = ref(new Set<string>(['cred']));
function toggleSec(k: string): void {
  const s = new Set(openSections.value);
  if (s.has(k)) s.delete(k); else s.add(k);
  openSections.value = s;
}

async function load(): Promise<void> {
  error.value = '';
  try {
    const r = await fetch('/api/projects');
    if (!r.ok) { error.value = r.status === 403 ? 'admin only' : `load failed (${r.status})`; loaded.value = true; return; }
    projects.value = ((await r.json()) as { projects?: Project[] }).projects ?? [];
  } catch { error.value = 'load failed'; }
  try {
    const r = await fetch('/api/settings/repos-dir');
    if (r.ok) reposDir.value = ((await r.json()) as { dir?: string }).dir ?? '';
  } catch { /* display-only */ }
  try {
    const r = await fetch('/api/packages');
    if (r.ok) packagesDirVal.value = ((await r.json()) as { dir?: string }).dir ?? '';
  } catch { /* display-only */ }
  loaded.value = true;
}
onMounted(() => void load());

// ── token dialog (write-only: set/replace, never displayed) ──
const dlg = ref<{ project: Project } | null>(null);
const dlgToken = ref('');
const dlgBusy = ref(false);
const dlgErr = ref('');
function openSet(p: Project): void {
  dlg.value = { project: p };
  dlgToken.value = ''; dlgErr.value = '';
}
async function saveToken(): Promise<void> {
  if (!dlg.value || dlgBusy.value) return;
  if (!dlgToken.value.trim()) { dlgErr.value = 'token required'; return; }
  dlgBusy.value = true; dlgErr.value = '';
  try {
    const r = await fetch(`/api/projects/${dlg.value.project.id}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ authToken: dlgToken.value.trim() }),
    });
    if (!r.ok) { dlgErr.value = `save failed (${r.status})`; return; }
    dlg.value = null;
    await load();
  } catch { dlgErr.value = 'save failed'; }
  finally { dlgBusy.value = false; }
}
async function clearToken(p: Project): Promise<void> {
  if (!window.confirm(`clear ${p.name}'s token? cloning private repos will fail until a new one is set.`)) return;
  try {
    const r = await fetch(`/api/projects/${p.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clearAuth: true }) });
    if (!r.ok) { error.value = `clear failed (${r.status})`; return; }
    await load();
  } catch { error.value = 'clear failed'; }
}

const credCount = computed(() => `${projects.value.filter((p) => p.authSet).length} of ${projects.value.length}`);
</script>

<template>
  <div>
    <PageHeader title="settings">
      <span class="ph-desc">instance configuration — credentials, storage · admin only</span>
    </PageHeader>

    <div v-if="error" class="st-err">{{ error }}</div>
    <div v-if="!loaded && !error" class="st-empty">loading…</div>

    <div v-if="loaded" class="st-list a2-list">
      <!-- credentials section -->
      <div class="scope-block" :class="{ open: openSections.has('cred') }">
        <div class="a2-group-head scope-head" @click="toggleSec('cred')">
          <span class="caret">{{ openSections.has('cred') ? '▾' : '▸' }}</span>
          <span class="tag">credentials</span>
          <span class="owner">per-project git-host tokens · write-only</span>
          <span class="cnt">{{ credCount }}</span>
        </div>
        <div class="scope-body">
          <div class="st-thead"><span>project</span><span>token</span><span></span></div>
          <div v-for="p in projects" :key="p.id" class="st-row">
            <span class="st-key">{{ p.name }}</span>
            <span class="st-val masked" v-if="p.authSet">••••••••</span>
            <span class="st-val dim" v-else>none — public repo</span>
            <span class="st-acts">
              <button v-if="p.authSet" @click="openSet(p)">replace…</button>
              <button v-else @click="openSet(p)">set…</button>
              <button v-if="p.authSet" class="danger" @click="clearToken(p)">clear</button>
            </span>
          </div>
          <div v-if="projects.length === 0" class="st-row empty">no projects registered — add one on the projects page</div>
        </div>
      </div>

      <!-- storage section -->
      <div class="scope-block" :class="{ open: openSections.has('store') }">
        <div class="a2-group-head scope-head" @click="toggleSec('store')">
          <span class="caret">{{ openSections.has('store') ? '▾' : '▸' }}</span>
          <span class="tag">storage</span>
          <span class="owner">where the system keeps clones and packages</span>
          <span class="cnt">2</span>
        </div>
        <div class="scope-body">
          <div class="st-thead"><span>what</span><span>location</span><span></span></div>
          <div class="st-row">
            <span class="st-key">repos workspace</span>
            <span class="st-val" :title="reposDir">{{ reposDir || '—' }}</span>
            <span class="st-meta">CRUCIBLE_REPOS_DIR · read-only</span>
          </div>
          <div class="st-row">
            <span class="st-key">packages dir</span>
            <span class="st-val" :title="packagesDirVal">{{ packagesDirVal || '—' }}</span>
            <span class="st-meta">CRUCIBLE_PACKAGES_DIR · read-only</span>
          </div>
        </div>
      </div>
    </div>

    <!-- token dialog -->
    <div v-if="dlg" class="dlg-wrap open" @click.self="dlg = null">
      <div class="dlg">
        <h3>{{ dlg.project.authSet ? 'replace' : 'set' }} token · {{ dlg.project.name }}</h3>
        <label>git-host credential (e.g. a GitHub PAT)</label>
        <input v-model="dlgToken" type="password" placeholder="paste the token — it is stored write-only, never displayed" @keydown.enter="saveToken" />
        <div class="dlg-err" v-if="dlgErr">{{ dlgErr }}</div>
        <div class="dlg-acts">
          <button class="btn btn-ghost" @click="dlg = null">cancel</button>
          <button class="btn btn-primary" :disabled="dlgBusy || !dlgToken.trim()" @click="saveToken">{{ dlgBusy ? 'saving…' : 'save' }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.st-list { background: var(--color-carbon); border: 1px solid var(--color-iron); }
.scope-head .tag { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--color-fog); border: 1px solid var(--color-slate); border-radius: var(--r-sm); padding: 1px var(--s-2); }
.scope-head .cnt { color: var(--color-steel); font-size: var(--text-caption); border: 1px solid var(--color-iron); border-radius: var(--r-sm); padding: 0 var(--s-2); }
.scope-body { display: none; }
.scope-block.open .scope-body { display: block; }
.st-thead, .st-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.8fr) minmax(0, 220px); gap: var(--s-2); align-items: center; padding: 8px 12px; }
.st-thead { position: sticky; top: 0; z-index: 2; background: var(--color-graphite); font-size: 10px; color: var(--color-steel); text-transform: uppercase; letter-spacing: 0.08em; }
.st-row { border-bottom: 1px solid var(--color-iron); min-height: 44px; }
.st-row:hover { background: var(--color-graphite); }
.st-row.empty { color: var(--color-steel); }
.st-key { color: var(--color-paper); font-weight: var(--weight-bold); font-size: var(--text-label); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.st-val { color: var(--color-fog); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.st-val.masked { color: var(--color-steel); letter-spacing: 0.2em; }
.st-val.dim { color: var(--color-steel); }
.st-meta { color: var(--color-steel); font-size: 10px; white-space: nowrap; justify-self: end; }
.st-acts { display: flex; gap: var(--s-2); justify-self: end; }
.st-acts button { color: var(--color-pewter); font-size: var(--text-caption); transition: color var(--t); }
.st-acts button:hover { color: var(--color-chalk); }
.st-acts button.danger:hover { color: var(--color-ember); }
.st-err { color: var(--color-ember); font-size: var(--text-label); margin-bottom: var(--s-3); }
.st-empty { color: var(--color-steel); font-size: var(--text-label); }
.dlg-wrap { position: fixed; inset: 0; background: rgba(0,0,0,.72); display: flex; align-items: center; justify-content: center; z-index: 10; }
.dlg { background: var(--color-graphite); border: 1px solid var(--color-slate); border-radius: var(--r-sm); padding: var(--s-4); width: 420px; }
.dlg h3 { font-size: var(--text-caption); font-weight: var(--weight-bold); text-transform: uppercase; letter-spacing: 0.08em; color: var(--color-fog); margin-bottom: var(--s-3); }
.dlg label { font-size: 10px; color: var(--color-steel); display: block; margin: var(--s-2) 0 var(--s-1); text-transform: uppercase; letter-spacing: 0.08em; }
.dlg input { width: 100%; background: var(--color-void); border: 1px solid var(--color-iron); border-radius: var(--r-sm); color: var(--color-paper); font-family: var(--font-mono); font-size: var(--text-label); padding: 6px var(--s-2); }
.dlg-err { color: var(--color-ember); font-size: var(--text-caption); margin-top: var(--s-2); }
.dlg-acts { display: flex; gap: var(--s-2); justify-content: flex-end; margin-top: var(--s-4); }
</style>
