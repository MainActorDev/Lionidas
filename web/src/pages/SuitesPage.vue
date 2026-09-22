<script setup lang="ts">
/** /suites — the test-cases anatomy (011 option-1), preview-first.
 *  Row click opens a READ-ONLY preview (per-member latest status, markers);
 *  edit is an explicit button that swaps the panel to the editor. Suite
 *  verdicts are suite-scoped reads; markers name the gap between the last
 *  play and the current pack. */
import PageHeader from '../components/PageHeader.vue';
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { RouterLink } from 'vue-router';

interface Member {
  templateId: string;
  variantIds: string[] | null;
  position: number;
  lastRunId: string | null;
  lastStatus: string | null;
  lastBlocked: number;
  lastFinishedAt: number | null;
  lastAppVersion: string | null;
  trend: string | null;
  totalRuns: number;
  name?: string | null;
  appBundleId?: string | null;
  variantVocab?: string[];
  stale?: boolean;
  staleVariants?: string[];
}
interface LastPlay { at: number | null; runIds: string[]; membersChanged: boolean }
interface Suite {
  id: string; name: string; description: string | null; appBundleId: string | null;
  createdBy: string; createdAt: number; updatedAt: number;
  members?: Member[]; memberCount?: number;
  lastPlay?: LastPlay; running?: boolean;
}

const suites = ref<Suite[]>([]);
const loading = ref(true);
const error = ref('');
const filter = ref('');
const filterEl = ref<HTMLInputElement | null>(null);
const running = ref<string | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const r = await fetch('/api/suites');
    const b = (await r.json()) as { suites: Suite[] };
    suites.value = b.suites ?? [];
    error.value = '';
  } catch {
    error.value = 'failed to load suites';
  } finally { loading.value = false; }
}
onMounted(() => { void load(); });

// ── filter + ⌘F (the cases-page motion) ──
function shown(): Suite[] {
  const f = filter.value.trim().toLowerCase();
  if (!f) return suites.value;
  return suites.value.filter((s) =>
    s.name.toLowerCase().includes(f) || (s.appBundleId ?? '').toLowerCase().includes(f));
}
function onKey(ev: KeyboardEvent): void {
  if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'f') {
    ev.preventDefault();
    filterEl.value?.focus();
  }
}
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));

// ── verdict — live rollup over members (worst wins) ──
type Kind = 'never' | 'green' | 'red' | 'blocked';
function kind(s: Suite): Kind {
  const ms = s.members ?? [];
  if (ms.every((m) => m.lastStatus == null)) return 'never';
  if (ms.some((m) => m.lastStatus != null && m.lastStatus !== 'passed' && m.lastBlocked !== 1)) return 'red';
  if (ms.some((m) => m.lastBlocked === 1)) return 'blocked';
  return 'green';
}
function statusClass(s: Suite): string {
  const k = kind(s);
  return k === 'green' ? 'status-pass' : k === 'red' ? 'status-fail' : k === 'blocked' ? 'status-blocked' : 'status-none';
}
function verdictLabel(s: Suite): string {
  const k = kind(s);
  const ms = s.members ?? [];
  const pass = ms.filter((m) => m.lastStatus === 'passed').length;
  const fail = ms.filter((m) => m.lastStatus != null && m.lastStatus !== 'passed').length;
  const last = ms.reduce<number | null>((a, m) => (m.lastFinishedAt != null && (a == null || m.lastFinishedAt > a) ? m.lastFinishedAt : a), null);
  if (k === 'never') return 'never run';
  const lbl = k === 'green' ? `pass ${pass}/${ms.length}` : k === 'blocked' ? 'blocked' : `fail ${fail}/${ms.length}`;
  return `${lbl} · ${ago(last)}`;
}
function driftCount(s: Suite): number {
  if (!s.appBundleId) return 0;
  return (s.members ?? []).filter((m) => m.appBundleId != null && m.appBundleId !== s.appBundleId).length;
}
const summary = computed(() => {
  const ks = suites.value.map(kind);
  return { total: ks.length, green: ks.filter((k) => k === 'green').length, red: ks.filter((k) => k === 'red' || k === 'blocked').length };
});

