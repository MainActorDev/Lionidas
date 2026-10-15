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
  defaultSuiteId: string | null;
  retention: number | null;
  updatedAt: number;
}
interface SuiteOpt { id: string; name: string }
interface WsStatus { exists: boolean; branch: string | null; head: string | null; dirty: number | null; manifest: { scheme: string | null; configuration: string | null; prepare: string[] } | 'invalid' | null; manifestRaw: string | null; manifestError: string | null }
interface PackageRow { path: string; owner: { id: string; name: string } | null }

/** build-config onboarding (plan 20261015T021000Z S3/S4 UI): the honest
 *  three-state report per project + the active config revision + verify verdict */
interface BuildConfigBlocker { code: string; detail: string; evidence: string }
interface BuildConfigDetection {
  state: 'found' | 'derivable' | 'blocked';
  source?: string; legacy?: boolean;
  recipe?: { transport: string; scheme: string | null; configuration: string | null; prepare: Array<{ run: string }> };
  blockers?: BuildConfigBlocker[]; notes?: string[];
}
interface ActiveBuildConfig {
  id: string; revision: number; transport: string; scheme: string | null; configuration: string | null;
  prepare: Array<{ run: string }>; generated: boolean; verifyState: 'unverified' | 'green' | 'failed' | null; verifiedAt: number | null;
}

const projects = ref<Project[]>([]);
const suites = ref<SuiteOpt[]>([]);
const wsStates = ref<Record<string, WsStatus>>({});
const wsBusy = ref<Record<string, boolean>>({});
const pkgOwners = ref<Map<string, string>>(new Map());
const loaded = ref(false);
const error = ref('');

const bcDetections = ref<Record<string, BuildConfigDetection>>({});
const bcActive = ref<Record<string, ActiveBuildConfig | null>>({});
const bcBusy = ref<Record<string, string>>({}); // 'detect' | 'derive' | 'verify' | ''

