<script setup lang="ts">
/** Phase D T6 — /suites: sidebar rail + detail board (010 option-1 pick).
 *  Verdicts are live reads via the API's computed rollups — nothing stored.
 *  Bundle scope: a suite IS one app's pack — members filtered to the
 *  suite's app_bundle_id server-side; rail groups suites under bundles. */
import { ref, computed } from 'vue';
import { useRouter } from 'vue-router';

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
  /** joined at read time by the API — name/app/vocab for render */
  name?: string | null;
  appBundleId?: string | null;
  variantVocab?: string[];
}
interface Suite {
  id: string; name: string; description: string | null; appBundleId: string | null;
  createdBy: string; createdAt: number; updatedAt: number;
  members?: Member[];
  memberCount?: number;
}

const router = useRouter();
const suites = ref<Suite[]>([]);
const selectedId = ref<string | null>(null);
const detail = ref<Suite | null>(null);
const running = ref<string | null>(null);
const busy = ref(false);
const err = ref<string | null>(null);
const showEditor = ref(false);
const editing = ref<Suite | null>(null);
const editorName = ref('');
const editorDesc = ref('');
const editorBundle = ref<string>('');
const editorMembers = ref<Array<{ templateId: string; variantIds: string[] | null }>>([]);
const allCases = ref<Array<{ id: string; name: string; bundle: string | null; variantVocab: string[] }>>([]);
/** distinct bundles with ≥1 case — the scope dropdown's options */
const bundleOptions = computed(() => Array.from(new Set(allCases.value.filter((c) => c.bundle).map((c) => c.bundle as string))));