function ago(ts: number | null): string {
  if (ts == null) return '';
  const d = Date.now() - ts;
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}
function shortBundle(b: string | null): string {
  return b ?? '—';
}

// ── panel — preview (read) below the row; edit is explicit ──
const openId = ref<string | null>(null); // suite id or 'draft'
const mode = ref<'preview' | 'edit'>('preview');

function togglePanel(s: Suite): void {
  if (openId.value === s.id) { openId.value = null; return; }
  if (openId.value !== null && mode.value === 'edit' && isDirty() && !window.confirm('discard unsaved changes?')) return;
  openId.value = s.id;
  mode.value = 'preview';
}
function closePanel(): void {
  openId.value = null; editing.value = null; mode.value = 'preview';
}
function startEdit(s: Suite): void {
  if (s.running) return;
  editing.value = s;
  editorName.value = s.name;
  editorBundle.value = s.appBundleId ?? '';
  editorMembers.value = s.members ? s.members.map((m) => ({ templateId: m.templateId, variantIds: m.variantIds })) : [];
  mode.value = 'edit';
  void refreshAllCases().then(() => { snapshot = JSON.stringify({ n: editorName.value, b: editorBundle.value, m: editorMembers.value }); });
}
/** row 'edit' button — opens edit directly (empty suite skips preview) */
function startEditFromRow(s: Suite): void {
  if ((s.members?.length ?? 0) === 0) { openId.value = s.id; startEdit(s); return; }
  if (openId.value !== s.id) { openId.value = s.id; mode.value = 'preview'; }
  startEdit(s);
}

function memberVerdictPill(m: Member): { cls: string; label: string } {
  if (m.lastStatus === 'passed') return { cls: 'status-pass', label: 'pass' };
  if (m.lastStatus == null) return { cls: 'status-none', label: 'never' };
  if (m.lastBlocked === 1) return { cls: 'status-blocked', label: 'blocked' };
  if (m.lastStatus === 'aborted') return { cls: 'status-aborted', label: 'aborted' };
  return { cls: 'status-fail', label: 'fail' };
}
function memberMarkers(m: Member, s: Suite): string[] {
  const out: string[] = [];
  if (m.appBundleId != null && s.appBundleId != null && m.appBundleId !== s.appBundleId) out.push('drift');
  if (m.stale) out.push('stale');
  if ((m.staleVariants ?? []).length > 0) out.push(`ghost: ${(m.staleVariants ?? []).join(',')}`);
  return out;
}

// ── editor state (mode='edit') ──
const editing = ref<Suite | null>(null); // null = creating
const editorName = ref('');
const editorBundle = ref('');
const editorMembers = ref<Array<{ templateId: string; variantIds: string[] | null }>>([]);
const allCases = ref<Array<{ id: string; name: string; bundle: string | null; variantVocab: string[] }>>([]);
const busy = ref(false);
let snapshot = '';

const bundleOptions = computed(() => Array.from(new Set(allCases.value.filter((c) => c.bundle).map((c) => c.bundle as string))));
const scopedCases = computed(() => {
  if (!editorBundle.value) return [];
  const picked = new Set(editorMembers.value.map((m) => m.templateId));
  return allCases.value.filter((c) => c.bundle === editorBundle.value && !picked.has(c.id));
});
const editorRows = computed(() => editorMembers.value.map((m) => ({ ...m, case: allCases.value.find((c) => c.id === m.templateId) })));
const bundleCases = computed(() => allCases.value.filter((c) => c.bundle === editorBundle.value));

async function refreshAllCases(): Promise<void> {
  const r = await fetch('/api/templates');
  const b = (await r.json()) as { templates: Array<{ id: string; name: string; appBundleId: string | null; variants?: string[] | null }> };
  allCases.value = b.templates.map((t) => ({ id: t.id, name: t.name, bundle: t.appBundleId, variantVocab: t.variants ?? [] }));
}

function isDirty(): boolean {
  return JSON.stringify({ n: editorName.value, b: editorBundle.value, m: editorMembers.value }) !== snapshot;
}