async function loadBuildConfigs(): Promise<void> {
  await Promise.all(projects.value.map(async (p) => {
    // detection rides the project row (persisted at clone/detect time); fall back
    // to an on-demand detect only when absent AND cloned
    if (bcDetections.value[p.id]) return; // already loaded this session
    // the project row persists only the STATE string — the full report (blockers,
    // evidence, legacy flag) comes from detection; run it whenever the workspace
    // is cloned (cheap: pattern files + at most one xcodebuild -list)
    const ws = wsStates.value[p.id];
    if (ws?.exists) {
      try {
        const r = await fetch(`/api/projects/${p.id}/build-config/detect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        if (r.ok) bcDetections.value[p.id] = ((await r.json()) as { buildConfig: BuildConfigDetection }).buildConfig;
      } catch { /* detection best-effort */ }
    }
    try {
      const r = await fetch(`/api/projects/${p.id}/build-config`);
      if (r.ok) bcActive.value[p.id] = ((await r.json()) as { recipe: ActiveBuildConfig | null }).recipe ?? null;
    } catch { /* active best-effort */ }
  }));
}

async function bcDetect(p: Project): Promise<void> {
  if (bcBusy.value[p.id]) return;
  bcBusy.value[p.id] = 'detect';
  try {
    const r = await fetch(`/api/projects/${p.id}/build-config/detect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    if (r.ok) bcDetections.value[p.id] = ((await r.json()) as { buildConfig: BuildConfigDetection }).buildConfig;
  } finally { bcBusy.value[p.id] = ''; }
}

async function bcDerive(p: Project): Promise<void> {
  if (bcBusy.value[p.id]) return;
  bcBusy.value[p.id] = 'derive';
  error.value = '';
  try {
    const r = await fetch(`/api/projects/${p.id}/build-config/derive`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const b = (await r.json()) as { ok?: boolean; error?: string; buildConfig?: ActiveBuildConfig };
    if (!b.ok) { error.value = b.error ?? `derive failed (${r.status})`; return; }
    bcActive.value[p.id] = b.buildConfig ?? null;
    const d = bcDetections.value[p.id];
    if (d && d.state === 'derivable') bcDetections.value[p.id] = { ...d, state: 'found', source: 'derived' } as BuildConfigDetection;
  } finally { bcBusy.value[p.id] = ''; }
}

async function bcVerify(p: Project): Promise<void> {
  if (bcBusy.value[p.id]) return;
  bcBusy.value[p.id] = 'verify';
  error.value = '';
  try {
    const r = await fetch(`/api/projects/${p.id}/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const b = (await r.json()) as { ok?: boolean; error?: string };
    if (!b.ok) { error.value = b.error ?? `verify failed (${r.status})`; return; }
    // compile gate runs for minutes — poll the active config until a verdict lands
    const deadline = Date.now() + 12 * 60_000;
    while (Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 10_000));
      const rr = await fetch(`/api/projects/${p.id}/build-config`);
      if (rr.ok) {
        const row = ((await rr.json()) as { recipe: ActiveBuildConfig | null }).recipe ?? null;
        const prev = bcActive.value[p.id];
        // a fresh verdict = verifiedAt newer than what we had
        if (row && row.id === prev?.id && row.verifyState && row.verifyState !== 'unverified' && row.verifiedAt && (!prev?.verifiedAt || row.verifiedAt > (prev.verifiedAt ?? 0))) {
          bcActive.value[p.id] = row;
          break;
        }
        bcActive.value[p.id] = row;
      }
    }
  } finally { bcBusy.value[p.id] = ''; }
}

/** the row chip: colored dot + short label */
function bcChip(p: Project): { cls: string; text: string; title: string } {
  const d = bcDetections.value[p.id];
  const a = bcActive.value[p.id];
  if (a) {
    const v = a.verifyState === 'green' ? 'ok' : a.verifyState === 'failed' ? 'bad' : 'warn';
    const vt = a.verifyState === 'green' ? `verified ${ageOf(a.verifiedAt ?? 0)}` : a.verifyState === 'failed' ? 'verify FAILED' : 'unverified';
    return { cls: v, text: `⚙ rev${a.revision} · ${vt}`, title: `build config rev${a.revision} (${a.scheme ?? a.transport})${a.generated ? ' · generated — review me' : ''} · ${vt}` };
  }
  if (!d) return { cls: 'dim', text: '⚙ —', title: 'no build-config detection yet' };
  if (d.state === 'found') return { cls: 'ok', text: `⚙ found${d.legacy ? ' · legacy' : ''}`, title: `build config found (${d.source})${d.legacy ? ' — legacy .lionidas, import suggested' : ''}` };
  if (d.state === 'derivable') return { cls: 'warn', text: '⚙ derivable', title: 'no config yet — one can be derived (generated, needs review)' };
  const codes = (d.blockers ?? []).map((b) => b.code).join(', ');
  return { cls: 'bad', text: '⚙ blocked', title: `blocked: ${codes || 'unknown'}` };
}

const openId = ref<string | null>(null); // 'draft' | project id
const editing = ref<Project | null>(null); // null = creating
const busy = ref(false);

const edName = ref('');
const edRepoUrl = ref('');
const edBranch = ref('');

/** where the system will clone this repo — centralized repos workspace
 *  (CRUCIBLE_REPOS_DIR, default <db>/repos) + the project's name; the field
 *  is display-only, nobody types a path (decision 2026-10-05: clone is the
 *  only entry, the system owns the layout). */
const reposDir = ref('');
const workspacePath = computed(() =>
  reposDir.value ? `${reposDir.value}/${edName.value.trim() || '<name>'}` : '');

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
    // repos workspace root (display-only derivation for the editor)
    try {
      const rr = await fetch('/api/settings/repos-dir');
      if (rr.ok) reposDir.value = ((await rr.json()) as { dir?: string }).dir ?? '';
    } catch { /* derivation is best-effort */ }
    // workspace states (clone status per project)
    await Promise.all(projects.value.map(async (p) => {
      try {
        const r = await fetch(`/api/projects/${p.id}/workspace`);
        if (r.ok) wsStates.value[p.id] = ((await r.json()) as { status: WsStatus }).status;
      } catch { /* status best-effort */ }
    }));
    await loadBuildConfigs();
    loaded.value = true;
  } catch { error.value = 'load failed'; }
}
onMounted(() => { void load(); void loadSuites(); });
async function loadSuites(): Promise<void> {
  try {
    const r = await fetch('/api/suites');
    if (r.ok) suites.value = ((await r.json()) as { suites?: SuiteOpt[] }).suites ?? [];
  } catch { /* editor shows none */ }
}
function onRetention(e: Event): void {
  if (!editing.value) return;
  const raw = (e.target as HTMLInputElement).value;
  const v = raw === '' ? null : Number(raw);
  editing.value = { ...editing.value, retention: v != null && Number.isFinite(v) && v >= 0 ? v : null };
  void fetch(`/api/projects/${editing.value.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ retention: editing.value.retention }) });
}
function onDefaultSuite(e: Event): void {
  if (!editing.value) return;
  const v = (e.target as HTMLSelectElement).value;
  editing.value = { ...editing.value, defaultSuiteId: v || null };
  void fetch(`/api/projects/${editing.value.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ defaultSuiteId: v }) });
}

function claimsOf(id: string): string[] {
  return (pkgOwners.value.get(id) ?? '').split(' ').filter(Boolean);
}

function startCreate(): void {
  openId.value = 'draft'; editing.value = null;
  edName.value = ''; edRepoUrl.value = ''; edBranch.value = '';
}
function startEdit(p: Project): void {
  if (openId.value === p.id) { closePanel(); return; }
  openId.value = p.id; editing.value = p;
  edName.value = p.name; edRepoUrl.value = p.repoUrl; edBranch.value = p.defaultBranch ?? '';
  // refresh workspace status when opening — the manifest block reads it
  if (!wsStates.value[p.id]) {
    void fetch(`/api/projects/${p.id}/workspace`).then(async (r) => {
      if (r.ok) wsStates.value[p.id] = ((await r.json()) as { status: WsStatus }).status;
    }).catch(() => undefined);
  }
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
    defaultBranch: edBranch.value.trim() || null,
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

function ageOf(ms: number): string {
  const d = Math.floor((Date.now() - ms) / 86_400_000);
  if (d < 1) return 'today';
  if (d < 30) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}

// ── workspace actions ──
async function cloneOrPull(p: Project): Promise<void> {
  if (wsBusy.value[p.id]) return;
  wsBusy.value[p.id] = true; error.value = '';
  const ws = wsStates.value[p.id];
  const url = ws?.exists ? `/api/projects/${p.id}/pull` : `/api/projects/${p.id}/clone`;
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const b = (await r.json()) as { ok?: boolean; error?: string };
    if (!b.ok) { error.value = b.error ?? `workspace op failed (${r.status})`; return; }
    const s = await fetch(`/api/projects/${p.id}/workspace`);
    if (s.ok) wsStates.value[p.id] = ((await s.json()) as { status: WsStatus }).status;
  } catch { error.value = 'workspace op failed'; }
  finally { wsBusy.value[p.id] = false; }
}
function wsLabel(p: Project): { text: string; title: string } {
  const ws = wsStates.value[p.id];
  if (!ws?.exists) return { text: '—', title: 'not cloned' };
  const dirty = ws.dirty ? ` · ${ws.dirty} dirty` : '';
  const m = ws.manifest;
  let mTxt = '';
  let mTitle = '';
  if (m === 'invalid') { mTxt = ' · ⚠ manifest'; mTitle = ' · lionidas.yml invalid (builds fail MANIFEST_INVALID)'; }
  else if (m) {
    const pins = [m.scheme ?? '', m.configuration ?? ''].filter(Boolean).join('/') || 'prepare only';
    mTxt = ` · ⚙ ${pins}${m.prepare.length ? ` +${m.prepare.length}prep` : ''}`;
    mTitle = ` · lionidas.yml: ${pins}${m.prepare.length ? `, prepare: ${m.prepare.join('; ')}` : ''}`;
  }
  return { text: `⎇ ${ws.branch ?? '?'}@${ws.head ?? '?'}${mTxt}`, title: `workspace at ${reposDir.value}/${p.name}${dirty}${mTitle}` };
}

const canCreate = computed(() => openId.value !== 'draft');
</script>

<template>
  <div>
    <PageHeader title="projects" desc="source repositories lionidas knows — packages and CI anchor to them · admin only">
      <template #actions>
        <button class="btn btn-primary" :disabled="!canCreate" @click="startCreate">+ project</button>
      </template>
    </PageHeader>

    <div v-if="error && !openId" class="pj-err">{{ error }}</div>

    <div class="pj-table a2-list">
      <div class="pj-thead">
        <span>project</span><span>repo</span><span>branch</span><span>auth</span><span>claims</span><span>workspace</span><span>build config</span><span>updated</span><span></span>
      </div>

      <!-- draft card — creating -->
      <article v-if="openId === 'draft'" class="pj-row-card editing">
        <div class="pj-row draft">
          <span class="pj-name pj-newname">new project</span>
          <span class="pj-repo">—</span>
          <span class="pj-br">—</span>
          <span class="pj-auth">—</span>
          <span class="pj-claims">—</span>
          <span class="pj-bc">—</span>
          <span class="pj-upd">now</span>
          <span class="pj-actions"></span>
        </div>
        <div class="pj-editor">
          <div class="ed-grid">
            <label class="ed-fld"><span>name</span><input v-model="edName" placeholder="intl" /></label>
            <label class="ed-fld"><span>repo url — required</span><input v-model="edRepoUrl" placeholder="git@github.com:org/repo.git" /></label>
            <label class="ed-fld"><span>default branch</span><input v-model="edBranch" placeholder="main" /></label>
            <label class="ed-fld ed-wide"><span>workspace path — derived</span>
              <input :value="workspacePath" readonly tabindex="-1" class="ed-readonly" />
              <span class="ed-hint">the clone lives in the centralized repos workspace — the system owns this path</span>
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
          <span class="pj-auth" :class="{ on: p.authSet }" :title="p.authSet ? 'token set — manage on the settings page' : 'no token'">{{ p.authSet ? 'token' : '—' }}</span>
          <span class="pj-claims" :title="claimsOf(p.id).join('\n') || 'no claimed packages'">{{ claimsOf(p.id).length || '—' }}</span>
          <span class="pj-ws" :title="wsLabel(p).title" :class="{ dirty: (wsStates[p.id]?.dirty ?? 0) > 0 }">{{ wsLabel(p).text }}</span>
          <span class="pj-bc" :title="bcChip(p).title"><span class="bc-dot" :class="bcChip(p).cls"></span>{{ bcChip(p).text }}</span>
          <span class="pj-upd">{{ ageOf(p.updatedAt) }}</span>
          <span class="pj-actions">
            <button class="btn btn-ghost" :disabled="wsBusy[p.id]" @click.stop="cloneOrPull(p)" :title="wsStates[p.id]?.exists ? 'fetch + reset to origin' : 'clone into the repos workspace'">{{ wsBusy[p.id] ? '…' : (wsStates[p.id]?.exists ? 'pull' : 'clone') }}</button>
          </span>
        </div>
        <div v-if="openId === p.id" class="pj-editor">
          <div class="ed-grid">
            <label class="ed-fld"><span>name</span><input v-model="edName" /></label>
            <label class="ed-fld"><span>repo url</span><input v-model="edRepoUrl" /></label>
            <label class="ed-fld"><span>default branch</span><input v-model="edBranch" /></label>
            <label class="ed-fld"><span>retention — keep last N artifacts</span>
              <input :value="editing?.retention ?? ''" type="number" min="0" placeholder="10" @change="onRetention" class="ed-num" />
            </label>
            <label class="ed-fld"><span>default suite — ▶ test preselect</span>
              <select :value="editing?.defaultSuiteId ?? ''" @change="onDefaultSuite" class="ed-select">
                <option value="">none</option>
                <option v-for="s in suites" :key="s.id" :value="s.id">{{ s.name }}</option>
              </select>
            </label>
            <label class="ed-fld ed-wide"><span>workspace path — derived</span>
              <input :value="workspacePath" readonly tabindex="-1" class="ed-readonly" />
              <span class="ed-hint">the clone lives in the centralized repos workspace — the system owns this path</span>
            </label>
          </div>
          <!-- build config onboarding (plan 20261015T021000Z): state, evidence, actions -->
          <div v-if="editing" class="ed-bc">
            <div class="ed-bc-head">
              <span class="ed-bc-title">build config</span>
              <span v-if="bcChip(editing).cls === 'ok'" class="ed-bc-state ok">✓ {{ bcChip(editing).text.slice(2) }}</span>
              <span v-else-if="bcChip(editing).cls === 'warn'" class="ed-bc-state warn">⚠ {{ bcChip(editing).text.slice(2) }}</span>
              <span v-else-if="bcChip(editing).cls === 'bad'" class="ed-bc-state bad">⛔ {{ bcChip(editing).text.slice(2) }}</span>
              <span v-else class="ed-bc-state dim">— no detection</span>
            </div>

            <!-- active config revision -->
            <div v-if="bcActive[editing.id]" class="ed-bc-active">
              <div class="ed-bc-rev">
                <span>rev {{ bcActive[editing.id]!.revision }} · {{ bcActive[editing.id]!.scheme ?? bcActive[editing.id]!.transport }}{{ bcActive[editing.id]!.configuration ? ` · ${bcActive[editing.id]!.configuration}` : '' }}</span>
                <span v-if="bcActive[editing.id]!.generated" class="ed-bc-gen" title="machine-derived — review before trusting">generated — review me</span>
                <span class="ed-bc-verdict" :class="bcActive[editing.id]!.verifyState ?? 'unverified'">
                  {{ bcActive[editing.id]!.verifyState === 'green' ? `✓ verified ${ageOf(bcActive[editing.id]!.verifiedAt ?? 0)}` : bcActive[editing.id]!.verifyState === 'failed' ? '✕ verify failed — /build-diagnose' : 'unverified' }}
                </span>
              </div>
              <div v-if="bcActive[editing.id]!.prepare.length" class="ed-bc-prep">
                <span class="ed-bc-prep-label">prepare:</span>
                <code v-for="step in bcActive[editing.id]!.prepare" :key="step.run">{{ step.run }}</code>
              </div>
            </div>

            <!-- detection report: blockers with evidence / legacy nag / derivable notes -->
            <div v-if="bcDetections[editing.id]?.state === 'blocked'" class="ed-bc-block">
              <div v-for="b in bcDetections[editing.id]!.blockers ?? []" :key="b.code + b.evidence" class="ed-bc-blocker">
                <span class="ed-bc-code">{{ b.code }}</span>
                <span class="ed-bc-detail">{{ b.detail }}</span>
                <code class="ed-bc-evid">{{ b.evidence }}</code>
              </div>
              <div class="ed-bc-hintrow">
                <span class="ed-hint">stuck? ask the chat: <code>/build-config-propose</code> — evidence-cited proposal, you confirm</span>
              </div>
            </div>
            <div v-else-if="bcDetections[editing.id]?.state === 'derivable' && !bcActive[editing.id]" class="ed-bc-derive">
              <span class="ed-hint">one app scheme found — a minimal config can be derived (marked generated; verify proves it)</span>
            </div>
            <div v-else-if="bcDetections[editing.id]?.legacy" class="ed-bc-legacy">
              <span class="ed-hint">config lives in legacy <code>.lionidas/</code> — import it into the store for worktree builds and verify</span>
            </div>

            <!-- actions -->
            <div class="ed-bc-actions">
              <button class="btn btn-ghost" :disabled="bcBusy[editing.id] === 'detect' || !wsStates[editing.id]?.exists" @click="bcDetect(editing)" title="re-run detection on the cloned workspace">{{ bcBusy[editing.id] === 'detect' ? 'detecting…' : 're-detect' }}</button>
              <button v-if="bcDetections[editing.id]?.state === 'derivable' && !bcActive[editing.id]" class="btn btn-primary" :disabled="bcBusy[editing.id] === 'derive'" @click="bcDerive(editing)" title="write the generated config revision (the only sanctioned discovery path)">{{ bcBusy[editing.id] === 'derive' ? 'deriving…' : 'derive config' }}</button>
              <button v-if="bcActive[editing.id]" class="btn btn-primary" :disabled="bcBusy[editing.id] === 'verify'" @click="bcVerify(editing)" title="compile-only verify (~minutes, no .ipa) — stamps the verdict">{{ bcBusy[editing.id] === 'verify' ? 'verifying… (minutes)' : 'verify build' }}</button>
            </div>
          </div>

          <!-- repo-declared build manifest (lionidas.yml) — repo-owned, read-only -->
          <div v-if="editing && wsStates[editing.id]?.manifestRaw != null" class="ed-manifest">
            <div class="ed-manifest-head">
              <span class="ed-manifest-title">lionidas.yml <span class="pj-manifest-note">— repo-owned · pins build inputs</span></span>
              <span v-if="wsStates[editing.id]?.manifest === 'invalid'" class="ed-manifest-bad" :title="wsStates[editing.id]?.manifestError ?? ''">⚠ invalid</span>
            </div>
            <pre class="ed-manifest-body">{{ wsStates[editing.id]?.manifestRaw }}</pre>
            <span class="ed-hint">edit this file in the repo and pull — Lionidas never writes it</span>
          </div>
          <div class="ed-foot">
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
  grid-template-columns: minmax(90px, 1fr) minmax(180px, 2.2fr) 64px 52px 52px 130px 150px 72px 64px;
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
.pj-ws { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-ash); font-size: var(--text-caption); }
.pj-ws.dirty { color: var(--color-ember); }
.pj-editor { padding: var(--s-4) 12px; background: var(--color-graphite); }
.ed-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--s-3); }
.ed-manifest { margin-top: var(--s-3); border: 1px solid var(--color-iron); background: var(--color-void); padding: var(--s-3) var(--s-4); }
.ed-manifest-head { display: flex; align-items: center; gap: var(--s-2); margin-bottom: var(--s-2); }
.ed-manifest-title { font-size: var(--text-label); color: var(--color-paper); }
.pj-manifest-note { font-size: var(--text-caption); color: var(--color-ash); }
.ed-manifest-bad { margin-left: auto; color: var(--color-ember); font-size: var(--text-caption); cursor: help; }
.ed-manifest-body { font-family: var(--font-mono); font-size: 12px; line-height: 1.6; color: var(--color-fog); white-space: pre; margin: 0 0 var(--s-2); overflow-x: auto; }
.ed-fld { display: flex; flex-direction: column; gap: 4px; }
.ed-fld > span:first-child { font-size: var(--text-caption); text-transform: uppercase; letter-spacing: 0.06em; color: var(--color-steel); }
.ed-fld input { background: var(--color-void); border: 1px solid var(--color-iron); color: var(--color-paper); font-family: var(--font-mono); font-size: var(--text-label); padding: 6px 8px; width: 100%; }
input.ed-readonly { color: var(--color-ash); }
input.ed-num { -moz-appearance: textfield; }
input.ed-num::-webkit-outer-spin-button, input.ed-num::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.ed-select { background: var(--color-void); border: 1px solid var(--color-iron); color: var(--color-paper); font-family: var(--font-mono); font-size: var(--text-label); padding: 6px 8px; width: 100%; }
.ed-wide { grid-column: 1 / -1; }
.ed-hint { font-size: var(--text-caption); color: var(--color-steel); }
.ed-foot { display: flex; align-items: center; gap: var(--s-2); margin-top: var(--s-4); }
.ed-err { color: var(--color-ember); font-size: var(--text-caption); }
.pj-spacer { flex: 1; }
.pj-empty { padding: var(--s-5); color: var(--color-ash); font-size: var(--text-label); }
.pj-err { color: var(--color-ember); font-size: var(--text-label); margin-bottom: var(--s-3); }

/* ── build-config chip + panel (plan 20261015T021000Z S3/S4) ── */
.pj-bc { font-size: var(--text-caption); color: var(--color-paper); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; gap: 6px; }
.bc-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.bc-dot.ok { background: #7dc98f; }
.bc-dot.warn { background: #e5c07b; }
.bc-dot.bad { background: #e06c75; }
.bc-dot.dim { background: var(--color-steel); opacity: .5; }
.ed-bc { border: 1px solid var(--ag-line); border-radius: var(--r-sm); background: var(--ag-surface); padding: 10px 12px; margin: 10px 0 0; display: flex; flex-direction: column; gap: 8px; }
.ed-bc-head { display: flex; align-items: baseline; gap: 10px; }
.ed-bc-title { font-family: var(--font-mono); font-size: var(--text-caption); font-weight: var(--weight-bold); text-transform: uppercase; letter-spacing: .06em; color: var(--color-steel); }
.ed-bc-state { font-family: var(--font-mono); font-size: var(--text-caption); }
.ed-bc-state.ok { color: #7dc98f; }
.ed-bc-state.warn { color: #e5c07b; }
.ed-bc-state.bad { color: #e06c75; }
.ed-bc-state.dim { color: var(--color-steel); }
.ed-bc-active { display: flex; flex-direction: column; gap: 4px; }
.ed-bc-rev { display: flex; align-items: center; gap: 10px; font-family: var(--font-mono); font-size: var(--text-caption); flex-wrap: wrap; }
.ed-bc-gen { color: #e5c07b; border: 1px dashed #e5c07b66; border-radius: 4px; padding: 0 6px; font-size: 10.5px; }
.ed-bc-verdict { margin-left: auto; }
.ed-bc-verdict.green { color: #7dc98f; }
.ed-bc-verdict.failed { color: #e06c75; }
.ed-bc-verdict.unverified { color: var(--color-steel); }
.ed-bc-prep { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 11px; }
.ed-bc-prep-label { color: var(--color-steel); }
.ed-bc-prep code { background: var(--ag-panel); border: 1px solid var(--ag-line); border-radius: 4px; padding: 1px 6px; font-size: 10.5px; color: var(--color-paper); }
.ed-bc-block { display: flex; flex-direction: column; gap: 4px; }
.ed-bc-blocker { display: grid; grid-template-columns: 140px 1fr auto; gap: 8px; align-items: baseline; font-size: 11px; }
.ed-bc-code { font-family: var(--font-mono); color: #e06c75; font-weight: var(--weight-bold); }
.ed-bc-detail { color: var(--color-paper); }
.ed-bc-evid { color: var(--color-steel); background: var(--ag-panel); border-radius: 4px; padding: 0 5px; font-size: 10px; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ed-bc-hintrow { margin-top: 2px; }
.ed-bc-hintrow code { background: var(--ag-panel); border: 1px solid var(--ag-line); border-radius: 4px; padding: 0 5px; }
.ed-bc-actions { display: flex; gap: 8px; margin-top: 2px; }
</style>
