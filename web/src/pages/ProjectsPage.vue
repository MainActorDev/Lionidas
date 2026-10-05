<script setup lang="ts">
/** Projects page (027-B inline editor): admin-only repo registry. One project
 *  = one repo; git URL is identity, local path optional, auth token write-only
 *  (blank keeps, clearAuth clears). Claims (package → project) are managed
 *  from the package picker; this page shows the count. */
import { computed, onMounted, ref } from 'vue';
import PageHeader from '../components/PageHeader.vue';

interface Project {
  id: string;
  name: string;
  repoUrl: string;
  localPath: string | null;
  defaultBranch: string | null;
  authSet: boolean;
  updatedAt: number;
}
interface PackageRow { path: string; owner: { id: string; name: string } | null }

const projects = ref<Project[]>([]);
const pkgOwners = ref<Map<string, string>>(new Map());
const loaded = ref(false);
const error = ref('');

const openId = ref<string | null>(null); // 'draft' | project id
const editing = ref<Project | null>(null); // null = creating
const busy = ref(false);

const edName = ref('');
const edRepoUrl = ref('');
const edLocalPath = ref('');
const edBranch = ref('');
const edToken = ref('');

async function load(): Promise<void> {
  error.value = '';
  try {
    const r = await fetch('/api/projects');
    if (!r.ok) { error.value = r.status === 403 ? 'admin only' : `load failed (${r.status})`; projects.value = []; loaded.value = true; return; }
    const b = (await r.json()) as { projects?: Project[] };
    projects.value = b.projects ?? [];
    // claim counts: read the package list once (admin-only data, cheap)
    try {
      const pr = await fetch('/api/packages');
      if (pr.ok) {
        const pb = (await pr.json()) as { packages?: PackageRow[] };
        const m = new Map<string, string>();
        for (const p of pb.packages ?? []) if (p.owner) m.set(p.owner.id, (m.get(p.owner.id) ?? '') + (m.get(p.owner.id) ? ' ' : '') + (p.path.split('/').pop() ?? ''));
        pkgOwners.value = m;
      }
    } catch { /* counts are best-effort */ }
    loaded.value = true;
  } catch { error.value = 'load failed'; }
}
onMounted(() => void load());

function claimsOf(id: string): string[] {
  return (pkgOwners.value.get(id) ?? '').split(' ').filter(Boolean);
}

function startCreate(): void {
  openId.value = 'draft'; editing.value = null;
  edName.value = ''; edRepoUrl.value = ''; edLocalPath.value = ''; edBranch.value = ''; edToken.value = '';
}
function startEdit(p: Project): void {
  if (openId.value === p.id) { closePanel(); return; }
  openId.value = p.id; editing.value = p;
  edName.value = p.name; edRepoUrl.value = p.repoUrl; edLocalPath.value = p.localPath ?? '';
  edBranch.value = p.defaultBranch ?? ''; edToken.value = '';
}
function closePanel(): void {
  openId.value = null; editing.value = null;
}

async function save(): Promise<void> {
  if (busy.value) return;
  if (!edName.value.trim() || !edRepoUrl.value.trim()) { error.value = 'name and repo url are required'; return; }
  busy.value = true; error.value = '';
  const body = JSON.stringify({
    name: edName.value.trim(),
    repoUrl: edRepoUrl.value.trim(),
    localPath: edLocalPath.value.trim() || null,
    defaultBranch: edBranch.value.trim() || null,
    ...(edToken.value.trim() ? { authToken: edToken.value.trim() } : {}),
  });
  try {
    const r = editing.value
      ? await fetch(`/api/projects/${editing.value.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body })
      : await fetch('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    const b = (await r.json()) as { ok?: boolean; error?: string };
    if (!b.ok) { error.value = b.error ?? `save failed (${r.status})`; return; }
    closePanel();
    await load();
  } catch { error.value = 'save failed'; }
  finally { busy.value = false; }
}

async function remove(): Promise<void> {
  if (!editing.value || busy.value) return;
  const claims = claimsOf(editing.value.id);
  const msg = claims.length > 0
    ? `delete ${editing.value.name}? ${claims.length} package claim${claims.length > 1 ? 's' : ''} will be released.`
    : `delete ${editing.value.name}?`;
  if (!window.confirm(msg)) return;
  busy.value = true; error.value = '';
  try {
    const r = await fetch(`/api/projects/${editing.value.id}`, { method: 'DELETE' });
    if (!r.ok) { error.value = `delete failed (${r.status})`; return; }
    closePanel();
    await load();
  } catch { error.value = 'delete failed'; }
  finally { busy.value = false; }
}

async function clearToken(): Promise<void> {
  if (!editing.value || busy.value) return;
  busy.value = true; error.value = '';
  try {
    const r = await fetch(`/api/projects/${editing.value.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clearAuth: true }) });
    if (!r.ok) { error.value = `clear failed (${r.status})`; return; }
    edToken.value = '';
    await load();
    const fresh = projects.value.find((p) => p.id === editing.value?.id);
    if (fresh) editing.value = fresh;
  } catch { error.value = 'clear failed'; }
  finally { busy.value = false; }
}