async function openDraft(): Promise<void> {
  if (openId.value !== null && mode.value === 'edit' && isDirty() && !window.confirm('discard unsaved changes?')) return;
  editing.value = null;
  editorName.value = '';
  editorBundle.value = '';
  editorMembers.value = [];
  openId.value = 'draft';
  mode.value = 'edit';
  await refreshAllCases();
  snapshot = JSON.stringify({ n: editorName.value, b: editorBundle.value, m: editorMembers.value });
}

async function run(id: string): Promise<void> {
  running.value = id;
  error.value = '';
  try {
    const r = await fetch(`/api/suites/${id}/play`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
    if (!r.ok) {
      const b = (await r.json().catch(() => ({}))) as { error?: string };
      error.value = b.error ?? `play failed (${r.status})`;
    } else { await load(); }
  } finally { running.value = null; }
}

async function remove(id: string): Promise<void> {
  if (!window.confirm('delete this suite? runs it spawned survive.')) return;
  await fetch(`/api/suites/${id}`, { method: 'DELETE' });
  if (openId.value === id) closePanel();
  await load();
}

function addMember(): void {
  const c = scopedCases.value[0];
  if (c) editorMembers.value.push({ templateId: c.id, variantIds: null });
}
function removeMember(i: number): void { editorMembers.value.splice(i, 1); }
function moveMember(i: number, dir: -1 | 1): void {
  const j = i + dir;
  if (j < 0 || j >= editorMembers.value.length) return;
  const list = editorMembers.value;
  const a = list[i]!;
  list[i] = list[j]!;
  list[j] = a;
}
function onBundleChange(): void {
  if (editing.value) return;
  editorMembers.value = editorMembers.value.filter((m) => allCases.value.find((c) => c.id === m.templateId)?.bundle === editorBundle.value);
}
function setMemberCase(i: number, tid: string): void {
  const m = editorMembers.value[i];
  if (!m) return;
  m.templateId = tid;
  m.variantIds = null;
}
function toggleVariant(tid: string, vid: string): void {
  const m = editorMembers.value.find((x) => x.templateId === tid);
  if (!m) return;
  if (m.variantIds == null) m.variantIds = [...(allCases.value.find((c) => c.id === tid)?.variantVocab ?? [])];
  const i = m.variantIds.indexOf(vid);
  if (i >= 0) m.variantIds.splice(i, 1); else m.variantIds.push(vid);
  if (m.variantIds.length === 0) m.variantIds = null;
}

async function saveEditor(): Promise<void> {
  if (!editorName.value.trim() || !editorBundle.value) return;
  busy.value = true;
  error.value = '';
  try {
    const body = JSON.stringify({
      name: editorName.value,
      description: editing.value?.description ?? null,
      appBundleId: editorBundle.value || undefined,
      members: editorMembers.value,
    });
    const r = editing.value
      ? await fetch(`/api/suites/${editing.value.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body })
      : await fetch('/api/suites', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    if (!r.ok) {
      const b = (await r.json().catch(() => ({}))) as { error?: string };
      error.value = b.error ?? `save failed (${r.status})`;
      return;
    }
    openId.value = null; editing.value = null; mode.value = 'preview';
    await load();
  } finally { busy.value = false; }
}
</script>

<template>
  <section class="su-page">
    <PageHeader title="suites">
      <span class="ph-desc">{{ suites.length }} suite{{ suites.length === 1 ? '' : 's' }} · {{ bundleOptions.length || suites.length }} app{{ suites.length === 1 ? '' : 's' }}</span>
      <span v-if="!loading && suites.length" class="ph-syms" :title="`${summary.green} passing · ${summary.red} failing`">
        <span class="sym" title="passing">✓{{ summary.green }}</span>
        <span v-if="summary.red" class="sym" title="failing">✕{{ summary.red }}</span>
      </span>
      <template #actions>
        <input ref="filterEl" v-model="filter" class="su-search" placeholder="search suites…  ⌘F" />
        <button class="btn" @click="openDraft()">+ suite</button>
      </template>
    </PageHeader>

    <div v-if="error" class="su-err">{{ error }}</div>

    <div class="su-table">
      <div class="su-thead">
        <span>suite</span><span>app</span><span>members</span><span>updated</span><span>verdict</span><span></span>
      </div>

      <!-- draft card — creating -->
      <article v-if="openId === 'draft'" class="su-row-card editing">
        <div class="su-row draft">
          <span class="su-name su-newname">new suite</span>
          <span class="su-bundle">—</span>
          <span class="su-members">0</span>
          <span class="su-updated">now</span>
          <span><span class="status status-none">never run</span></span>
          <span class="su-actions"></span>
        </div>
        <div class="su-editor">
          <div class="ed-head">
            <input v-model="editorName" class="ed-name" placeholder="suite name" />
            <select v-model="editorBundle" class="ed-scope" @change="onBundleChange" title="a suite is one app's pack — cases from this app only">
              <option value="" disabled>app…</option>
              <option v-for="b in bundleOptions" :key="b" :value="b">{{ b }}</option>
            </select>
            <button class="btn btn-sm btn-ghost" @click="closePanel()">✕</button>
          </div>
          <div v-if="editorBundle" class="ed-body">
            <div v-for="(m, i) in editorRows" :key="i" class="ed-mem">
              <span class="ed-pos">{{ i + 1 }}</span>
              <select class="ed-case" :value="m.templateId" @change="setMemberCase(i, ($event.target as HTMLSelectElement).value)">
                <option v-for="c in bundleCases" :key="c.id" :value="c.id">{{ c.name }}</option>
              </select>
              <span class="ed-chips">
                <button v-for="v in m.case?.variantVocab ?? []" :key="v" class="ed-v"
                  :class="{ on: m.variantIds == null || m.variantIds.includes(v) }"
                  :title="m.variantIds == null ? 'all variants (default)' : (m.variantIds.includes(v) ? 'in subset' : 'off — all off reverts to all')"
                  @click="toggleVariant(m.templateId, v)">{{ v }}</button>
              </span>
              <span class="ed-ops">
                <button class="btn btn-sm btn-ghost" :disabled="i === 0" @click="moveMember(i, -1)">↑</button>
                <button class="btn btn-sm btn-ghost" :disabled="i === editorRows.length - 1" @click="moveMember(i, 1)">↓</button>
                <button class="btn btn-sm btn-ghost" @click="removeMember(i)">✕</button>
              </span>
            </div>
            <button class="ed-add" :disabled="scopedCases.length === 0" @click="addMember">+ member</button>
          </div>
          <div class="ed-foot">
            <span v-if="error" class="ed-err">{{ error }}</span>
            <span class="su-spacer"></span>
            <button class="btn btn-ghost" @click="closePanel()">cancel</button>
            <button class="btn btn-primary" :disabled="busy || !editorName.trim() || !editorBundle" @click="saveEditor()">{{ busy ? 'saving…' : 'save' }}</button>
          </div>
        </div>
      </article>

      <article v-for="s in shown()" :key="s.id" class="su-row-card" :class="{ editing: openId === s.id }">
        <div class="su-row" @click="togglePanel(s)" :title="openId === s.id ? 'click to collapse' : 'click to preview members'">
          <span class="su-name">{{ s.name }}</span>
          <span class="su-bundle" :title="s.appBundleId ?? 'no app'">{{ shortBundle(s.appBundleId) }}</span>
          <span class="su-members" :title="`${s.members?.length ?? s.memberCount ?? 0} members`">
            {{ s.members?.length ?? s.memberCount ?? 0 }}
            <span v-if="driftCount(s)" class="su-drift" :title="`${driftCount(s)} member(s) drifted out of ${s.appBundleId} — skipped at play`">drift</span>
          </span>
          <span class="su-updated" :title="new Date(s.updatedAt).toLocaleString()">{{ ago(s.updatedAt) }}</span>
          <span class="su-verdict">
            <span v-if="s.running" class="status status-running">running</span>
            <span v-else :class="`status ${statusClass(s)}`">{{ verdictLabel(s) }}</span>
            <span v-if="s.lastPlay?.membersChanged" class="status status-changes-pending" title="membership edited after the last play — run to refresh">members changed</span>
          </span>
          <span class="su-actions" @click.stop>
            <button class="btn btn-sm" :disabled="running === s.id" @click.stop="run(s.id)" title="play every member, in order">{{ running === s.id ? 'starting…' : 'run' }}</button>
            <button class="btn btn-sm btn-ghost" @click.stop="startEditFromRow(s)" :disabled="s.running" :title="s.running ? 'suite is running' : 'edit members'">edit</button>
            <button class="btn btn-sm btn-ghost" @click.stop="remove(s.id)">delete</button>
          </span>
        </div>

        <!-- panel opens INLINE below the row: preview (read) or edit -->
        <div v-if="openId === s.id" class="su-editor">
          <!-- preview mode -->
          <div v-if="mode === 'preview'" class="pv-panel">
            <div class="pv-head">
              <span class="pv-title">{{ s.name }}</span>
              <span class="ed-lock" :title="`scope locked at creation — ${s.appBundleId ?? 'none'}`">{{ shortBundle(s.appBundleId) }} 🔒</span>
              <span v-if="s.lastPlay?.at != null" class="pv-last" :title="`${s.lastPlay.runIds.length} runs in the last play`">last play {{ ago(s.lastPlay.at) }}</span>
              <span v-if="s.lastPlay?.membersChanged" class="status status-changes-pending" title="membership edited after the last play — run to refresh">members changed</span>
              <span class="su-spacer"></span>
              <RouterLink class="ed-runs" :to="{ path: '/runs', query: { suite: s.id } }">runs</RouterLink>
              <button class="btn btn-sm btn-ghost" @click="closePanel()">✕</button>
            </div>
            <div class="pv-body">
              <div v-if="(s.members?.length ?? 0) === 0" class="pv-empty">no members</div>
              <div v-for="(m, i) in s.members ?? []" :key="m.templateId" class="pv-mem" :data-tpl="m.templateId">
                <span class="ed-pos">{{ i + 1 }}</span>
                <span class="pv-name" :title="m.templateId">{{ m.name ?? m.templateId }}</span>
                <span class="pv-variants" :title="m.variantIds ? 'pinned subset' : 'all variants (default)'">{{ m.variantIds ? m.variantIds.join(' · ') : 'all' }}</span>
                <span :class="['status', memberVerdictPill(m).cls]">{{ memberVerdictPill(m).label }}</span>
                <span class="pv-ago">{{ m.lastFinishedAt != null ? ago(m.lastFinishedAt) : '' }}</span>
                <span v-for="mk in memberMarkers(m, s)" :key="mk" class="su-drift" :title="mk.startsWith('ghost') ? 'pinned variants deleted from the case — skipped at play' : mk === 'stale' ? 'case edited since this play — run to refresh' : 'member bundle drifted out of the suite scope'">{{ mk }}</span>
                <RouterLink v-if="m.lastRunId" class="ed-runs" :to="`/runs/${m.lastRunId}`">run</RouterLink>
              </div>
            </div>
          </div>

          <!-- edit mode -->
          <div v-else class="ed-panel">
            <div class="ed-head">
              <input v-model="editorName" class="ed-name" />
              <span class="ed-lock" :title="`scope locked at creation — ${editorBundle}`">{{ shortBundle(editorBundle) }} 🔒</span>
              <span class="su-spacer"></span>
              <RouterLink class="ed-runs" :to="{ path: '/runs', query: { suite: s.id } }">runs</RouterLink>
              <button class="btn btn-sm btn-ghost" @click="closePanel()">✕</button>
            </div>
            <div class="ed-body">
              <div v-for="(m, i) in editorRows" :key="m.templateId" class="ed-mem" :class="{ drifted: editing?.appBundleId != null && m.case && m.case.bundle !== editing?.appBundleId }">
                <span class="ed-pos">{{ i + 1 }}</span>
                <select class="ed-case" :value="m.templateId" @change="setMemberCase(i, ($event.target as HTMLSelectElement).value)">
                  <option v-for="c in bundleCases" :key="c.id" :value="c.id">{{ c.name }}</option>
                </select>
                <span class="ed-chips">
                  <button v-for="v in m.case?.variantVocab ?? []" :key="v" class="ed-v"
                    :class="{ on: m.variantIds == null || m.variantIds.includes(v) }"
                    :title="m.variantIds == null ? 'all variants (default)' : (m.variantIds.includes(v) ? 'in subset' : 'off — all off reverts to all')"
                    @click="toggleVariant(m.templateId, v)">{{ v }}</button>
                  <span v-if="editing?.appBundleId != null && m.case && m.case.bundle !== editing?.appBundleId" class="su-drift">drifted</span>
                </span>
                <span class="ed-ops">
                  <button class="btn btn-sm btn-ghost" :disabled="i === 0" @click="moveMember(i, -1)">↑</button>
                  <button class="btn btn-sm btn-ghost" :disabled="i === editorRows.length - 1" @click="moveMember(i, 1)">↓</button>
                  <button class="btn btn-sm btn-ghost" @click="removeMember(i)">✕</button>
                </span>
              </div>
              <button class="ed-add" :disabled="scopedCases.length === 0" @click="addMember">+ member</button>
            </div>
            <div class="ed-foot">
              <span v-if="error" class="ed-err">{{ error }}</span>
              <span class="su-spacer"></span>
              <button class="btn btn-ghost" @click="closePanel()">cancel</button>
              <button class="btn btn-primary" :disabled="busy || !editorName.trim()" @click="saveEditor()">{{ busy ? 'saving…' : 'save' }}</button>
            </div>
          </div>
        </div>
      </article>

      <div v-if="!loading && shown().length === 0 && openId !== 'draft'" class="su-empty">
        {{ filter ? 'no matches' : 'no suites — + suite' }}
      </div>
    </div>
  </section>
</template>

<style scoped>
/* header removed — PageHeader owns it; spacer still used by suite panels */
.su-spacer { flex: 1; }
.su-page { display: flex; flex-direction: column; gap: var(--s-3); width: 100%; box-sizing: border-box; }
.su-search {
  background: var(--color-carbon); border: 1px solid var(--color-iron); border-radius: var(--r-sm);
  color: var(--color-fog); font: inherit; font-size: 12px; padding: 4px 10px; width: 220px;
}
.su-search:focus { outline: none; border-color: var(--color-ember); }
.su-err { color: var(--color-paper); border: 1px dashed var(--color-slate); padding: var(--s-2) var(--s-3); font-size: 11px; }

/* table — own scroll region, sticky head */
.su-table {
  flex: 0 1 auto; overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain;
  border: 1px solid var(--color-iron); border-radius: var(--r-sm); background: var(--color-carbon);
}
.su-thead, .su-row {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 150px) minmax(0, 92px) minmax(0, 1.2fr) minmax(0, 170px);
  gap: var(--s-2); align-items: center;
}
.su-thead {
  position: sticky; top: 0; z-index: 2; background: var(--color-graphite);
  padding: 8px 12px; font-size: 10px; color: var(--color-steel); text-transform: uppercase; letter-spacing: 0.08em;
}
.su-row-card { border-bottom: 1px solid var(--color-iron); }
.su-row-card.editing { border-color: var(--color-ember); }
.su-row-card.editing .su-row { background: color-mix(in srgb, var(--color-ember) 6%, transparent); }
.su-row { padding: 8px 12px; min-height: 44px; cursor: pointer; }
.su-row:hover { background: var(--color-graphite); }
.su-row.draft { cursor: default; }
.su-name { color: var(--color-paper); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.su-newname { color: var(--color-ash); font-style: italic; }
.su-bundle { color: var(--color-fog); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.su-members { color: var(--color-fog); font-size: 12px; white-space: nowrap; overflow: hidden; display: flex; align-items: center; gap: 6px; }
.su-drift { color: var(--color-paper); border: 1px dashed var(--color-paper); padding: 0 4px; font-size: 10px; margin-left: 4px; }
.su-updated { color: var(--color-fog); font-size: 12px; }
.su-verdict { display: flex; align-items: center; gap: var(--s-2); overflow: hidden; }
.su-actions { display: flex; gap: 4px; justify-content: flex-end; }
.su-empty { color: var(--color-steel); text-align: center; padding: var(--s-7) 0; font-size: 12px; }

/* panel — preview + editor, the yaml-panel slot below the row */
.su-editor { margin: 0 var(--s-2) var(--s-2); border: 1px solid var(--color-slate); border-radius: var(--r-sm); background: var(--color-graphite); }
.pv-head, .ed-head { display: flex; align-items: center; gap: var(--s-2); padding: var(--s-2) var(--s-3); border-bottom: 1px solid var(--color-iron); }
.pv-title { color: var(--color-paper); font-size: 13px; font-weight: 600; }
.pv-last { color: var(--color-steel); font-size: 11px; }
.pv-body { padding: var(--s-3); }
.pv-mem { display: flex; align-items: center; gap: var(--s-2); padding: var(--s-2); border: 1px solid var(--color-iron); border-radius: var(--r-sm); margin-bottom: 6px; background: var(--color-carbon); }
.pv-name { color: var(--color-paper); font-size: 12px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pv-variants { color: var(--color-steel); font-size: 11px; flex: none; }
.pv-ago { color: var(--color-steel); font-size: 11px; width: 64px; text-align: right; flex: none; }
.pv-empty { color: var(--color-steel); font-size: 12px; padding: var(--s-3); }
.pv-empty a { color: var(--color-fog); cursor: pointer; text-decoration: underline; }
.ed-name { background: var(--color-void); border: 1px solid var(--color-iron); border-radius: var(--r-sm); color: var(--color-paper); font: inherit; font-size: 13px; padding: 4px 8px; width: 240px; }
.ed-name:focus { outline: none; border-color: var(--color-ember); }
.ed-scope {
  background: var(--color-void); border: 1px solid var(--color-iron); border-radius: var(--r-sm);
  color: var(--color-fog); font: inherit; font-size: 12px; padding: 4px 8px; max-width: 300px;
}
.ed-lock { color: var(--color-ash); font-size: 11px; border: 1px solid var(--color-iron); border-radius: var(--r-sm); padding: 2px 8px; white-space: nowrap; }
.ed-runs { color: var(--color-steel); font-size: 11px; text-decoration: none; border-bottom: 1px dotted var(--color-pewter); }
.ed-runs:hover { color: var(--color-fog); }
.ed-body { padding: var(--s-3); }
.ed-mem { display: flex; align-items: center; gap: var(--s-2); padding: var(--s-2); border: 1px solid var(--color-iron); border-radius: var(--r-sm); margin-bottom: 6px; background: var(--color-carbon); }
.ed-mem.drifted { border-style: dashed; border-color: var(--color-paper); }
.ed-pos { color: var(--color-steel); font-size: 11px; width: 16px; text-align: right; flex: none; }
.ed-case {
  background: var(--color-void); border: 1px solid var(--color-slate); border-radius: var(--r-sm);
  color: var(--color-paper); font: inherit; font-size: 12px; padding: 4px 6px; flex: 1; min-width: 0;
}
.ed-chips { display: flex; gap: 4px; flex: none; align-items: center; }
.ed-v { font: inherit; font-size: 10px; color: var(--color-steel); background: none; border: 1px dashed var(--color-slate); border-radius: var(--r-sm); padding: 1px 7px; cursor: pointer; }
.ed-v.on { color: var(--color-paper); border-style: solid; }
.ed-ops { display: flex; gap: 2px; flex: none; }
.ed-add { width: 100%; border: 1px dashed var(--color-slate); border-radius: var(--r-sm); background: none; color: var(--color-ash); font: inherit; font-size: 12px; padding: var(--s-2); cursor: pointer; }
.ed-add:hover:not(:disabled) { color: var(--color-paper); border-color: var(--color-chalk); }
.ed-add:disabled { opacity: 0.4; cursor: default; }
.ed-foot { display: flex; align-items: center; gap: var(--s-2); padding: var(--s-2) var(--s-3); border-top: 1px solid var(--color-iron); }
.ed-err { color: var(--color-paper); font-size: 11px; }
</style>