const ago = (ts: number | null): string => {
  if (ts == null) return 'never';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

async function load(): Promise<void> {
  const r = await fetch('/api/suites');
  const b = (await r.json()) as { suites: Suite[] };
  suites.value = b.suites;
}

async function select(id: string): Promise<void> {
  selectedId.value = id;
  const r = await fetch(`/api/suites/${id}`);
  detail.value = r.ok ? ((await r.json()) as Suite) : null;
}

function rollup(members: Member[] | undefined): { pass: number; fail: number; never: number; lastAt: number | null; lastRunId: string | null } {
  if (!members) return { pass: 0, fail: 0, never: 0, lastAt: null, lastRunId: null };
  let pass = 0, fail = 0, never = 0, lastAt: number | null = null, lastRunId: string | null = null;
  for (const m of members) {
    if (m.lastStatus === 'passed') pass++;
    else if (m.lastStatus != null) fail++;
    else never++;
    if (m.lastFinishedAt != null && (lastAt == null || m.lastFinishedAt > lastAt)) { lastAt = m.lastFinishedAt; lastRunId = m.lastRunId; }
  }
  return { pass, fail, never, lastAt, lastRunId };
}

const detailRollup = computed(() => rollup(detail.value?.members));

/** rail grouping: suites under their bundle, unscoped (legacy NULL) last */
const railGroups = computed(() => {
  const groups: Array<{ bundle: string | null; label: string; items: Suite[] }> = [];
  for (const s of suites.value) {
    const g = groups.find((x) => x.bundle === s.appBundleId);
    if (g) g.items.push(s);
    else groups.push({ bundle: s.appBundleId, label: s.appBundleId ?? 'no app — legacy', items: [s] });
  }
  return groups;
});

async function run(id: string): Promise<void> {
  running.value = id;
  err.value = null;
  try {
    const r = await fetch(`/api/suites/${id}/play`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
    if (!r.ok) {
      const b = (await r.json().catch(() => ({ error: 'play failed' }))) as { error?: string };
      err.value = b.error ?? `play failed (${r.status})`;
    }
  } finally {
    running.value = null;
  }
}

async function remove(id: string): Promise<void> {
  if (!window.confirm('delete this suite? runs it spawned survive (they keep their suite stamp).')) return;
  await fetch(`/api/suites/${id}`, { method: 'DELETE' });
  if (selectedId.value === id) { selectedId.value = null; detail.value = null; }
  await load();
}

async function openEditor(s: Suite | null): Promise<void> {
  editing.value = s;
  editorName.value = s?.name ?? '';
  editorDesc.value = s?.description ?? '';
  editorBundle.value = s?.appBundleId ?? '';
  editorMembers.value = s?.members ? s.members.map((m) => ({ templateId: m.templateId, variantIds: m.variantIds })) : [];
  const tpl = await fetch('/api/templates');
  const b = (await tpl.json()) as { templates: Array<{ id: string; name: string; appBundleId: string | null; variants?: string[] | null }> };
  allCases.value = b.templates.map((t) => ({
    id: t.id, name: t.name, bundle: t.appBundleId,
    variantVocab: t.variants ?? [],
  }));
  showEditor.value = true;
}

/** cases visible to this editor session: bundle-scoped, minus already-picked */
const scopedCases = computed(() => {
  if (!editorBundle.value) return [];
  const picked = new Set(editorMembers.value.map((m) => m.templateId));
  return allCases.value.filter((c) => c.bundle === editorBundle.value && !picked.has(c.id));
});

const editorRows = computed(() => editorMembers.value.map((m) => ({
  ...m,
  case: allCases.value.find((c) => c.id === m.templateId),
})));

function addMember(): void {
  const c = scopedCases.value[0];
  if (c) editorMembers.value.push({ templateId: c.id, variantIds: null });
}

function removeMember(i: number): void {
  editorMembers.value.splice(i, 1);
}

function moveMember(i: number, dir: -1 | 1): void {
  const j = i + dir;
  if (j < 0 || j >= editorMembers.value.length) return;
  const list = editorMembers.value;
  const a = list[i]!;
  list[i] = list[j]!;
  list[j] = a;
}

/** switching scope on create (draft) drops members that no longer fit;
 *  on edit the scope is immutable — the select is disabled */
function onBundleChange(): void {
  if (editing.value) return;
  editorMembers.value = editorMembers.value.filter((m) => allCases.value.find((c) => c.id === m.templateId)?.bundle === editorBundle.value || editorBundle.value === '');
}

function setMemberCase(i: number, tid: string): void {
  const m = editorMembers.value[i];
  if (!m) return;
  m.templateId = tid;
  m.variantIds = null; // new case → variant subset reset to default (all)
}

function toggleVariant(tid: string, vid: string): void {
  const m = editorMembers.value.find((x) => x.templateId === tid);
  if (!m) return;
  if (m.variantIds == null) m.variantIds = [...(allCases.value.find((c) => c.id === tid)?.variantVocab ?? [])];
  const i = m.variantIds.indexOf(vid);
  if (i >= 0) m.variantIds.splice(i, 1); else m.variantIds.push(vid);
  if (m.variantIds.length === 0) m.variantIds = null; // empty → back to all-default
}

async function saveEditor(): Promise<void> {
  if (!editorName.value.trim()) return;
  busy.value = true;
  err.value = null;
  try {
    const body = JSON.stringify({
      name: editorName.value,
      description: editorDesc.value,
      appBundleId: editorBundle.value || undefined,
      members: editorMembers.value,
    });
    const r = editing.value
      ? await fetch(`/api/suites/${editing.value.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body })
      : await fetch('/api/suites', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    if (!r.ok) {
      const b = (await r.json().catch(() => ({ error: 'save failed' }))) as { error?: string };
      err.value = b.error ?? `save failed (${r.status})`;
      return;
    }
    showEditor.value = false;
    await load();
    const saved = (await r.json()) as Suite;
    if (!editing.value && saved.id) await select(saved.id);
  } finally { busy.value = false; }
}

function vchipText(m: Member): { text: string; all: boolean } {
  const vocab = m.variantVocab ?? [];
  if (m.variantIds == null) {
    if (vocab.length === 0) return { text: 'plain', all: true };
    return { text: `all ${vocab.length} · ${vocab.join(' ')}`, all: true };
  }
  return { text: m.variantIds.join(' '), all: false };
}

load();
</script>

<template>
  <div class="page">
    <header class="ph">
      <h1>suites</h1>
      <p class="sub">named, ordered case groups — one app per suite, verdicts are live reads</p>
    </header>

    <div v-if="err" class="err">{{ err }}</div>

    <div class="layout">
      <nav class="side">
        <h2>suites <button class="new" @click="openEditor(null)">+ new</button></h2>
        <template v-for="g in railGroups" :key="g.bundle ?? 'none'">
          <div class="rail-group">{{ g.label }}</div>
          <button v-for="s in g.items" :key="s.id" class="sitem" :class="{ sel: s.id === selectedId }" @click="select(s.id)">
            <span class="nm">{{ s.name }} <span class="n">{{ s.memberCount ?? 0 }} cases</span></span>
            <span class="roll">
              <span v-for="(m, i) in (s.members ?? [])" :key="i" class="rollpart" :class="m.lastStatus === 'passed' ? 'ok' : m.lastStatus != null ? 'bad' : 'blk'">
                {{ m.lastStatus === 'passed' ? 'pass' : m.lastStatus != null ? 'fail' : 'never' }}
              </span>
            </span>
          </button>
        </template>
        <p v-if="suites.length === 0" class="empty">no suites yet — + new</p>
      </nav>

      <main v-if="detail" class="board">
        <div class="b-head">
          <h1>{{ detail.name }}</h1>
          <span v-if="detail.appBundleId" class="bbadge" :title="`every member runs ${detail.appBundleId}`">{{ detail.appBundleId }}</span>
          <span class="desc">{{ detail.description ?? '' }}</span>
          <button class="run" :disabled="running === detail.id" @click="run(detail.id)">{{ running === detail.id ? 'starting…' : '▶ run suite' }}</button>
          <button class="del" @click="remove(detail.id)">delete</button>
        </div>

        <div class="rollup">
          <span class="kpi" :class="{ bad: detailRollup.fail > 0 }">{{ detailRollup.fail > 0 ? `${detailRollup.fail} failing` : detailRollup.pass > 0 ? 'all passing' : 'no runs' }}</span>
          <span class="sub">of <b>{{ detail.members?.length ?? 0 }} cases</b> · <b>{{ detailRollup.pass }} passing</b> · <b>{{ detailRollup.never }} never run</b> · last run <b>{{ ago(detailRollup.lastAt) }}{{ detailRollup.lastRunId ? ` · ${detailRollup.lastRunId}` : '' }}</b></span>
        </div>

        <div v-for="(m, i) in detail.members ?? []" :key="m.templateId" class="mem" :class="{ drifted: detail.appBundleId != null && m.appBundleId != null && m.appBundleId !== detail.appBundleId }">
          <span class="pos">{{ i + 1 }}</span>
          <span class="verdict" :class="m.lastStatus === 'passed' ? 'ok' : m.lastStatus != null ? 'bad' : 'blk'">
            {{ m.lastStatus === 'passed' ? 'pass' : m.lastStatus === 'failed' ? 'fail' : m.lastStatus === 'aborted' ? 'abort' : m.lastStatus != null ? m.lastStatus : 'never' }}
          </span>
          <span class="name">{{ m.name ?? m.templateId }}<span v-if="m.appBundleId && detail.appBundleId == null" class="bundle"> · {{ m.appBundleId }}</span></span>
          <span class="vchips">
            <span class="vchip" :class="{ all: vchipText(m).all }">{{ vchipText(m).text }}</span>
            <span v-if="detail.appBundleId != null && m.appBundleId != null && m.appBundleId !== detail.appBundleId" class="drift-flag" title="this case's app was changed after joining — edit members to fix">drifted</span>
          </span>
        </div>

        <div class="foot">
          <button class="linkish" @click="openEditor(detail)">edit members →</button>
          <RouterLink class="linkish" :to="{ path: '/runs', query: { suite: detail.id } }">runs from this suite →</RouterLink>
          <span>verdicts are live reads — the same truth as every board</span>
        </div>
      </main>
      <main v-else class="board emptyboard">
        <p>select a suite, or <button class="linkish" @click="openEditor(null)">create one</button>.</p>
      </main>
    </div>

    <div v-if="showEditor" class="modal">
      <div class="m-card">
        <h3>{{ editing ? 'edit suite' : 'new suite' }}</h3>
        <label class="fld">name <input v-model="editorName" placeholder="intl regression"></label>
        <label class="fld">description <input v-model="editorDesc" placeholder="optional"></label>
        <label class="fld">
          app (scope{{ editing ? ' — locked' : '' }})
          <select v-model="editorBundle" :disabled="!!editing" @change="onBundleChange">
            <option value="" disabled>pick the app…</option>
            <option v-for="b in bundleOptions" :key="b" :value="b">{{ b }}</option>
          </select>
        </label>

        <div v-if="editorBundle" class="rows">
          <div v-for="(m, i) in editorRows" :key="m.templateId" class="mrow">
            <span class="pos">{{ i + 1 }}</span>
            <select class="case-sel" :value="m.templateId" @change="setMemberCase(i, ($event.target as HTMLSelectElement).value)">
              <option v-for="c in allCases.filter((x) => x.bundle === editorBundle)" :key="c.id" :value="c.id">{{ c.name }}</option>
            </select>
            <div class="vars">
              <button
                v-for="v in m.case?.variantVocab ?? []" :key="v"
                class="pv-v" :class="{ on: m.variantIds == null || m.variantIds.includes(v) }"
                :title="m.variantIds == null ? 'all variants (default)' : 'pinned subset'"
                @click="toggleVariant(m.templateId, v)"
              >{{ v }}</button>
              <span v-if="m.variantIds != null" class="pv-hint">pinned — all off → back to all</span>
            </div>
            <div class="ops">
              <button :disabled="i === 0" @click="moveMember(i, -1)" title="move up">↑</button>
              <button :disabled="i === editorRows.length - 1" @click="moveMember(i, 1)" title="move down">↓</button>
              <button @click="removeMember(i)" title="remove">✕</button>
            </div>
          </div>
          <button class="addrow" :disabled="scopedCases.length === 0" @click="addMember">+ add case</button>
          <p v-if="editorRows.length === 0" class="hint">no members yet — add the first case below</p>
        </div>
        <p v-else class="hint">pick the app first — a suite is one app's pack; only that app's cases are offered.</p>

        <div class="m-foot">
          <span v-if="err" class="err-i">{{ err }}</span>
          <button class="btn ghost" @click="showEditor = false">cancel</button>
          <button class="btn" :disabled="busy || !editorName.trim() || !editorBundle" @click="saveEditor">{{ busy ? 'saving…' : 'save' }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page { padding: 20px; }
.ph { margin-bottom: 14px; }
.ph h1 { font-size: 18px; font-weight: 700; }
.ph .sub { color: var(--color-ash); font-size: 12px; }
.err { border: 1px dashed var(--color-paper); color: var(--color-paper); padding: 8px 10px; margin-bottom: 12px; font-size: 12px; }
.layout { display: grid; grid-template-columns: 250px 1fr; gap: 14px; }

.side { border: 1px solid var(--color-iron); border-radius: var(--r); background: var(--color-carbon); padding: 10px; align-self: start; }
.side h2 { font-size: 12px; color: var(--color-ash); font-weight: 400; letter-spacing: .08em; text-transform: uppercase; padding: 2px 4px 8px; display: flex; justify-content: space-between; }
.side h2 .new { font: inherit; font-size: 11px; color: var(--color-ember); background: none; border: 1px solid var(--color-iron); border-radius: var(--r); padding: 1px 8px; cursor: pointer; }
.rail-group { font-size: 10px; color: var(--color-steel); letter-spacing: .06em; padding: 8px 4px 4px; border-top: 1px solid var(--color-iron); margin-top: 6px; }
.rail-group:first-of-type { border-top: none; margin-top: 0; }
.sitem { display: block; width: 100%; text-align: left; font: inherit; background: none; border: 1px solid transparent; border-left: 2px solid transparent; color: var(--color-fog); padding: 8px; margin-bottom: 4px; border-radius: var(--r); cursor: pointer; }
.sitem .nm { color: var(--color-paper); display: flex; justify-content: space-between; gap: 8px; }
.sitem .nm .n { color: var(--color-steel); font-size: 11px; }
.sitem .roll { font-size: 11px; margin-top: 3px; display: flex; flex-wrap: wrap; gap: 4px; }
.sitem:hover { background: var(--color-graphite); }
.sitem.sel { background: var(--color-graphite); border-left-color: var(--color-ember); }
.rollpart.ok { color: var(--color-fog); }
.rollpart.bad { color: var(--color-paper); }
.rollpart.blk { color: var(--color-ash); font-style: italic; }
.empty { color: var(--color-steel); font-size: 12px; padding: 8px; }

.board { border: 1px solid var(--color-iron); border-radius: var(--r); background: var(--color-carbon); padding: 14px; }
.b-head { display: flex; align-items: baseline; gap: 12px; border-bottom: 1px solid var(--color-iron); padding-bottom: 10px; margin-bottom: 12px; }
.b-head h1 { font-size: 18px; font-weight: 700; }
.b-head .desc { color: var(--color-ash); font-size: 12px; }
.bbadge { font-size: 10px; color: var(--color-fog); border: 1px solid var(--color-slate); border-radius: var(--r); padding: 2px 8px; white-space: nowrap; }
.b-head .run { margin-left: auto; font: inherit; font-size: 13px; color: var(--color-paper); background: var(--color-ember); border: none; border-radius: var(--r); padding: 6px 14px; cursor: pointer; }
.b-head .run:hover { background: var(--color-ember-dim); }
.b-head .del { font: inherit; font-size: 11px; color: var(--color-steel); background: none; border: 1px solid var(--color-iron); border-radius: var(--r); padding: 6px 10px; cursor: pointer; }
.b-head .del:hover { color: var(--color-paper); border-color: var(--color-slate); }

.rollup { display: flex; gap: 18px; align-items: baseline; padding: 0 2px 12px; }
.rollup .kpi { font-size: 24px; }
.rollup .kpi.bad { color: var(--color-paper); }
.rollup .sub { color: var(--color-ash); font-size: 12px; }
.rollup .sub b { color: var(--color-fog); font-weight: 400; }

.mem { display: flex; align-items: center; gap: 10px; padding: 9px 10px; border: 1px solid var(--color-iron); border-radius: var(--r); margin-bottom: 6px; background: var(--color-graphite); }
.mem:hover { border-color: var(--color-slate); }
.mem.drifted { border-style: dashed; border-color: var(--color-paper); }
.mem .pos { color: var(--color-steel); font-size: 11px; width: 20px; }
.mem .verdict { width: 64px; font-size: 11px; }
.mem .name { color: var(--color-paper); }
.mem .name .bundle { color: var(--color-steel); font-size: 11px; }
.verdict.ok { color: var(--color-fog); }
.verdict.bad { color: var(--color-paper); }
.verdict.blk { color: var(--color-ash); font-style: italic; }
.vchips { margin-left: auto; display: flex; gap: 4px; align-items: center; }
.vchip { font-size: 10px; color: var(--color-fog); border: 1px solid var(--color-slate); border-radius: var(--r); padding: 1px 6px; }
.vchip.all { color: var(--color-ash); border-style: dashed; }
.drift-flag { font-size: 10px; color: var(--color-paper); border: 1px dashed var(--color-paper); border-radius: var(--r); padding: 1px 6px; }

.foot { color: var(--color-steel); font-size: 11px; padding: 8px 2px 0; border-top: 1px solid var(--color-iron); margin-top: 10px; display: flex; gap: 14px; align-items: center; }
.linkish { font: inherit; font-size: 11px; color: var(--color-ash); background: none; border: none; padding: 0; cursor: pointer; text-decoration: none; border-bottom: 1px dotted var(--color-pewter); }
.linkish:hover { color: var(--color-fog); }
.emptyboard { color: var(--color-steel); font-size: 13px; }

.modal { position: fixed; inset: 0; background: rgb(0 0 0 / 70%); display: flex; align-items: center; justify-content: center; z-index: 50; }
.m-card { background: var(--color-carbon); border: 1px solid var(--color-iron); border-radius: var(--r); padding: 16px; width: min(680px, 92vw); max-height: 84vh; overflow: auto; }
.m-card h3 { font-size: 14px; margin-bottom: 12px; }
.fld { display: block; font-size: 12px; color: var(--color-ash); margin-bottom: 10px; }
.fld input, .fld select { display: block; width: 100%; margin-top: 4px; font: inherit; background: var(--color-void); color: var(--color-paper); border: 1px solid var(--color-iron); border-radius: var(--r); padding: 6px 8px; }
.fld select:disabled { opacity: .6; }
.hint { font-size: 11px; color: var(--color-steel); font-style: italic; margin: 6px 0; }

.rows { border-top: 1px solid var(--color-iron); padding-top: 10px; margin-bottom: 12px; }
.mrow { display: flex; align-items: center; gap: 8px; padding: 8px; border: 1px solid var(--color-iron); border-radius: var(--r); margin-bottom: 6px; background: var(--color-graphite); flex-wrap: wrap; }
.mrow .pos { color: var(--color-steel); font-size: 11px; width: 18px; }
.case-sel { font: inherit; font-size: 12px; background: var(--color-void); color: var(--color-paper); border: 1px solid var(--color-iron); border-radius: var(--r); padding: 5px 8px; min-width: 220px; }
.vars { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.pv-v { font: inherit; font-size: 10px; color: var(--color-steel); background: none; border: 1px dashed var(--color-slate); border-radius: var(--r); padding: 1px 8px; cursor: pointer; }
.pv-v.on { color: var(--color-paper); border-style: solid; }
.pv-hint { font-size: 10px; color: var(--color-steel); font-style: italic; }
.ops { margin-left: auto; display: flex; gap: 4px; }
.ops button { font: inherit; font-size: 11px; color: var(--color-ash); background: none; border: 1px solid var(--color-iron); border-radius: var(--r); padding: 2px 8px; cursor: pointer; }
.ops button:hover:not(:disabled) { color: var(--color-paper); border-color: var(--color-slate); }
.ops button:disabled { opacity: .35; cursor: default; }
.addrow { font: inherit; font-size: 12px; color: var(--color-ember); background: none; border: 1px dashed var(--color-iron); border-radius: var(--r); padding: 5px 12px; cursor: pointer; }
.addrow:hover:not(:disabled) { border-color: var(--color-ember); }
.addrow:disabled { opacity: .4; cursor: default; }

.m-foot { display: flex; justify-content: flex-end; gap: 8px; align-items: center; }
.m-foot .err-i { margin-right: auto; color: var(--color-paper); font-size: 11px; }
.btn { font: inherit; font-size: 12px; color: var(--color-paper); background: var(--color-ember); border: none; border-radius: var(--r); padding: 6px 14px; cursor: pointer; }
.btn:hover { background: var(--color-ember-dim); }
.btn.ghost { background: none; border: 1px solid var(--color-iron); color: var(--color-ash); }
.btn:disabled { opacity: .5; cursor: default; }
</style>