function ageOf(ms: number): string {
  const d = Math.floor((Date.now() - ms) / 86_400_000);
  if (d < 1) return 'today';
  if (d < 30) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}

const canCreate = computed(() => openId.value !== 'draft');
</script>

<template>
  <div>
    <PageHeader title="projects" desc="source repositories lionidas knows — packages and CI anchor to them · admin only">
      <button class="btn btn-primary" :disabled="!canCreate" @click="startCreate">+ project</button>
    </PageHeader>

    <div v-if="error && !openId" class="pj-err">{{ error }}</div>

    <div class="pj-table a2-list">
      <div class="pj-thead">
        <span>project</span><span>repo</span><span>branch</span><span>auth</span><span>claims</span><span>updated</span><span></span>
      </div>

      <!-- draft card — creating -->
      <article v-if="openId === 'draft'" class="pj-row-card editing">
        <div class="pj-row draft">
          <span class="pj-name pj-newname">new project</span>
          <span class="pj-repo">—</span>
          <span class="pj-br">—</span>
          <span class="pj-auth">—</span>
          <span class="pj-claims">—</span>
          <span class="pj-upd">now</span>
          <span class="pj-actions"></span>
        </div>
        <div class="pj-editor">
          <div class="ed-grid">
            <label class="ed-fld"><span>name</span><input v-model="edName" placeholder="intl" /></label>
            <label class="ed-fld"><span>repo url — required</span><input v-model="edRepoUrl" placeholder="git@github.com:org/repo.git" /></label>
            <label class="ed-fld"><span>local path — optional</span><input v-model="edLocalPath" placeholder="/Users/you/Developer/…/repo" /></label>
            <label class="ed-fld"><span>default branch</span><input v-model="edBranch" placeholder="main" /></label>
            <label class="ed-fld ed-wide"><span>auth token — optional</span>
              <input v-model="edToken" type="password" placeholder="git-host credential (e.g. a GitHub PAT)" />
              <span class="ed-hint">write-only: stored, never displayed; blank keeps the current token</span>
            </label>
          </div>
          <div class="ed-foot">
            <span v-if="error" class="ed-err">{{ error }}</span>
            <span class="pj-spacer"></span>
            <button class="btn btn-ghost" @click="closePanel">cancel</button>
            <button class="btn btn-primary" :disabled="busy || !edName.trim() || !edRepoUrl.trim()" @click="save">{{ busy ? 'saving…' : 'save' }}</button>
          </div>
        </div>
      </article>

      <article v-for="p in projects" :key="p.id" class="pj-row-card" :class="{ editing: openId === p.id }">
        <div class="pj-row" @click="startEdit(p)" :title="openId === p.id ? 'click to collapse' : 'click to edit'">
          <span class="pj-name">{{ p.name }}</span>
          <span class="pj-repo" :title="p.repoUrl">{{ p.repoUrl }}</span>
          <span class="pj-br">{{ p.defaultBranch ?? '—' }}</span>
          <span class="pj-auth" :class="{ on: p.authSet }" :title="p.authSet ? 'token stored — value never shown' : 'no token'">{{ p.authSet ? 'token' : '—' }}</span>
          <span class="pj-claims" :title="claimsOf(p.id).join('\n') || 'no claimed packages'">{{ claimsOf(p.id).length || '—' }}</span>
          <span class="pj-upd">{{ ageOf(p.updatedAt) }}</span>
          <span class="pj-actions"></span>
        </div>
        <div v-if="openId === p.id" class="pj-editor">
          <div class="ed-grid">
            <label class="ed-fld"><span>name</span><input v-model="edName" /></label>
            <label class="ed-fld"><span>repo url — required</span><input v-model="edRepoUrl" /></label>
            <label class="ed-fld"><span>local path — optional</span><input v-model="edLocalPath" /></label>
            <label class="ed-fld"><span>default branch</span><input v-model="edBranch" /></label>
            <label class="ed-fld ed-wide"><span>auth token — optional</span>
              <input v-model="edToken" type="password" :placeholder="p.authSet ? 'stored — blank keeps' : 'git-host credential (e.g. a GitHub PAT)'" />
              <span class="ed-hint">write-only: stored, never displayed</span>
            </label>
          </div>
          <div class="ed-foot">
            <button v-if="p.authSet" class="btn btn-ghost" :disabled="busy" @click="clearToken">clear token</button>
            <span v-if="error" class="ed-err">{{ error }}</span>
            <span class="pj-spacer"></span>
            <button class="btn btn-ghost" @click="closePanel">cancel</button>
            <button class="btn btn-danger" :disabled="busy" @click="remove">delete</button>
            <button class="btn btn-primary" :disabled="busy || !edName.trim() || !edRepoUrl.trim()" @click="save">{{ busy ? 'saving…' : 'save' }}</button>
          </div>
        </div>
      </article>

      <div v-if="loaded && projects.length === 0 && openId !== 'draft'" class="pj-empty">
        no projects yet — + project registers a repo
      </div>
      <div v-if="!loaded && !error" class="pj-empty">loading…</div>
    </div>
  </div>
</template>

<style scoped>
.pj-table { background: var(--color-carbon); border: 1px solid var(--color-iron); }
.pj-thead, .pj-row {
  display: grid;
  grid-template-columns: minmax(90px, 1fr) minmax(200px, 2.4fr) 70px 56px 56px 80px 32px;
  gap: var(--s-3);
  align-items: center;
  padding: 0 12px;
}
.pj-thead {
  font-size: var(--text-caption); text-transform: uppercase; letter-spacing: 0.06em;
  color: var(--color-steel); min-height: 34px; border-bottom: 1px solid var(--color-iron);
  position: sticky; top: 0; background: var(--color-carbon); z-index: 1;
}
.pj-row-card { border-bottom: 1px solid var(--color-iron); }
.pj-row-card:last-child { border-bottom: none; }
.pj-row-card.editing { border-color: var(--color-ember); }
.pj-row-card.editing .pj-row { background: color-mix(in srgb, var(--color-ember) 6%, transparent); }
.pj-row { min-height: 44px; cursor: pointer; font-size: var(--text-label); color: var(--color-fog); }
.pj-row:hover { background: var(--color-graphite); }
.pj-name { color: var(--color-paper); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pj-newname { color: var(--color-ash); font-style: italic; }
.pj-repo, .pj-br, .pj-upd { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-ash); }
.pj-auth { font-size: 10px; padding: 1px 5px; border: 1px solid var(--color-iron); color: var(--color-ash); text-transform: uppercase; justify-self: start; }
.pj-auth.on { color: var(--color-ember); border-color: var(--color-ember-dim); }
.pj-claims { color: var(--color-ash); }
.pj-editor { padding: var(--s-4) 12px; background: var(--color-graphite); }
.ed-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--s-3); }
.ed-fld { display: flex; flex-direction: column; gap: 4px; }
.ed-fld > span:first-child { font-size: var(--text-caption); text-transform: uppercase; letter-spacing: 0.06em; color: var(--color-steel); }
.ed-fld input { background: var(--color-void); border: 1px solid var(--color-iron); color: var(--color-paper); font-family: var(--font-mono); font-size: var(--text-label); padding: 6px 8px; width: 100%; }
.ed-wide { grid-column: 1 / -1; }
.ed-hint { font-size: var(--text-caption); color: var(--color-steel); }
.ed-foot { display: flex; align-items: center; gap: var(--s-2); margin-top: var(--s-4); }
.ed-err { color: var(--color-ember); font-size: var(--text-caption); }
.pj-spacer { flex: 1; }
.pj-empty { padding: var(--s-5); color: var(--color-ash); font-size: var(--text-label); }
.pj-err { color: var(--color-ember); font-size: var(--text-label); margin-bottom: var(--s-3); }
</style>
